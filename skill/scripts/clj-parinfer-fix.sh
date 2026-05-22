#!/usr/bin/env bash
# Run parinfer-rust on a Clojure/EDN/Lisp file in place.
#
# Usage: clj-parinfer-fix.sh <path> [mode]
#   mode: smart (default) | paren | indent
#
# Writes the parinfer-corrected content back to the file. Exits 0 on
# success, non-zero if parinfer-rust is missing or fails.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <file> [smart|paren|indent]" >&2
  exit 2
fi

file="$1"
mode="${2:-smart}"

if ! command -v parinfer-rust >/dev/null 2>&1; then
  echo "parinfer-rust not found on PATH" >&2
  echo "install with: cargo install parinfer-rust" >&2
  exit 3
fi

if [[ ! -f "$file" ]]; then
  echo "no such file: $file" >&2
  exit 2
fi

case "$mode" in
  smart|paren|indent) ;;
  *) echo "invalid mode: $mode (use smart|paren|indent)" >&2; exit 2 ;;
esac

# Choose language by extension.
ext="${file##*.}"
lang=clojure
case "$ext" in
  fnl)     lang=lisp ;;          # fennel — closest match in parinfer-rust
  rkt|scm) lang=scheme ;;
  janet)   lang=janet ;;
  hy)      lang=hy ;;
esac

tmp="$(mktemp "${file}.parinfer.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if ! parinfer-rust --mode "$mode" --language "$lang" < "$file" > "$tmp"; then
  echo "parinfer-rust failed on $file" >&2
  exit 4
fi

# Only overwrite if content actually changed (cheap no-op detection).
if cmp -s "$file" "$tmp"; then
  exit 0
fi

mv "$tmp" "$file"
trap - EXIT
