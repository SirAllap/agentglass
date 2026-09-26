#!/bin/bash
# `make ci-docker`: the `build` and `mobile` jobs of .github/workflows/ci.yml in
# a container that is the runner (see Dockerfile), on the tree as it is now —
# tracked and untracked files, gitignored ones left out, as a checkout would
# have it. Logs land in $AGX_CI_OUT (default ~/.cache/agentglass-ci-docker/out).
# CPUS / MEM override the runner-like default (2 cores, 7g).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bun_version="$(sed -n 's/^ *bun-version: *\([0-9][0-9.]*\).*/\1/p' "$root/.github/workflows/ci.yml" | head -1)"
[ -n "$bun_version" ] || { echo "no pinned bun-version in ci.yml" >&2; exit 2; }
docker build -q -t agx-ci-docker --build-arg "BUN_VERSION=$bun_version" "$here" >/dev/null || exit 2
out="${AGX_CI_OUT:-${XDG_CACHE_HOME:-$HOME/.cache}/agentglass-ci-docker/out}"
mkdir -p "$out" && rm -f "$out"/*.log && chmod 777 "$out"
echo "bun $bun_version · logs in $out"
# The tree goes in as a tar stream: a worktree's .git points at a path the
# container does not have, so the container cannot list files itself.
cd "$root" && git ls-files -z --cached --others --exclude-standard --deduplicate \
  | tar --null -T - --ignore-failed-read -cf - 2>/dev/null \
  | docker run --rm -i --cpus "${CPUS:-2}" --memory "${MEM:-7g}" -v "$out:/out" -v "$here:/ci:ro" agx-ci-docker bash /ci/entry.sh
