# parinfer-rust-opencode

An [opencode](https://opencode.ai) plugin and skill that enforces structural
integrity of Clojure, ClojureScript, EDN, Babashka, and Lisp-family files —
so AI agents can't paren-count their way into broken s-expressions.

LLMs are bad at long-range bracket tracking in tokenized text. The smaller
the model, the more spectacularly it fails. This package wraps every `write`
/ `edit` / `hashedit` to a `.clj`/`.cljs`/`.cljc`/`.cljd`/`.edn`/`.bb`/`.fnl`
file with a single check, run via [`parinfer-rust`](https://github.com/eraserhd/parinfer-rust):

1. **Verify** the result by running it through parinfer's parser. Parinfer's
   parser is a Clojure-aware s-expression parser; if it cannot rebalance the
   input, the file has a real structural defect.
2. If the input parses but parinfer rebalanced it (e.g. trimmed extra
   closing parens), **write the rebalanced version back** and warn.
3. If parinfer reports an error it cannot repair (unterminated string,
   reader-macro problem, etc.), **revert the file from a pre-edit snapshot**
   and tell the agent — loudly — to stop and rethink.

After two consecutive failures on the same file, further edits are
**rejected** until a clean edit succeeds. This is the "loop-breaker" that
prevents the doom spiral where each failed attempt makes the file worse.

The plugin emits structured banners that get appended to the tool output
the agent sees. The agent reads them in-band and adjusts.

## What's in the box

```
plugin/clojure-structural-edit.ts   the opencode plugin
skill/SKILL.md                      rules of engagement (loaded as an opencode skill)
skill/scripts/clj-parse-check.sh    parinfer-as-verifier wrapper (manual recovery)
skill/scripts/clj-parinfer-fix.sh   parinfer-rust in-place fix (manual recovery)
```

## Requirements

- [opencode](https://opencode.ai) 1.4 or later (for the plugin hook surface).
- [`parinfer-rust`](https://github.com/eraserhd/parinfer-rust) on `PATH`.
  Install with `cargo install --git https://github.com/eraserhd/parinfer-rust`.

That's it. No JVM, no babashka, no Clojure CLI. The plugin shells out to
`parinfer-rust` once per edit and parses its JSON output for both
verification and repair.

The plugin itself is plain TypeScript with no runtime dependencies; opencode
loads `.ts` plugins natively via Bun. (The two recovery scripts under
`skill/scripts/` use `python3` or `jq` for JSON encoding — both are
typically already on dev machines, but they're only invoked if you run the
scripts manually.)

## Install

### Option A — clone and reference by absolute path (simplest)

```bash
git clone https://github.com/gtrak/parinfer-rust-opencode.git ~/dev/parinfer-rust-opencode
```

Then in your `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "file:///home/YOU/dev/parinfer-rust-opencode/plugin/clojure-structural-edit.ts"
  ],
  "skills": {
    "paths": ["/home/YOU/dev/parinfer-rust-opencode/skill"]
  }
}
```

### Option B — install via `bun add` from git

```bash
cd ~/.config/opencode
bun add github:gtrak/parinfer-rust-opencode
```

Then in `opencode.json`:

```jsonc
{
  "plugin": [
    "file:///home/YOU/.config/opencode/node_modules/parinfer-rust-opencode/plugin/clojure-structural-edit.ts"
  ],
  "skills": {
    "paths": ["/home/YOU/.config/opencode/node_modules/parinfer-rust-opencode/skill"]
  }
}
```

### Option C — drop-in for the default opencode locations

The opencode plugin loader auto-discovers any `*.ts` file in
`.opencode/plugin/` (project) or `~/.config/opencode/plugin/` (global), and
auto-loads any skill in `~/.config/opencode/skills/<name>/SKILL.md`. So you
can also symlink or copy:

```bash
ln -s ~/dev/parinfer-rust-opencode/plugin/clojure-structural-edit.ts \
      ~/.config/opencode/plugin/clojure-structural-edit.ts
ln -s ~/dev/parinfer-rust-opencode/skill \
      ~/.config/opencode/skills/clojure-parinfer
```

Restart opencode after any install. Plugins and skills are loaded once at
startup.

## Behavior matrix

| Edit outcome                                                  | Action                              | Banner                            |
|---------------------------------------------------------------|-------------------------------------|-----------------------------------|
| Already balanced                                              | nothing                             | (silent)                          |
| Already balanced, file was previously unfixable               | nothing destructive                 | `PRE-EXISTING BREAKAGE FIXED`     |
| Imbalanced but parinfer can rebalance                         | parinfer rewrites file in place     | `AUTO-FIXED via parinfer-rust`    |
| Parinfer reports an error it can't fix (e.g. unclosed-quote)  | revert from pre-edit snapshot       | `EDIT REVERTED`                   |
| Two consecutive failures on the same file                     | revert; further edits rejected      | `EDIT REJECTED (loop-breaker)`    |
| First successful edit after lockout                           | counter resets, file unlocks        | (silent)                          |

Banner text is appended to the tool's `output.output`, so the agent sees
it inline in the tool result and can react.

## Configuration

Environment variables:

- `PARINFER_RUST_BIN` — override the path to the parinfer-rust binary
  (default: `parinfer-rust`, looked up on `PATH`).

Constants you can tweak by editing `plugin/clojure-structural-edit.ts`:

- `PARINFER_MODE` (default `"smart"`) — `"smart"`, `"paren"`, or `"indent"`.
- `MAX_CONSECUTIVE_FAILURES` (default `2`) — how many bad edits before the
  loop-breaker engages.
- `CLOJURE_EXTENSIONS` — file extensions the plugin watches.
- `TARGET_TOOLS` — which opencode tools the plugin intercepts.

## Caveats

- opencode 1.4 plugin hooks **observe**; they cannot truly block a tool
  call. The plugin lets the edit hit disk, then reverts on failure.
  Functionally equivalent to a block from the agent's perspective, but a
  concurrent process reading the file mid-edit could observe the broken
  state.
- `parinfer-rust` fixes **bracket structure**, not strings or reader macros.
  Errors like `unclosed-quote` or malformed `#?(:clj …)` get reverted, not
  auto-fixed.
- Parinfer's view of "structurally valid" is not identical to Clojure's.
  In particular, parinfer will silently accept and rebalance moderate
  bracket overflow that Clojure's reader would reject. Under this plugin,
  such files are treated as fixable rather than broken — which is the
  whole point.
- The failure counter is per-process. Restarting opencode resets all
  counters. This is intentional — fresh session, fresh slate.

## Why this exists

I lost too much time watching a small local model bisect a Clojure file by
running `tr -cd '(' | wc -c` over and over again, getting more confused with
each iteration, while the file got progressively more broken. Each "fix" was
applied on top of a still-broken state, the LSP errors moved further from
the actual defect, and the model kept doubling down on character-counting.

The fix is to take the structural problem out of the model's hands. Parinfer
already knows how to balance Lisp brackets correctly, and its parser already
knows what is and isn't a valid s-expression tree. This plugin wires both
into opencode's tool pipeline so the model literally cannot leave a file in
a broken state for more than one round-trip — and after two failed rounds,
it's forced to stop and ask a human.

## Development

```bash
git clone https://github.com/gtrak/parinfer-rust-opencode.git
cd parinfer-rust-opencode
bun install
bun run typecheck
```

The plugin is plain TypeScript, no build step. opencode (via Bun) loads
`.ts` directly.

## License

MIT — see [LICENSE](./LICENSE).
