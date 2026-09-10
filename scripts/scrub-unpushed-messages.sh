#!/usr/bin/env bash
# Strip the private session link from every UNPUSHED commit message.
#
# History is rewritten, so it only ever runs over commits that have not left
# this machine — `origin/main..HEAD`. A backup ref is written first and the undo
# is printed at the end.
#
# The filter is a FILE, not a heredoc. A heredoc takes stdin away from the
# script inside it, and `--msg-filter` treats stdout as the new message: the
# first version of this emptied all 108 messages and reported success, because
# nothing here had checked that a message survived. This one checks.
set -euo pipefail

cd "$(dirname "$0")/.."
base="${1:-origin/main}"
git rev-parse --verify --quiet "$base" >/dev/null || { echo "no such base: $base" >&2; exit 1; }
n=$(git rev-list --count "$base..HEAD")
[ "$n" -gt 0 ] || { echo "nothing unpushed"; exit 0; }

backup="refs/backup/pre-scrub-$(date +%Y%m%d-%H%M%S)"
git update-ref "$backup" HEAD
echo "==> $n commits; HEAD saved at $backup"

FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --msg-filter "python3 $PWD/scripts/scrub-session-trailer.py" "$base..HEAD" >/dev/null

empty=$(git log "$base..HEAD" --format='%s' | grep -c '^$' || true)
if [ "$empty" -gt 0 ]; then
  git reset --hard "$backup"
  echo "==> $empty messages came out EMPTY. Rolled back to $backup, nothing changed." >&2
  exit 1
fi
left=$(git log "$base..HEAD" --format='%B' | grep -c 'Claude-Session\|claude.ai/code/session' || true)
echo "==> done: $n messages kept, $left session links left. Undo: git reset --hard $backup"
