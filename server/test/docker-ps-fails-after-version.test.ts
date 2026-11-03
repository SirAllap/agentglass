/*
 * A daemon that answers `version` and then refuses `ps` is down, not empty.
 *
 * A successful probe is trusted for 15 s. A daemon that stopped inside that
 * window failed every list and the overview served "available, no containers",
 * which the panel took for the truth: the last good state was wiped off the
 * screen instead of being dimmed under the "can't reach the daemon" banner.
 * A stub `docker` whose `ps` fails stands in for it, in a child process.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-dockps-"));

const PROBE = `
import { overview } from ${JSON.stringify(new URL("../src/docker.ts", import.meta.url).pathname)};
const a = await overview(true);
const b = await overview(true);
console.log(JSON.stringify([a, b].map((o) => ({ available: o.available, freshness: o.freshness, n: o.containers.length }))));
`;

test("ps failing after a good version answers down, with nothing to show", () => {
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh
case "$1" in
  --version|version) echo "24.0.7"; exit 0 ;;
  *) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
esac
`);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  const p = Bun.spawnSync(["bun", "-e", PROBE], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "d.db"), AGENTGLASS_ROOT: dir,
      AGENTGLASS_SCAN_DISABLED: "1", NODE_ENV: "test",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const out = p.stdout.toString();
  expect(out, p.stderr.toString().slice(0, 300)).not.toBe("");
  const [a, b] = JSON.parse(out.trim().split("\n").pop()!) as { available: boolean; freshness: string; n: number }[];
  expect(a).toEqual({ available: false, freshness: "down", n: 0 });
  // The second ask is inside the probe's retry wait, so it must still say down.
  expect(b.available).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
