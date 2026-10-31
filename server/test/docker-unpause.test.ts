/*
 * A paused container needs its own verb: `docker start` refuses one, so Resume
 * built on start/restart would only ever show an error.
 * A stub `docker` on PATH in a child process logs every call (the binary
 * lookup is cached per process).
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-unpause-"));
const log = join(dir, "calls.log");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
chmodSync(join(dir, "bin", "docker"), 0o755);

function probe(writeDisabled: boolean): unknown {
  const code = `import { unpauseContainer } from ${JSON.stringify(new URL("../src/docker.ts", import.meta.url).pathname)};
    console.log(JSON.stringify([await unpauseContainer("web-1"), await unpauseContainer("--all; rm")]));`;
  const p = Bun.spawnSync(["bun", "-e", code], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "d.db"), AGENTGLASS_ROOT: dir, NODE_ENV: "test",
      ...(writeDisabled ? { AGENTGLASS_DOCKER_WRITE_DISABLED: "1" } : {}),
    },
    stdout: "pipe", stderr: "pipe",
  });
  return JSON.parse(p.stdout.toString().trim().split("\n").pop() ?? "null");
}

test("unpause runs `docker unpause <id>` and refuses an id that is not one", () => {
  const [ok, bad] = probe(false) as [{ ok: boolean }, { ok: boolean; error?: string }];
  expect(ok.ok).toBe(true);
  expect(bad.ok).toBe(false);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["unpause web-1"]);
});

test("a read-only instance never reaches docker", () => {
  rmSync(log, { force: true });
  const [a] = probe(true) as [{ ok: boolean; error?: string }];
  expect(a.ok).toBe(false);
  expect(existsSync(log)).toBe(false);
});

test("POST /docker/unpause is a route in the same switch as start and stop", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(src).toContain(`case "/docker/unpause": res = await unpauseContainer(id); break;`);
});
