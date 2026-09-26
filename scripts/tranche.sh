#!/bin/bash
# tranche.sh <server|web|mobile> <command...> — run a test tranche in that dir and print
# how many tests it ran (pass + fail + skip). `bun test` exits 0 with tests it never ran (a fresh
# worktree without mobile/node_modules reported "586 pass, 0 fail" out of 723),
# so the count is compared to the floor in scripts/tranche-floors.txt and a
# short tranche fails here. The floor is where the totals live: a commit that
# adds tests may raise it, one that removes tests must lower it on purpose.
set -uo pipefail
name="$1"; shift
root="$(cd "$(dirname "$0")/.." && pwd)"
log="$(mktemp)"; trap 'rm -f "${log:?}"' EXIT
(cd "$root/$name" && "$@") 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
count() { sed -n "s/^ *\([0-9][0-9]*\) $1\$/\1/p" "$log" | tail -1; }
pass=$(count pass) fail=$(count fail) skip=$(count skip)
[ -n "$pass$fail$skip" ] || { echo "tranche $name: no totals in the output — the runner's format changed, or it never ran" >&2; exit 1; }
total=$(( ${pass:-0} + ${fail:-0} + ${skip:-0} ))
floor=$(sed -n "s/^$name *\([0-9][0-9]*\)\$/\1/p" "$root/scripts/tranche-floors.txt")
echo "tranche $name: ${pass:-0} pass, ${fail:-0} fail, ${skip:-0} skip (floor ${floor:-none})"
[ "$code" -eq 0 ] || exit "$code"
if [ -n "$floor" ] && [ "$total" -lt "$floor" ]; then
  echo "tranche $name ran $total tests, below its floor of $floor — some of it did not run (missing node_modules?)" >&2
  exit 1
fi
