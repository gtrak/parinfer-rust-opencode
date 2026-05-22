---
name: clojure-parinfer
description: MANDATORY workflow for editing Clojure, ClojureScript, EDN, Babashka, or any Lisp-family file (`.clj`, `.cljs`, `.cljc`, `.cljd`, `.edn`, `.bb`, `.fnl`). Required whenever you write, edit, or repair s-expression code, especially after a reader, kondo, or `clj-kondo` "Unmatched delimiter", "Unmatched bracket", or "EOF while reading" error. Use proactively before any edit to a Lisp file. Forbids manual paren counting, line-range deletes, and fix-on-top-of-broken edits. Pairs with the `clojure-structural-edit` opencode plugin which enforces these rules at tool-execution time.
---

# Editing Clojure / Lisp files safely

Lisp code is a tree of s-expressions. Editing it like prose — by line range,
by character offset, by counting parens — produces broken files faster than
you can debug them.

The companion `clojure-structural-edit` plugin runs structural verification
on every `write`, `edit`, and `hashedit` against `.clj`, `.cljs`, `.cljc`,
`.cljd`, `.edn`, `.bb`, and `.fnl` files. **You do not need to invoke the
parse-check or parinfer scripts yourself during normal edits — the plugin
already does.** Read its banners and obey them.

This skill is the rulebook the agent follows. The plugin is the floor that
catches violations.

## What the plugin does on your behalf

After every edit the plugin parse-checks the result. Possible outcomes:

| Banner                                          | What happened                                       | What you do                                         |
|-------------------------------------------------|-----------------------------------------------------|-----------------------------------------------------|
| (silent)                                        | Edit produced a clean parse. Nothing to do.         | Continue.                                           |
| `AUTO-FIXED via parinfer-rust`                  | Edit was structurally broken; parinfer repaired it. | Run `git diff` and confirm parinfer's repair matches your intent. |
| `EDIT REVERTED`                                 | Parinfer could not repair the edit (e.g. unterminated string, reader-macro error). File rolled back to pre-edit state. | Read the file. Replace the whole top-level form. Do **not** retry the same edit. |
| `EDIT REVERTED (verifier rejected parinfer's result)` | Parinfer succeeded but the verifier still rejects. Likely a verifier false-negative or content outside parinfer's scope. | Inspect the file manually. Bisect with `#_` (see Recovery). |
| `EDIT REJECTED (loop-breaker)`                  | Two consecutive failures on this file. Plugin is now refusing further edits to it for the session. | **Stop. Ask the user.** Do not retry. |
| `PRE-EXISTING BREAKAGE FIXED`                   | The file was malformed before your edit and now parses. | Continue. |

The plugin maintains a per-file failure counter. A successful edit resets
it; the third consecutive failure on the same file engages the loop-breaker.

## Hard prohibitions

These apply to your behavior; the plugin enforces some of them but not all.

- **Never count parens by hand.** No `tr -cd '('`, no `xxd | grep ')'`, no
  Python paren counters, no `awk` token tallies. If you find yourself
  reaching for those tools, stop. The plugin already verified the file —
  trust its banner.
- **Never edit Lisp files by line range.** No `sed '364,408d'`, no "delete
  lines X through Y", no removing arbitrary slices. Edit by **whole top-level
  form** (the entire `(defn …)`, `(def …)`, `(ns …)`, etc.). A whole-form
  replacement is structurally safe; a sub-form slice almost never is.
- **Never trust the column number in a reader error as the location of the
  bug.** It is where parsing gave up, not where the defect is. The real bug
  is almost always upstream — usually a missing or extra delimiter several
  forms earlier.
- **Never edit a file the plugin says is broken.** Fix-on-top-of-broken
  makes things worse. If the plugin reverted your last edit, do not try a
  variation of the same edit; investigate first.
- **Never silently retry a failed structural edit.** The plugin will
  reject the third attempt anyway; do the user the courtesy of stopping
  at one and asking what they meant.

## Edit pipeline

For any edit to a Lisp file:

1. **Prefer whole-form replacement** over partial-form surgery. Replace
   the entire `(defn foo …)`, not a hand-picked sub-expression.
2. Save the edit through the normal `write` / `edit` / `hashedit` tools.
3. **Read the plugin's banner** (or its absence) in the tool output.
   - Silent: continue.
   - `AUTO-FIXED`: run `git diff` to confirm parinfer's correction matches
     intent before continuing.
   - Any other banner: stop and follow the recovery flow below.

Do not run the parse-check or parinfer scripts manually as part of this
pipeline. The plugin already does both. Re-running them is wasted work.

## Recovery: when an edit was reverted

The manual scripts and `#_` bisection live here. You only reach this flow
when the plugin has emitted `EDIT REVERTED`, `EDIT REVERTED (verifier …)`,
or `EDIT REJECTED (loop-breaker)`.

1. **Look at the diff first**, not the file:
   ```
   git diff HEAD -- PATH
   ```
   This shows what changed since the last good state.
2. **If the diff is small and obviously wrong**, reset and redo as a single
   whole-form replacement:
   ```
   git checkout -- PATH
   ```
   Then re-attempt the edit as a complete top-level form.
3. **If the diff is large or unclear**, bisect by reader-discard. Wrap
   suspect top-level forms in `#_(defn …)` and re-save. The plugin will
   re-verify; the form whose `#_` makes the file parse is the culprit.
   `#_`-bisection is the **only** sanctioned way to localise a structural
   defect. Never bisect by paren counting.
4. **If you saw `EDIT REVERTED (verifier rejected parinfer's result)`**,
   inspect the file directly — parinfer thinks it's fine, the verifier
   disagrees. The most common cause is content outside parinfer's scope
   (mismatched strings, reader macros). Run the manual scripts to triage:
   ```
   clj-parse-check.sh PATH    # what does the verifier complain about?
   clj-parinfer-fix.sh PATH   # rerun parinfer manually if you want
   ```
   Both scripts ship with this skill under `scripts/`.
5. **If you saw `EDIT REJECTED (loop-breaker)`**, stop. Ask the user.
   The file has failed enough times that further automated attempts are
   counterproductive.

## Reader-error triage cheat sheet

If you do see a reader error directly (e.g. from kondo, or from running
code outside the plugin's coverage):

| Error                                | First action                                      |
|--------------------------------------|---------------------------------------------------|
| Unmatched delimiter: `)`             | Edit through the plugin — let parinfer try        |
| Unmatched bracket: unexpected `)`    | Edit through the plugin — let parinfer try        |
| EOF while reading                    | Likely missing `)` or `"` — `git diff HEAD --`    |
| EOF while reading string             | Unterminated string — scan for stray `"`          |
| Invalid token                        | Reader macro problem; parinfer **cannot** help    |
| Unable to resolve symbol             | Not structural — ignore for this skill            |
| Alias `…` not found in `:auto-resolve` | Not your file's problem — it's a parser config issue. The plugin's verifier handles this correctly via rewrite-clj. |

## Bundled scripts (for manual recovery only)

- `scripts/clj-parse-check.sh PATH` — exit 0 if the file parses cleanly.
  Uses `rewrite-clj.parser/parse-string-all` (no symbol or alias
  resolution). Falls back to `clojure` CLI with `tools.reader` if
  babashka is unavailable.
- `scripts/clj-parinfer-fix.sh PATH [smart|paren|indent]` — runs
  `parinfer-rust` on the file in place. Default mode is `smart`.

The plugin invokes both of these automatically. Use them yourself only
during recovery (step 4 above) when you need to triage a verifier
disagreement directly.

## Why this exists

Smaller and local LLMs have weak long-range bracket tracking in tokenized
text. They lose at paren-counting every time, and the loss compounds: each
failed attempt adds another broken file state to the context, which makes
the next attempt more likely to fail too.

Taking the structural problem out of the model's hands is the only stable
path. Parinfer balances brackets correctly. rewrite-clj verifies parse
trees correctly. The plugin wires both into the tool pipeline so a broken
file cannot survive a round-trip. The skill is just the model-facing
explanation of what the plugin is doing and how to react to it.
