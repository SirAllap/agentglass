/*
 * GET and POST /usage/opens against a server booted in a jail of its own: a
 * batch posted by the window is counted and read back, a bad one is refused
 * with a reason, and the count lands in the state dir and nowhere else.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir: string, base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const post = (body: unknown) => fetch(base + "/usage/opens", { method: "POST", headers, body: JSON.stringify(body) });
const get = () => fetch(base + "/usage/opens", { headers });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-usage-opens-route-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const src = new URL("../src/index.ts", import.meta.url).pathname;
  proc = Bun.spawn(["bun", "run", src], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
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

test("a posted batch is counted and read back, most opened first", async () => {
  expect(await (await get()).json()).toMatchObject({ opens: [] });
  const r = await post({ opens: { "view:git": 2, "settings:about": 1 } });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, recorded: 3 });
  await post({ opens: { "view:git": 1 } });
  const out = await (await get()).json() as { since: string; opens: { id: string; count: number; last: string }[] };
  expect(out.opens.map((o) => [o.id, o.count])).toEqual([["view:git", 3], ["settings:about", 1]]);
  expect(out.opens[0]!.last).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("the count is a file in the state dir", () => {
  const file = join(dir, "state", "usage-opens.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).rows["view:git"].count).toBe(3);
});

test("a batch with an id the window would never mint is refused with the reason, and counts nothing", async () => {
  const r = await post({ opens: { "/home/ana/code": 1 } });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toContain("not an id");
  const out = await (await get()).json() as { opens: { id: string }[] };
  expect(out.opens.some((o) => o.id.includes("/"))).toBe(false);
});

test("a body that is not JSON is a 400, not a crash", async () => {
  const r = await fetch(base + "/usage/opens", { method: "POST", headers, body: "{nope" });
  expect(r.status).toBe(400);
});

test("without the token it is refused like every other route", async () => {
  expect((await fetch(base + "/usage/opens")).status).toBe(401);
  expect((await fetch(base + "/usage/opens", { method: "POST", body: "{}" })).status).toBe(401);
});
