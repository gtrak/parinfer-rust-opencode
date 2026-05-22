#!/usr/bin/env bash
# Parse-check a Clojure/EDN/Lisp file. Exits 0 if it parses cleanly,
# non-zero with the reader error on stderr otherwise.
#
# Usage: clj-parse-check.sh <path>
#
# Strategy: structural parse only — no symbol or alias resolution. We use
# rewrite-clj's parser, which builds a node tree without trying to resolve
# `::alias/keyword` forms against any namespace. This lets us reject real
# bracket / string / reader-macro imbalances without false negatives on
# auto-resolved namespaced keywords or on files whose `(ns ...)` form has
# not been evaluated.

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

# Wrap the file path so the embedded clojure expression doesn't have to
# concatenate it as a string. We pass it via *command-line-args*.

# Babashka path — rewrite-clj is bundled, fastest startup.
if command -v bb >/dev/null 2>&1; then
  bb -e "
    (require '[rewrite-clj.parser :as p])
    (try
      (p/parse-string-all (slurp (first *command-line-args*)))
      (println :ok)
      (catch Exception e
        (binding [*out* *err*]
          (println (.getMessage e))
          (flush))
        (System/exit 1)))
  " "$file"
  exit $?
fi

# Clojure CLI fallback — uses tools.reader with a permissive *alias-map*.
# Slower (JVM startup), but available on any Clojure dev machine.
if command -v clojure >/dev/null 2>&1; then
  clojure -Sdeps '{:deps {org.clojure/tools.reader {:mvn/version "1.4.2"}}}' -M -e "
    (require '[clojure.tools.reader :as r]
             '[clojure.tools.reader.reader-types :as rt])
    (let [src (slurp (first *command-line-args*))
          rdr (rt/string-push-back-reader (str \"[\" src \"\\n]\"))
          sentinel (Object.)]
      (binding [r/*alias-map* (fn [_] 'unresolved-alias)]
        (try
          (loop []
            (let [form (r/read {:eof sentinel :read-cond :allow} rdr)]
              (when-not (identical? form sentinel) (recur))))
          (println :ok)
          (catch Exception e
            (binding [*out* *err*]
              (print (.getMessage e))
              (when-let [d (ex-data e)]
                (when (or (:line d) (:col d))
                  (print (str \" [line \" (:line d) \", col \" (:col d) \"]\")))
                (println))
              (flush))
            (System/exit 1)))))
  " "$file"
  exit $?
fi

echo "neither bb nor clojure found on PATH; cannot parse-check $file" >&2
exit 3
