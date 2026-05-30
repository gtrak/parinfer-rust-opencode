// clojure-structural-edit — opencode plugin
//
// Enforces structural integrity of Clojure / EDN / Lisp-family files
// across `write`, `edit`, and `hashedit` tool calls.
//
// Single dependency: `parinfer-rust` on PATH.
//
// `parinfer-rust` does double duty here:
//   - Fixer:    if the input has fixable bracket imbalance, parinfer's
//               output is the corrected text.
//   - Verifier: parinfer's parser is a Clojure-aware s-expression parser.
//               If `success: false`, the file has a real structural
//               problem (unterminated string, reader-macro error, etc.)
//               that parinfer cannot rebalance.
//
// Hook surface (opencode 1.4.x):
//   - tool.execute.before  : snapshot pre-edit content + health
//   - tool.execute.after   : analyse the post-edit content via parinfer;
//                            silently accept, auto-fix and warn, or revert
//                            from snapshot and warn loudly.
//
// The plugin observes; opencode 1.4 cannot truly block a tool call. The
// edit hits disk, then the plugin reacts. Banners are appended to the
// tool's `output.output` so the agent sees them in-band.
//
import type { Plugin } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs"
import { extname, isAbsolute, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Config

const CLOJURE_EXTENSIONS = new Set([
  ".clj", ".cljs", ".cljc", ".cljd", ".edn", ".bb", ".fnl",
])

const TARGET_TOOLS = new Set(["write", "edit", "hashedit"])

// "smart" rebalances by indentation hints when present, falls back to
// paren-mode reasoning otherwise. "paren" is more conservative but
// loses indentation guidance. "indent" only works on already-managed files.
const PARINFER_MODE: "smart" | "paren" | "indent" = "smart"

// Path to the parinfer-rust binary. Override with PARINFER_RUST_BIN env var.
const PARINFER_BIN = process.env.PARINFER_RUST_BIN ?? "parinfer-rust"

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

// ---------------------------------------------------------------------------
// Helpers

function isClojureFile(p: string): boolean {
  if (!p) return false
  return CLOJURE_EXTENSIONS.has(extname(p).toLowerCase())
}

function extractFilePath(_tool: string, args: any): string | null {
  if (!args || typeof args !== "object") return null
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

function banner(title: string, body: string): string {
  const bar = "=".repeat(72)
  return `\n${bar}\n[clojure-structural-edit] ${title}\n${bar}\n${body}\n${bar}\n`
}

// ---------------------------------------------------------------------------
// parinfer-rust JSON IO
//
// Two-phase analysis: check mode verifies structural balance without
// rewriting. Only genuinely unbalanced files are sent through smart
// mode for repair. This prevents unnecessary rewrites of balanced
// code (which caused the cond-> corruption bug).

type ParinferResult =
  | { kind: "clean" }                          // structurally valid (check passed; no rewrite)
  | { kind: "fixed"; corrected: string }       // check failed; smart mode rebalanced it
  | { kind: "unfixable"; error: string }       // input has an error parinfer cannot repair

type ParinferRawResult = {
  text: string
  success: boolean
  error: null | {
    name: string
    message: string
    lineNo?: number
    x?: number
  }
}

function parinferCheck(input: string): { success: boolean; error?: string } {
  const payload = JSON.stringify({
    text: input,
    mode: "check",
    options: {},
  })

  const r = spawnSync(
    PARINFER_BIN,
    ["--input-format=json", "--output-format=json"],
    { input: payload, encoding: "utf8", timeout: 8000 },
  )

  if (r.error || r.status !== 0) {
    const detail = (r.stderr ?? "").toString().trim() ||
      (r.error?.message ?? "parinfer-rust exited non-zero")
    return { success: false, error: `parinfer-rust invocation failed: ${detail}` }
  }

  let parsed: ParinferRawResult
  try {
    parsed = JSON.parse(r.stdout)
  } catch (e) {
    return {
      success: false,
      error: `parinfer-rust returned non-JSON output: ${(e as Error).message}`,
    }
  }

  return { success: parsed.success }
}

function parinferAnalyze(input: string): ParinferResult {
  // Phase 1: Check if structurally valid (no rewrites needed)
  const check = parinferCheck(input)
  if (check.success) {
    return { kind: "clean" }
  }

  // Phase 2: File is unbalanced — run smart mode to repair
  const payload = JSON.stringify({
    text: input,
    mode: PARINFER_MODE,
    options: {},
  })

  const r = spawnSync(
    PARINFER_BIN,
    ["--input-format=json", "--output-format=json"],
    { input: payload, encoding: "utf8", timeout: 8000 },
  )

  if (r.error || r.status !== 0) {
    // parinfer-rust missing, crashed, or refused the input. Treat as
    // unfixable so the plugin reverts; surface stderr for debugging.
    const detail = (r.stderr ?? "").toString().trim() ||
      (r.error?.message ?? "parinfer-rust exited non-zero")
    return { kind: "unfixable", error: `parinfer-rust invocation failed: ${detail}` }
  }

  let parsed: ParinferRawResult
  try {
    parsed = JSON.parse(r.stdout)
  } catch (e) {
    return {
      kind: "unfixable",
      error: `parinfer-rust returned non-JSON output: ${(e as Error).message}`,
    }
  }

  if (!parsed.success) {
    const err = parsed.error
    const loc = err && typeof err.lineNo === "number"
      ? ` [line ${err.lineNo + 1}, col ${(err.x ?? 0) + 1}]`
      : ""
    const msg = err ? `${err.name}: ${err.message}${loc}` : "(no detail)"
    return { kind: "unfixable", error: msg }
  }

  return parsed.text === input
    ? { kind: "clean" }
    : { kind: "fixed", corrected: parsed.text }
}

// ---------------------------------------------------------------------------
// Plugin

export default (async () => {
  // Probe parinfer-rust at load time and warn loudly if missing. We don't
  // disable the plugin — a clear runtime banner is more useful than silent
  // no-op behavior, since the agent will read the banner and react.
  const probe = spawnSync(PARINFER_BIN, ["--help"], { timeout: 4000 })
  if (probe.error || probe.status !== 0) {
    console.warn(
      `[clojure-structural-edit] cannot find parinfer-rust binary "${PARINFER_BIN}". ` +
      `Install with \`cargo install parinfer-rust\` or set PARINFER_RUST_BIN. ` +
      `Until then every Clojure edit will be reverted with a "parinfer-rust ` +
      `invocation failed" banner.`,
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
          ? parinferAnalyze(prevContent).kind !== "unfixable"
          : true

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

      // The edit may have deleted the file; nothing structural to do.
      if (!exists(filePath)) return

      const current = readSafe(filePath)
      if (current === null) return

      const result = parinferAnalyze(current)

      // ----- Case 1: clean parse, file is balanced. ---------------------
      if (result.kind === "clean") {
        if (!prevWasHealthy) {
          output.output = (output.output ?? "") + banner(
            "PRE-EXISTING BREAKAGE FIXED",
            `${filePath} was malformed before this edit and now parses cleanly. Good.`,
          )
        }
        return
      }

      // ----- Case 2: parinfer rebalanced. Write the corrected text. ----
      if (result.kind === "fixed") {
        const wrote = writeSafe(filePath, result.corrected)
        if (!wrote) {
          // Couldn't write the correction; treat as unfixable.
          handleUnfixable(filePath, existed, prevContent, output,
            `parinfer corrected the file but the corrected content could not be written to disk`)
          return
        }
        const msg =
          `Your edit to ${filePath} produced an unbalanced file. ` +
          `parinfer-rust (${PARINFER_MODE} mode) rebalanced it automatically.\n\n` +
          `REVIEW THE DIFF. Parinfer's correction may not match your intent. ` +
          `Run \`git diff -- "${filePath}"\` and verify.`
        output.output = (output.output ?? "") + banner("AUTO-FIXED via parinfer-rust", msg)
        return
      }

      // ----- Case 3: parinfer reports a structural error it can't fix. -
      handleUnfixable(filePath, existed, prevContent, output, result.error)
    },
  }
}) satisfies Plugin

// ---------------------------------------------------------------------------
// Banner helpers

function revertSafely(filePath: string, existed: boolean, prevContent: string | null): boolean {
  if (existed && prevContent !== null) return writeSafe(filePath, prevContent)
  if (!existed) {
    try { unlinkSync(filePath); return true } catch { return false }
  }
  return false
}

function handleUnfixable(
  filePath: string,
  existed: boolean,
  prevContent: string | null,
  output: { output: string },
  parinferError: string,
): void {
  const reverted = revertSafely(filePath, existed, prevContent)

  const msg =
    `Your edit to ${filePath} produced an unparseable file and ` +
    `parinfer-rust could not repair it.\n\n` +
    `Parser error: ${parinferError}\n\n` +
    (reverted
      ? `The file has been REVERTED to its pre-edit state.`
      : `WARNING: revert FAILED. The file is in a broken state on disk.`) +
    `\n\nDo NOT retry the same edit. Required next steps:\n` +
    `  1. Read the file — confirm what is actually there now\n` +
    `  2. If the structural change is large, replace the WHOLE top-level form, not a slice\n` +
    `  3. Errors like "unclosed-quote" or "unmatched-close-paren" inside ` +
       `strings or reader macros are NOT bracket-balance issues — fix them by hand`
  output.output = (output.output ?? "") + banner("EDIT REVERTED", msg)
}
