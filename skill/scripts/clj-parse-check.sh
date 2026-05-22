#!/usr/bin/env bash
# Parse-check a Clojure/EDN/Lisp file using parinfer-rust as the verifier.
# Exits 0 if the file is structurally sound, non-zero with the parser
# error on stderr otherwise.
#
# Usage: clj-parse-check.sh <path>
#
# Single dependency: parinfer-rust on PATH. No JVM, no babashka, no
# clojure CLI. parinfer-rust's parser is itself a Clojure-aware
# s-expression parser; if it returns `success: false`, the file has a
# real structural problem (unterminated string, reader-macro error,
# unmatched bracket) that parinfer cannot rebalance.
#
# Note: parinfer-rust accepts mild bracket imbalance (extra closes that
# can be inferred away). To check whether a file would be "fixed" by
# parinfer rather than just whether it parses, run clj-parinfer-fix.sh
# on a copy and diff against the original.

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

if ! command -v parinfer-rust >/dev/null 2>&1; then
  echo "parinfer-rust not found on PATH" >&2
  echo "install with: cargo install parinfer-rust" >&2
  exit 3
fi

# Build the JSON payload by piping the file through Python or jq, both
# of which handle escaping correctly. Prefer python3 since it's nearly
# universal; fall back to jq if not.
build_payload() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
src = sys.stdin.read()
print(json.dumps({"text": src, "mode": "smart", "options": {}}))
' < "$file"
  elif command -v jq >/dev/null 2>&1; then
    jq -Rs '{text: ., mode: "smart", options: {}}' < "$file"
  else
    echo "neither python3 nor jq available for JSON encoding" >&2
    return 4
  fi
}

# Run parinfer-rust. It exits non-zero when `success: false`, but always
# emits a valid JSON document on stdout that we want to inspect.
payload="$(build_payload)" || exit 4
set +e
result_json="$(printf '%s' "$payload" | parinfer-rust --input-format=json --output-format=json)"
parinfer_status=$?
set -e
if [[ -z "$result_json" ]]; then
  echo "parinfer-rust produced no output (exit $parinfer_status)" >&2
  exit 4
fi

# Use python3 (preferred) or jq to extract success/error fields.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$result_json" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if data.get("success"):
    print(":ok")
    sys.exit(0)
err = data.get("error") or {}
loc = ""
if isinstance(err.get("lineNo"), int):
    loc = f" [line {err['lineNo']+1}, col {(err.get('x', 0) or 0)+1}]"
msg = f"{err.get('name', '?')}: {err.get('message', '(no message)')}{loc}"
print(msg, file=sys.stderr)
sys.exit(1)
PY
else
  ok="$(echo "$result_json" | jq -r '.success')"
  if [[ "$ok" == "true" ]]; then
    echo ":ok"
    exit 0
  fi
  echo "$result_json" | jq -r '"\(.error.name // "?"): \(.error.message // "(no message)") [line \(((.error.lineNo // 0)+1)), col \(((.error.x // 0)+1))]"' >&2
  exit 1
fi
