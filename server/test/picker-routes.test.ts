/*
 * The project picker's routes, against a real server.
 *
 * The picker opens several projects at once by posting a list, and reads the
 * list back on every launch. The config helpers are tested on their own in
 * multi-scope.test.ts; this holds the wire shape, because a route that kept
 * reading `root` alone would take a list of three and open none of them — and
 * the helper tests would stay green.
 *
 * Isolated the way every server test here is: a scratch config, data, cache,
 * state and database, and no scanner.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir = "", base = "", A = "", B = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: auth, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const get = (path: string) => fetch(base + path, { headers: auth }).then((r) => r.json() as Promise<any>);

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-picker-route-")));
  A = join(dir, "code", "orbit");
  B = join(dir, "code", "lander");
  for (const p of [A, B]) mkdirSync(p, { recursive: true });
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
      AGENTGLASS_DB: join(dir, "picker.db"),
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

const saved = () => JSON.parse(readFileSync(join(dir, "cfg", "agentglass", "config.json"), "utf8"));

describe("opening several projects", () => {
  test("a fresh instance is unscoped, and says so as an empty list", async () => {
    const p = await get("/projects");
    expect(p.workspace).toBeNull();
    expect(p.workspaces).toEqual([]);
  });

  test("a list of roots opens all of them, and reads back as a list", async () => {
    const r = await post("/workspace", { roots: [A, B] });
    expect(r.ok).toBe(true);
    expect(r.workspaces).toEqual([A, B]);
    const p = await get("/projects");
    expect(p.workspaces).toEqual([A, B]);
    expect(p.workspace).toBe(A);
    expect(saved().root).toEqual([A, B]);
  });

  test("the one-project body an older client sends still works", async () => {
    const r = await post("/workspace", { root: B });
    expect(r.ok).toBe(true);
    expect((await get("/projects")).workspaces).toEqual([B]);
  });

  test("a list with a missing folder in it is refused whole", async () => {
    const r = await post("/workspace", { roots: [A, join(dir, "gone")] });
    expect(r.ok).toBe(false);
    expect((await get("/projects")).workspaces).toEqual([B]);
  });
});
