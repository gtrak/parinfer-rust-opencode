---
name: clojure-parinfer
description: MANDATORY workflow for editing Clojure, ClojureScript, EDN, Babashka, or any Lisp-family file (`.clj`, `.cljs`, `.cljc`, `.cljd`, `.edn`, `.bb`, `.fnl`). Required whenever you write, edit, or repair s-expression code, especially after a reader, kondo, or `clj-kondo` "Unmatched delimiter", "Unmatched bracket", or "EOF while reading" error. Use proactively before any edit to a Lisp file. Forbids manual paren counting, line-range deletes, and fix-on-top-of-broken edits. Pairs with the `parinfer` opencode plugin which enforces these rules at tool-execution time.
---

# Editing Clojure / Lisp files safely

Lisp code is a tree of s-expressions. Editing it like prose — by line range,
by character offset, by counting parens — produces broken files faster than
you can debug them.

The companion `parinfer` plugin runs structural verification on every
`write`, `edit`, and `hashedit` against `.clj`, `.cljs`, `.cljc`, `.cljd`,
`.edn`, `.bb`, and `.fnl` files. **You do not need to invoke parinfer
yourself during normal edits — the plugin already does.** Read its banners
and obey them.

This skill is the rulebook the agent follows. The plugin is the floor that
catches violations.

## What the plugin does on your behalf

After every edit the plugin runs the result through `parinfer-rust` in
**paren mode**. Paren mode treats brackets as authoritative — it never
adds, removes, or moves brackets. It only adjusts indentation to match
the bracket structure. There are exactly five outcomes:

| Banner                                          | What happened                                       | What you do                                         |
|-------------------------------------------------|-----------------------------------------------------|-----------------------------------------------------|
| (silent)                                        | Brackets are balanced and indentation matches structure. | Continue.                                           |
| `INDENTATION ADJUSTED`                          | Brackets are balanced but indentation didn't match structure. Paren mode corrected the indentation on disk. | Run `git diff` to verify the bracket structure matches your intent. If brackets are wrong, see repair flow below. |
| `EDIT REVERTED`                                 | Parinfer reported a structural error it cannot process (unterminated string, unclosed paren, malformed reader macro, etc.). File rolled back to pre-edit state. | Call `parinfer-indent-mode` then retry the edit. See recovery flow below. |
| `INDENT MODE APPLIED`                           | You armed indent mode and the plugin inferred brackets from your indentation. | Run `git diff` to verify the result. If a sub-form has wrong nesting, fix its indentation and re-edit that sub-form. |
| `PRE-EXISTING BREAKAGE FIXED`                   | The file had a structural error before your edit, and your edit cleared it. | Continue. |

## Writing new forms

When adding a new top-level form — especially one longer than ~10 lines
(a `deftest`, `defn`, `let` block, etc.) — LLMs are likely to produce
unbalanced brackets. **Do not attempt to write large forms with perfect
bracket balance.** Instead, use indent mode:

1. **Call `parinfer-indent-mode`** (no arguments needed). This arms indent
   mode for the very next Clojure file edit.
2. **Write the form** using any edit tool (`write`, `edit`, `hashedit`).
   Focus on correct **indentation** — closing brackets don't need to be
   perfect. Indent mode trusts indentation absolutely and will infer the
   correct brackets.
3. The plugin will run indent mode, then verify with paren mode. You'll
   see an `INDENT MODE APPLIED` banner on success.
4. **Run `git diff`** to verify the result matches your intent.
5. If a sub-form has wrong nesting, fix its indentation and re-edit that
   sub-form normally (paren mode will verify as usual).

This is the **primary authoring strategy** for new forms. It is also the
**recovery path** after an `EDIT REVERTED` banner — call
`parinfer-indent-mode`, then retry the same edit.

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
  variation of the same edit; call `parinfer-indent-mode` and retry.
- **Never silently retry a failed structural edit.** If the plugin reverted
  your last edit, call `parinfer-indent-mode` first, then retry.

## Edit pipeline

For any edit to a Lisp file:

1. **For new forms or large changes**: call `parinfer-indent-mode` first,
   then write with correct indentation. See "Writing new forms" above.
2. **For small edits to existing forms**: prefer whole-form replacement
   over partial-form surgery. Replace the entire `(defn foo …)`, not a
   hand-picked sub-expression.
3. Save the edit through the normal `write` / `edit` / `hashedit` tools.
4. **Read the plugin's banner** (or its absence) in the tool output.
   - Silent: continue.
   - `INDENT MODE APPLIED`: run `git diff` to verify the result.
   - `INDENTATION ADJUSTED`: run `git diff` to verify the bracket
     structure matches your intent. If brackets are in the wrong place,
     follow the repair flow below.
   - `EDIT REVERTED`: call `parinfer-indent-mode` and retry.

Do not run the recovery scripts as part of this normal pipeline. The plugin
already invokes parinfer once per edit; running it again by hand is wasted
work.

## Repair: when brackets don't match intent

You reach this flow when either:
- The plugin emitted `INDENTATION ADJUSTED` and `git diff` shows brackets
  are in the wrong place, OR
- You realize after the fact that nesting is wrong.

The repair strategy is **indent mode** — it infers correct brackets from
indentation. To use it:

1. Edit the file so that the **indentation** expresses your intended
   nesting. Get the indentation right; don't worry about brackets.
2. Run the repair script:
   ```
   clj-parinfer-fix.sh PATH indent
   ```
   This rewrites brackets to match the indentation.
3. Verify with `git diff` that the result is correct.

Indent mode is powerful but requires correct indentation as input. If your
indentation is wrong, indent mode will infer wrong brackets. Always fix
indentation first, then run indent mode.

## Recovery: when an edit was reverted

You only reach this flow when the plugin has emitted `EDIT REVERTED`.

1. **Call `parinfer-indent-mode`** to arm indent mode.
2. **Retry the same edit.** The plugin will run indent mode to infer
   brackets from your indentation instead of rejecting the file.
3. **Run `git diff`** to verify the result.
4. If the result is wrong, fix the **indentation** of the affected
   sub-form and re-edit it normally.

If indent mode itself fails (e.g. unterminated string literal), the error
is not a bracket-balance issue — it's a malformed string or reader macro.
Fix it by hand in the content you're writing.

Fallback steps (only if the above doesn't work):

5. **If the diff is large or unclear**, bisect by reader-discard. Wrap
   suspect top-level forms in `#_(defn …)` and re-save. The plugin will
   re-verify; the form whose `#_` makes the file parse is the culprit.
   `#_`-bisection is the **only** sanctioned way to localise a structural
   defect. Never bisect by paren counting.
6. **If parinfer's error message points at a string or reader macro**
   (`unclosed-quote`, malformed `#?(...)`, etc.), parinfer cannot help.
   The bug is almost always a stray `"` or a typo in a reader form. Fix
   it manually with a whole-form replacement.

## Reader-error triage cheat sheet

If you do see a reader error directly (e.g. from kondo, or from running
code outside the plugin's coverage):

| Error                                | First action                                          |
|--------------------------------------|-------------------------------------------------------|
| Unmatched delimiter: `)`             | Edit through the plugin — paren mode will catch it    |
| Unmatched bracket: unexpected `)`    | Edit through the plugin — paren mode will catch it    |
| EOF while reading                    | Likely missing `)` or `"` — call `parinfer-indent-mode` + retry |
| EOF while reading string             | Unterminated string — scan for stray `"`              |
| `unclosed-quote` (parinfer)          | Unterminated string — fix manually                    |
| `unclosed-paren` (parinfer)          | Call `parinfer-indent-mode` + retry                   |
| Invalid token                        | Reader macro problem; parinfer **cannot** help        |
| Unable to resolve symbol             | Not structural — ignore for this skill                |

## Bundled scripts (for manual recovery only)

- `scripts/clj-parse-check.sh PATH` — exit 0 if `parinfer-rust` (paren
  mode) accepts the file as structurally balanced. Useful when you want to
  triage a file outside an opencode session.
- `scripts/clj-parinfer-fix.sh PATH [smart|paren|indent]` — runs
  `parinfer-rust` on the file in place. Use `indent` mode to infer
  brackets from indentation (the recommended repair strategy).

The plugin already runs paren mode inside opencode. Reach for these scripts
only when triaging from a regular shell or when performing indent-mode
repair.

## Why this exists

Smaller and local LLMs have weak long-range bracket tracking in tokenized
text. They lose at paren-counting every time, and the loss compounds: each
failed attempt adds another broken file state to the context, which makes
the next attempt more likely to fail too.

Taking the structural problem out of the model's hands is the only stable
path. Parinfer's paren mode validates bracket structure without ever
silently rewriting brackets. When brackets are wrong, indent mode lets the
agent express intent through indentation and have brackets inferred
correctly. The `parinfer-indent-mode` tool lets the agent proactively opt
into indent mode before writing new forms, avoiding the revert-retry cycle
entirely. The plugin wires paren-mode validation into the tool pipeline so
a broken file cannot survive a round-trip. The skill is just the
model-facing explanation of what the plugin is doing and how to react to it.
