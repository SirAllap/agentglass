#!/bin/bash
# ci.yml's `build` job and then its `mobile` job, in the order the workflow
# declares them. The commands are copied from ci.yml by hand, so a step
# added there is not here until somebody adds it; nothing diffs the two yet. Every step runs even when an earlier one failed, so one pass
# finds every red; the last lines say which steps failed and what each test
# tranche ran. Exit 1 if any step failed.
unset TERM
failed=()
st() {
  local name="$1"; shift
  local t0=$SECONDS
  if ( "$@" ) > "/out/$name.log" 2>&1; then echo "ok    $name ($((SECONDS - t0))s)"
  else echo "FAIL  $name ($((SECONDS - t0))s) — /out/$name.log"; tail -n 15 "/out/$name.log" | sed 's/^/        | /'; failed+=("$name"); fi
}
st install     bun install --frozen-lockfile
st logo        bun scripts/logo.mjs --check
st lint        bun run lint
st tc-web      bash -c 'cd web && bun run typecheck'
st tc-server   bash -c 'cd server && bun run typecheck'
st tc-electron bash -c 'cd electron && bun run typecheck'
st test-server scripts/tranche.sh server bun test --timeout 20000
st test-web    scripts/tranche.sh web bun test
st build-web   bash -c 'cd web && bun run build'
st smoke       bash -c 'cd server && (AGENTGLASS_PORT=4000 AGENTGLASS_DB=/tmp/smoke.db AGENTGLASS_SCAN_DISABLED=1 bun run src/index.ts & echo $! > /tmp/sv.pid); cd .. && for i in $(seq 1 30); do curl -sf http://localhost:4000/health >/dev/null && break; sleep 1; done; CHROME_PATH=/usr/bin/google-chrome-stable bun scripts/smoke.ts; s=$?; kill $(cat /tmp/sv.pid) || true; exit $s'
st perf        bun scripts/perfbudget.ts
st server-boots bash -c 'cd server && (AGENTGLASS_PORT=4123 AGENTGLASS_DB=/tmp/ci.db AGENTGLASS_SCAN_DISABLED=1 bun run src/index.ts & echo $! > /tmp/sv2.pid); sleep 2; curl -sf http://localhost:4123/health; r=$?; kill $(cat /tmp/sv2.pid); exit $r'
st mob-install bash -c 'cd mobile && npm ci'
st mob-tc      bash -c 'cd mobile && npm run typecheck'
st test-mobile scripts/tranche.sh mobile npm test
echo "──"
grep -h '^tranche ' /out/test-*.log 2>/dev/null
if [ ${#failed[@]} -eq 0 ]; then echo "ci-docker: green"; else echo "ci-docker: RED — ${failed[*]}"; exit 1; fi
