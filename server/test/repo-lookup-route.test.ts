// GET /gh/repo-lookup through a real server with a fake gh first on PATH: a
// malformed name is refused before any process is spawned (the fake logs every
// call, so "never spawned" is read from the log, not assumed), and a good name
// comes back through the route as the lookup's own answer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

let dir = "", base = "", log = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-repoloc-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  log = join(dir, "gh.log");
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$AGX_GH_LOG"',
    'case "$*" in *search/issues*) echo \'{"total_count":2}\';; *) echo \'{"full_name":"acme/orbit","private":false,"description":"d","default_branch":"main"}\';; esac',
    "",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "a.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGX_GH_LOG: log,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ask = async (q: string) => (await fetch(`${base}/gh/repo-lookup?${q}`)).json() as Promise<Record<string, unknown>>;
const spawned = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

describe("GET /gh/repo-lookup", () => {
  test("a malformed name is refused before gh is spawned", async () => {
    for (const bad of ["", "acme", "a/b/c", "acme/orbit;ls", "acme/..", "-x/y", encodeURIComponent("acme/orbit?x=1")]) {
      expect(await ask(`repo=${bad === "" ? "" : bad}`)).toEqual({ found: false, error: "bad-repo" });
    }
    expect(await ask("")).toEqual({ found: false, error: "bad-repo" });
    expect(spawned()).toEqual([]);
  });
  test("anything but GET is refused and spawns nothing", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await fetch(`${base}/gh/repo-lookup?repo=acme/orbit`, { method });
      expect(r.status).toBe(405);
    }
    expect(spawned()).toEqual([]);
  });
  test("a good name is answered by the lookup", async () => {
    const a = await ask("repo=acme/orbit");
    expect(a).toEqual({ found: true, repo: "acme/orbit", private: false, description: "d", defaultBranch: "main", openPrs: 2 });
    expect(spawned()[0]).toBe("api repos/acme/orbit");
  });
});
