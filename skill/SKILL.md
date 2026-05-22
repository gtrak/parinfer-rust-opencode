---
name: clojure-parinfer
description: MANDATORY workflow for editing Clojure, ClojureScript, EDN, Babashka, or any Lisp-family file (`.clj`, `.cljs`, `.cljc`, `.cljd`, `.edn`, `.bb`, `.fnl`). Required whenever you write, edit, or repair s-expression code, especially after a reader, kondo, or `clj-kondo` "Unmatched delimiter", "Unmatched bracket", or "EOF while reading" error. Use proactively before any edit to a Lisp file. Forbids manual paren counting, line-range deletes, and fix-on-top-of-broken edits. Pairs with the `clojure-structural-edit` opencode plugin which enforces these rules at tool-execution time.
---

# Editing Clojure / Lisp files safely

Lisp code is a tree of s-expressions. Editing it like prose — by line range,
by character offset, by counting parens — produces broken files faster than
you can debug them. This skill is the rulebook; the
`clojure-structural-edit` opencode plugin is the floor that enforces it.

## Hard prohibitions

- **Never count parens by hand.** No `tr -cd '('`, no `xxd | grep ')'`, no
  Python paren counters, no `awk` token tallies. If you find yourself
  reaching for these tools, stop and use parinfer instead.
- **Never edit Lisp files by line range.** No `sed '364,408d'`, no "delete
  lines X through Y", no removing arbitrary slices. Edit by **whole top-level
  form** (the entire `(defn …)`, `(def …)`, `(ns …)`, etc.).
- **Never trust the column number in a reader error as the location of the
  bug.** It is where parsing gave up, not where the defect is. The real bug
  is almost always upstream.
- **Never edit a file that doesn't currently parse.** Fix-on-top-of-broken
  guarantees you make it worse. Either run parinfer first, or
  `git checkout` and start over.
- **Never silently retry a failed structural edit.** Two attempts is the
  hard cap (matching the plugin's loop-breaker). After two, stop and ask
  the user.

## Mandatory pre-edit gate

Before editing any Lisp file:

1. Confirm it currently parses:
   ```
   clj-parse-check.sh PATH
   ```
   Exit 0 = clean. Non-zero = broken; do not proceed to edit.
2. If broken, choose ONE:
   - `git diff HEAD -- PATH` then `git checkout -- PATH` to reset, **or**
   - `clj-parinfer-fix.sh PATH` to let parinfer auto-balance, **then**
     re-run parse-check.
3. Capture the current state with `git diff HEAD -- PATH` so reverting is
   cheap if your edit goes wrong.

> The two helper scripts ship with this skill under `scripts/`. Either add
> that directory to `PATH`, or invoke the scripts via their absolute path.
> The opencode plugin discovers them automatically; humans running the
> rules from a shell need to wire them up once.

## Mandatory edit pipeline

For any edit to a Lisp file:

1. Prefer **whole-form replacement** over partial-form surgery. A whole
   `(defn foo …)` is far safer to replace than a hand-picked sub-expression.
2. After saving the edit, run parse-check. If it fails, run parinfer:
   ```
   clj-parinfer-fix.sh PATH
   ```
   then re-run parse-check.
3. Only after parse-check passes, proceed to kondo / tests / load.

The opencode plugin runs steps 2 automatically and reports back via the
tool output. Do not duplicate the work; do read the plugin's banners.

## Recovery: when a file is already broken

1. **Look at the diff first**, not the file. `git diff HEAD -- PATH`
   shows exactly what changed since the last good state.
2. **If the diff is small and wrong:** `git checkout -- PATH` and redo the
   edit as a single whole-top-level-form replacement.
3. **If the diff is large or unclear:** bisect by reader-discard. Wrap
   suspect top-level forms in `#_(defn …)` and re-run parse-check. The
   form whose `#_` makes the error disappear is the culprit. Bisecting by
   `#_` is the **only** sanctioned way to localise a structural defect.
4. **Never** bisect by paren counting.

## Loop-breaker rule

If two consecutive structural-edit attempts on the same file fail
parse-check (with or without parinfer auto-fix), **stop and ask the user**.
Do not make a third attempt.

The `clojure-structural-edit` plugin enforces this automatically: after
two consecutive failures it rejects further edits to the file for the
session, by reverting the file and emitting an `EDIT REJECTED
(loop-breaker)` banner. When you see that banner, do not try again.

## Reader-error triage cheat sheet

When you see one of these, follow the table:

| Error                                | First action                      |
|--------------------------------------|-----------------------------------|
| Unmatched delimiter: `)`             | run parinfer in `smart` mode      |
| Unmatched bracket: unexpected `)`    | run parinfer in `smart` mode      |
| EOF while reading                    | likely missing `)` or `"` — diff against HEAD |
| EOF while reading string             | unterminated string — visually scan for stray `"` |
| Invalid token                        | reader macro problem; do NOT run parinfer       |
| Unable to resolve symbol             | not structural — ignore for this skill          |

Parinfer fixes bracket structure, not strings or reader macros. If the
error is about strings or readers, fix it manually with a whole-form
replacement.

## Bundled scripts

- `scripts/clj-parse-check.sh PATH` — exit 0 if file reads cleanly via
  `read-string` with reader-conditionals enabled (uses babashka if present,
  Clojure CLI as fallback).
- `scripts/clj-parinfer-fix.sh PATH [smart|paren|indent]` — runs
  `parinfer-rust` on the file in place. Default mode is `smart`. Use
  `paren` if indentation is unreliable; use `indent` only on
  parinfer-managed files.

These are the only sanctioned commands for structural Clojure work. The
plugin invokes them on your behalf; you can also call them directly from
bash.

## Why this exists

Smaller and local LLMs have weak long-range bracket tracking in tokenized
text. They will lose at paren-counting every time, and the loss compounds:
each failed attempt adds another broken file state to the context, which
makes the next attempt more likely to fail too. Tooling — parinfer for
structure, `read-string` for verification, `git checkout` for recovery —
is the only stable path.
