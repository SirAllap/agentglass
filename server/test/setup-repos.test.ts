/*
 * GET /setup/repos: what step 4 lists for a folder.
 *
 * A folder holding three repositories answers three rows with their names and
 * the branch each is on; a folder that holds none answers "exists, no rows",
 * which the step reads as "not a git repository"; a path that is not there
 * answers `exists: false`, which is its own sentence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { SetupRepos } from "../../shared/types.ts";

const TOKEN = "tok-setup-repos-example";
let dir: string, base: string, code: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const read = async (path: string): Promise<SetupRepos> =>
  (await fetch(base + "/setup/repos?path=" + encodeURIComponent(path), { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Promise<SetupRepos>;

const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: code, stdout: "ignore", stderr: "ignore" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-setup-repos-"));
  code = join(dir, "code");
  for (const name of ["orbit", "harbour", "ledger-api"]) {
    mkdirSync(join(code, "acme", name), { recursive: true });
    git("init", "-q", join(code, "acme", name));
  }
  mkdirSync(join(code, "notes"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("a folder holding three repositories", () => {
  test("three rows, each with its name, its path and its branch", async () => {
    const r = await read(code);
    expect(r.exists).toBe(true);
    expect(r.repos.map((x) => x.name)).toEqual(["harbour", "ledger-api", "orbit"]);
    expect(r.repos.every((x) => x.branch.length > 0)).toBe(true);
    expect(r.repos.every((x) => x.root.startsWith(code))).toBe(true);
    expect(r.capped).toBe(false);
  });

  test("a folder with no repository in it exists and holds none", async () => {
    const r = await read(join(code, "notes"));
    expect(r).toMatchObject({ exists: true, repos: [], capped: false });
  });

  test("a folder that is gone says so, and names the path it read", async () => {
    const r = await read(join(code, "gone"));
    expect(r.exists).toBe(false);
    expect(r.path).toBe(join(code, "gone"));
  });

  test("text that is not a path at all is refused without being resolved", async () => {
    expect(await read("relative/code")).toMatchObject({ path: "", exists: false, repos: [] });
  });
});
