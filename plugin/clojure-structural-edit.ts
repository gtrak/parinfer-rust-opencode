// clojure-structural-edit — opencode plugin
//
// Enforces structural integrity of Clojure / EDN / Lisp-family files
// across `write`, `edit`, and `hashedit` tool calls.
//
// Hook surface (opencode 1.4.x):
//   - tool.execute.before  : snapshot file content + record pre-edit health
//   - tool.execute.after   : parse-check the result; auto-fix with
//                            parinfer-rust; revert from snapshot if the
//                            agent's edit cannot be made to parse.
//
// The plugin observes; it cannot truly block a tool call. So instead of
// blocking, it lets the edit happen, then checks the result and either
// (a) accepts cleanly, (b) auto-fixes via parinfer-rust and warns, or
// (c) reverts the file and warns loudly. The warning text is appended to
// the tool's `output.output` so the agent sees it in-band.
//
// Loop-breaker: after N consecutive auto-fix-or-revert events on the same
// file in the same session, the plugin starts rejecting (via revert +
// warn) all further edits to that file until the user intervenes. This
// stops the "fix on top of broken" doom loop that smaller models fall
// into when bracket-counting Clojure code.

import type { Plugin } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Config

const CLOJURE_EXTENSIONS = new Set([
  ".clj", ".cljs", ".cljc", ".cljd", ".edn", ".bb", ".fnl",
])

const TARGET_TOOLS = new Set(["write", "edit", "hashedit"])

const PARINFER_MODE = "smart" as "smart" | "paren" | "indent"

// After this many consecutive auto-fix or revert events on the same file,
// further edits to that file are reverted unconditionally and the agent is
// told to stop and ask the user.
const MAX_CONSECUTIVE_FAILURES = 2

// Resolve bundled scripts. Tried in order:
//   1. PARINFER_OPENCODE_SCRIPTS env var (explicit override)
//   2. ../skill/scripts          (this repo's layout)
//   3. ./scripts                  (scripts colocated with the plugin file)
//   4. ../skills/clojure-parinfer/scripts (legacy layout)
//   5. ~/.config/opencode/skills/clojure-parinfer/scripts (user-installed)
// If none exist the plugin warns at load and becomes a no-op.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function findScriptsDir(): string {
  const home = process.env.HOME ?? ""
  const candidates = [
    process.env.PARINFER_OPENCODE_SCRIPTS,
    resolve(__dirname, "..", "skill", "scripts"),
    resolve(__dirname, "scripts"),
    resolve(__dirname, "..", "skills", "clojure-parinfer", "scripts"),
    home && resolve(home, ".config", "opencode", "skills", "clojure-parinfer", "scripts"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0)
  for (const c of candidates) {
    try {
      if (statSync(resolve(c, "clj-parse-check.sh")).isFile()) return c
    } catch { /* try next */ }
  }
  // Return the first non-env candidate so error messages are useful.
  return resolve(__dirname, "..", "skill", "scripts")
}

const SCRIPTS_DIR = findScriptsDir()
const PARSE_CHECK = resolve(SCRIPTS_DIR, "clj-parse-check.sh")
const PARINFER_FIX = resolve(SCRIPTS_DIR, "clj-parinfer-fix.sh")

// ---------------------------------------------------------------------------
// State

type Snapshot = {
  filePath: string
  existed: boolean
  prevContent: string | null
  prevWasHealthy: boolean
}

// Keyed by callID — opencode passes the same callID to before/after.
const snapshots = new Map<string, Snapshot>()

// Per-file failure counter, keyed by absolute path. Lives for the
// process lifetime (one opencode session).
const failureCounts = new Map<string, number>()

// ---------------------------------------------------------------------------
// Helpers

function isClojureFile(p: string): boolean {
  if (!p) return false
  const ext = extname(p).toLowerCase()
  return CLOJURE_EXTENSIONS.has(ext)
}

function extractFilePath(tool: string, args: any): string | null {
  if (!args || typeof args !== "object") return null
  // All three target tools use `filePath`.
  const fp = (args as { filePath?: unknown }).filePath
  if (typeof fp !== "string" || fp.length === 0) return null
  return isAbsolute(fp) ? fp : resolve(process.cwd(), fp)
}

function readSafe(path: string): string | null {
  try { return readFileSync(path, "utf8") } catch { return null }
}

function writeSafe(path: string, content: string): boolean {
  try { writeFileSync(path, content, "utf8"); return true } catch { return false }
}

function exists(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

function runScript(script: string, args: string[], timeoutMs = 8000):
  { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(script, args, { encoding: "utf8", timeout: timeoutMs })
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  }
}

function parseCheck(path: string): { ok: boolean; error: string } {
  const r = runScript(PARSE_CHECK, [path])
  return { ok: r.ok, error: r.stderr.trim() || r.stdout.trim() }
}

function parinferFix(path: string): { ok: boolean; error: string } {
  const r = runScript(PARINFER_FIX, [path, PARINFER_MODE])
  return { ok: r.ok, error: r.stderr.trim() || r.stdout.trim() }
}

function bumpFailure(path: string): number {
  const n = (failureCounts.get(path) ?? 0) + 1
  failureCounts.set(path, n)
  return n
}

function resetFailure(path: string): void {
  failureCounts.delete(path)
}

function banner(title: string, body: string): string {
  const bar = "=".repeat(72)
  return `\n${bar}\n[clojure-structural-edit] ${title}\n${bar}\n${body}\n${bar}\n`
}

// ---------------------------------------------------------------------------
// Plugin

export default (async () => {
  // Verify scripts exist at load time and warn loudly if not.
  if (!exists(PARSE_CHECK) || !exists(PARINFER_FIX)) {
    console.warn(
      `[clojure-structural-edit] missing helper scripts under ${SCRIPTS_DIR}; ` +
      `plugin will be a no-op. Expected:\n  ${PARSE_CHECK}\n  ${PARINFER_FIX}`,
    )
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!TARGET_TOOLS.has(input.tool)) return
      const filePath = extractFilePath(input.tool, output.args)
      if (!filePath || !isClojureFile(filePath)) return

      const existed = exists(filePath)
      const prevContent = existed ? readSafe(filePath) : null
      const prevWasHealthy =
        existed && prevContent !== null
          ? parseCheck(filePath).ok
          : true // new files are trivially healthy

      snapshots.set(input.callID, {
        filePath,
        existed,
        prevContent,
        prevWasHealthy,
      })
    },

    "tool.execute.after": async (input, output) => {
      if (!TARGET_TOOLS.has(input.tool)) return
      const snap = snapshots.get(input.callID)
      if (!snap) return
      snapshots.delete(input.callID)

      const { filePath, existed, prevContent, prevWasHealthy } = snap

      // If the edit deleted the file, nothing structural to do.
      if (!exists(filePath)) return

      // Parse-check the result of the edit FIRST. If it parses, accept
      // and reset the failure counter — even if this file was previously
      // at the threshold. A successful edit unlocks the file.
      const post = parseCheck(filePath)

      if (post.ok) {
        if (!prevWasHealthy) {
          output.output = (output.output ?? "") + banner(
            "PRE-EXISTING BREAKAGE FIXED",
            `${filePath} was malformed before this edit and now parses cleanly. Good.`,
          )
        }
        resetFailure(filePath)
        return
      }

      // Edit produced unparseable output. Apply loop-breaker BEFORE
      // attempting parinfer if this file has already hit the threshold:
      // we don't want to keep auto-fixing on a clearly stuck file.
      const priorFailures = failureCounts.get(filePath) ?? 0
      if (priorFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (existed && prevContent !== null) writeSafe(filePath, prevContent)
        const msg =
          `Edits to ${filePath} have failed ${priorFailures} consecutive ` +
          `times and this edit also failed to parse. Plugin is rejecting ` +
          `further edits to this file for this session.\n\n` +
          `STOP. Do not retry. Ask the user how to proceed.\n` +
          `Suggested user actions:\n` +
          `  1. git diff HEAD -- "${filePath}" — see what changed\n` +
          `  2. git checkout -- "${filePath}" — reset to last committed\n` +
          `  3. parinfer-rust --mode paren < "${filePath}" — manual fix`
        output.output = (output.output ?? "") + banner("EDIT REJECTED (loop-breaker)", msg)
        return
      }

      // Edit produced unparseable output. Try parinfer auto-fix.
      const fix = parinferFix(filePath)
      if (fix.ok) {
        const recheck = parseCheck(filePath)
        if (recheck.ok) {
          const failures = bumpFailure(filePath)
          const msg =
            `Your edit to ${filePath} produced an unparseable file. ` +
            `parinfer-rust (${PARINFER_MODE} mode) corrected the structure ` +
            `automatically.\n\n` +
            `Reader error before fix:\n${post.error || "(no detail)"}\n\n` +
            `REVIEW THE DIFF. Parinfer's correction may not match your ` +
            `intent. Run \`git diff -- "${filePath}"\` and verify.\n\n` +
            `Consecutive structural failures on this file: ${failures}/${MAX_CONSECUTIVE_FAILURES}. ` +
            `One more and edits will be rejected.`
          output.output = (output.output ?? "") + banner("AUTO-FIXED via parinfer-rust", msg)
          return
        }
      }

      // Parinfer couldn't fix it (or its result still fails verification).
      // Revert and emit a banner that distinguishes the two cases, since they
      // mean very different things:
      //   - !fix.ok           : parinfer hit a hard problem (e.g. unterminated
      //                          string, reader-macro error). Real structural bug.
      //   - fix.ok && !recheck.ok : parinfer accepted the file but the verifier
      //                          still rejects. Either the verifier is buggy or
      //                          the file has issues outside parinfer's scope.
      let reverted = false
      if (existed && prevContent !== null) {
        reverted = writeSafe(filePath, prevContent)
      } else if (!existed) {
        try {
          unlinkSync(filePath)
          reverted = true
        } catch { reverted = false }
      }

      const failures = bumpFailure(filePath)
      const verifierDisagrees = fix.ok
      const bannerTitle = verifierDisagrees
        ? "EDIT REVERTED (verifier rejected parinfer's result)"
        : "EDIT REVERTED"
      const parinferDetail = verifierDisagrees
        ? `parinfer-rust modified the file successfully, but the parse-check ` +
          `re-verifier still rejects it. This may indicate a verifier ` +
          `false-negative — inspect the file manually.`
        : `parinfer-rust failed: ${fix.error || "(no detail)"}`

      const msg =
        `Your edit to ${filePath} produced an unparseable file ` +
        (verifierDisagrees
          ? `and parinfer-rust's repair was rejected by the verifier.\n\n`
          : `and parinfer-rust could not repair it.\n\n`) +
        `Reader error:\n${post.error || "(no detail)"}\n\n` +
        `${parinferDetail}\n\n` +
        (reverted
          ? `The file has been REVERTED to its pre-edit state.`
          : `WARNING: revert FAILED. The file is in a broken state on disk.`) +
        `\n\nDo NOT retry the same edit. Required next steps:\n` +
        `  1. Read the file — confirm what is actually there now\n` +
        `  2. If the structural change is large, replace the WHOLE top-level form, not a slice\n` +
        `  3. After editing, this plugin will re-check; do not paren-count by hand\n\n` +
        `Consecutive structural failures on this file: ${failures}/${MAX_CONSECUTIVE_FAILURES}. ` +
        (failures >= MAX_CONSECUTIVE_FAILURES
          ? `Threshold reached — further edits will be rejected.`
          : `One more and edits will be rejected.`)

      output.output = (output.output ?? "") + banner(bannerTitle, msg)
    },
  }
}) satisfies Plugin
