/*
 * A 5 second poll must be able to find the overview cache warm.
 *
 * The cache held the answer for 2 s and the panel polled every 5 s, so no poll
 * ever hit it: 12 polls a minute ran the whole set of docker CLI calls each
 * (116 spawns a minute at 8 containers, measured). A stub `docker` that logs
 * every call stands in for the daemon, in a child process so the binary lookup
 * (cached per process) and the clock are this test's own.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-dockpoll-"));
const log = join(dir, "calls.log");

function stub(): void {
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  writeFileSync(join(bin, "docker"), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  --version|version) echo "24.0.7" ;;
  ps) echo '{"ID":"aaaaaaaaaaaa","Names":"web","Image":"nginx","State":"running","Status":"Up 2 hours","Ports":"","CreatedAt":"2026-09-29 10:00:00 +0000 UTC","Labels":""}' ;;
  inspect) echo '[]' ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
}

const PROBE = `
import { overview } from ${JSON.stringify(new URL("../src/docker.ts", import.meta.url).pathname)};
let clock = Date.now();
Date.now = () => clock;
const seen = [];
for (let i = 0; i < 12; i++) { const o = await overview(); seen.push(o.freshness); clock += 5000; }
const fresh = await overview(true);
console.log(JSON.stringify({ seen, fresh: fresh.freshness }));
`;

test("polls every 5 s are answered from the cache half the time, and Refresh still asks the daemon", async () => {
  stub();
  const p = Bun.spawn(["bun", "-e", PROBE], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "d.db"), AGENTGLASS_ROOT: dir,
      AGENTGLASS_SCAN_DISABLED: "1", NODE_ENV: "test",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
  await p.exited;
  expect(err.length === 0 || !out, err.slice(0, 300)).toBe(true);
  const { seen, fresh } = JSON.parse(out.trim().split("\n").pop()!) as { seen: string[]; fresh: string };
  const hits = seen.filter((f) => f === "stale").length;
  const spawns = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  console.log(`12 polls at 5 s: ${hits} from cache, ${12 - hits} full reads; ${spawns} docker spawns (incl. one forced refresh)`);
  expect(hits, "the cache outlives the poll").toBeGreaterThanOrEqual(5);
  expect(fresh, "Refresh reads the daemon, not the cache").toBe("live");
  rmSync(dir, { recursive: true, force: true });
});
