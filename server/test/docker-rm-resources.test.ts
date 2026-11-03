/*
 * Removing a network or a volume from the Docker view.
 *
 * Two refusals are the point: a built-in network and a data volume never reach
 * docker, whatever the client sends. A stub `docker` on PATH in a child
 * process logs every call (the binary lookup is cached per process).
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-rm-res-"));
const log = join(dir, "calls.log");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
chmodSync(join(dir, "bin", "docker"), 0o755);

function probe(calls: string): unknown {
  const code = `import { removeNetwork, removeVolume } from ${JSON.stringify(new URL("../src/dockerprune.ts", import.meta.url).pathname)};
    console.log(JSON.stringify([${calls}]));`;
  const p = Bun.spawnSync(["bun", "-e", code], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "d.db"), AGENTGLASS_ROOT: dir, NODE_ENV: "test",
    },
    stdout: "pipe", stderr: "pipe",
  });
  return JSON.parse(p.stdout.toString().trim().split("\n").pop() ?? "null");
}

type R = { ok: boolean; error?: string };

test("a user network goes with `docker network rm <name>`", () => {
  rmSync(log, { force: true });
  const [r] = probe(`await removeNetwork("orbit_default")`) as R[];
  expect(r!.ok).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["network rm orbit_default"]);
});

test("bridge, host and none never reach docker, nor does a name that is not a name", () => {
  rmSync(log, { force: true });
  const rs = probe(`await removeNetwork("bridge"), await removeNetwork("host"), await removeNetwork("none"), await removeNetwork("--all; rm")`) as R[];
  expect(rs.map((r) => r.ok)).toEqual([false, false, false, false]);
  expect(rs[0]!.error).toContain("built in");
  expect(existsSync(log)).toBe(false);
});

test("a node_modules volume goes, without -f, so docker still refuses one in use", () => {
  rmSync(log, { force: true });
  const [r] = probe(`await removeVolume("orbit_node_modules")`) as R[];
  expect(r!.ok).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["volume rm orbit_node_modules"]);
});

test("a data volume never reaches docker, whatever its name looks like", () => {
  rmSync(log, { force: true });
  const rs = probe(`await removeVolume("orbit_pgdata"), await removeVolume("orbit_node_modules_backup"), await removeVolume("-f x_node_modules")`) as R[];
  expect(rs.map((r) => r.ok)).toEqual([false, false, false]);
  expect(rs[0]!.error).toContain("Data volumes");
  expect(existsSync(log)).toBe(false);
});

test("the routes sit in the same gated switch as images/rm", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const [route, fn] of [["/docker/networks/rm", "removeNetwork"], ["/docker/volumes/rm", "removeVolume"]]) {
    const at = src.indexOf(`case "${route}": {`);
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("break;\n        }", at));
    expect(body).toContain("DOCKER_WRITE_ENABLED");
    expect(body).toContain(`${fn}(String(b.name`);
  }
});
