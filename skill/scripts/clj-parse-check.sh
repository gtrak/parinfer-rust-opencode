#!/usr/bin/env bash
# Parse-check a Clojure/EDN/Lisp file. Exits 0 if it reads cleanly,
# non-zero with the reader error on stderr otherwise.
#
# Usage: clj-parse-check.sh <path>
#
# Strategy: wrap the file content in a top-level vector and call
# read-string with reader-conditionals enabled, so multiple top-level
# forms and `#?` forms read correctly.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <file>" >&2
  exit 2
fi

file="$1"

if [[ ! -f "$file" ]]; then
  echo "no such file: $file" >&2
  exit 2
fi

read -r -d '' EXPR <<'CLJ' || true
(let [src (slurp (first *command-line-args*))]
  (read-string {:read-cond :allow} (str "[" src "\n]"))
  (println :ok))
CLJ

# Prefer babashka — fast startup.
if command -v bb >/dev/null 2>&1; then
  bb -e "$EXPR" "$file"
  exit $?
fi

if command -v clojure >/dev/null 2>&1; then
  clojure -M -e "$EXPR" -- "$file"
  exit $?
fi

echo "neither bb nor clojure found on PATH; cannot parse-check $file" >&2
exit 3
