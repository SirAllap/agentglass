/*
 * A server started on a config from before the picker listed folders.
 *
 * The seeding itself is tested against the config module in
 * project-roots.test.ts; this holds the route that runs it. A seed nothing
 * calls is the same silent loss as no seed: a scope of ~/code whose projects
 * are listed with none of them open, one click from being narrowed to one.
 *
 * Isolated the way every server test here is: a scratch config, data, cache,
 * state and database, and no scanner.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir = "", base = "", code = "", A = "", B = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
const auth = { authorization: `Bearer ${TOKEN}` };
const get = (path: string) => fetch(base + path, { headers: auth }).then((r) => r.json() as Promise<any>);
const saved = () => JSON.parse(readFileSync(join(dir, "cfg", "agentglass", "config.json"), "utf8"));

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-picker-upgrade-")));
  code = join(dir, "code");
  A = join(code, "orbit");
  B = join(code, "lander");
  for (const p of [A, B]) Bun.spawnSync(["git", "init", "-q", "-b", "main", p]);
  // The old shape: the whole of ~/code opened as one scope, and no folders.
  mkdirSync(join(dir, "cfg", "agentglass"), { recursive: true });
  writeFileSync(join(dir, "cfg", "agentglass", "config.json"), JSON.stringify({ root: code }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const src = new URL("../src/index.ts", import.meta.url).pathname;
  proc = Bun.spawn(["bun", "run", src], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      XDG_CONFIG_HOME: join(dir, "cfg"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_DB: join(dir, "upgrade.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("the first picker read turns an old folder scope into a folder, and leaves the scope alone", async () => {
  const r = await get("/git/repos?all=1");
  expect(r.roots).toEqual([code]);
  expect(r.repos.map((x: { root: string }) => x.root).sort()).toEqual([A, B].sort());
  expect(saved()).toEqual({ root: code, repoDirs: [code] });
  expect((await get("/projects")).workspaces).toEqual([code]);
});
