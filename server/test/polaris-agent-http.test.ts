/*
 * The same doors over HTTP, against a booted server: who is told apart from the person is
 * decided by the credential, so this is the only place that can show it. With a token, a
 * caller without the app's Origin is an agent; without a token nobody is, and Polaris stays
 * the person's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "tok-polaris-agent-http";
const ROOT = "/work/acme/orbit";
interface Box { dir: string; base: string; proc: ReturnType<typeof Bun.spawn> }
const boxes: Box[] = [];

async function boot(token: string | null, root?: string): Promise<Box> {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-http-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: root ?? dir, AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
      ...(token ? { AGENTGLASS_TOKEN: token } : {}),
    },
    stdout: "ignore", stderr: "pipe",
  });
  const box = { dir, base, proc };
  boxes.push(box);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return box; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}
afterAll(() => { for (const b of boxes) { b.proc.kill(); rmSync(b.dir, { recursive: true, force: true }); } });

const call = async (b: Box, method: string, path: string, headers: Record<string, string>, body?: unknown) => {
  const res = await fetch(b.base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const enable = async (b: Box, h: Record<string, string>) => {
  await call(b, "PUT", "/polaris/settings", h, { root: ROOT, preset: "guided" });
  return call(b, "PUT", "/polaris/settings", h, { root: ROOT, enabled: true });
};

describe("with a token, a caller without the app's Origin is an agent", () => {
  let b: Box;
  beforeAll(async () => {
    b = await boot(TOKEN, ROOT);
    expect((await enable(b, { authorization: `Bearer ${TOKEN}`, origin: b.base })).status).toBe(200);
  }, SERVER_BOOT_MS);
  const agent = () => ({ authorization: `Bearer ${TOKEN}` });
  const act = (h: Record<string, string>, body: Record<string, unknown>, path = "action") => call(b, "POST", `/polaris/items/7/${path}`, h, { root: ROOT, ...body });

  test("a draft is its own to write, with the asker in the audit", async () => {
    const r = await act({ ...agent(), "x-agentglass-agent": "orbit-chair" }, { type: "beacon-draft", reason: "failing", text: "Fix the build." });
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: 200, body: { ok: true } });
  });

  test("the machine token acts on the project the app is open on and on no other", async () => {
    expect((await act(agent(), { type: "beacon-draft", reason: "other", text: "Fix it." })).status).toBe(200);
    const away = await call(b, "POST", "/polaris/items/7/action", agent(), { root: "/work/acme/another-project", type: "beacon-draft", reason: "failing", text: "Fix it." });
    expect(away.status).toBe(403);
    expect(String(away.body.error)).toContain("its own project");
  });

  test("a header naming a named agent or a launched builder does not pick the root", async () => {
    const other = "/work/acme/other-project";
    // Polaris on there too, so a 403 below can only come from the confinement and not from a door that is off.
    for (const body of [{ root: other, preset: "guided" }, { root: other, enabled: true }]) {
      expect((await call(b, "PUT", "/polaris/settings", { ...agent(), origin: b.base }, body)).status).toBe(200);
    }
    // The two rows the headers claim: an agent whose project is `other`, and a launched plan that owns it.
    const db = new Database(join(b.dir, "d.db"));
    db.run(`INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ["other-chair", "claude", other, "%98", "w-other", Date.now()]);
    db.run(`INSERT OR REPLACE INTO flight_plan (id, root, title, request, state, launched, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["fp_other", other, "Other plan", "do it", "launched", JSON.stringify({ at: Date.now(), title: "Other plan", worktree: other }), Date.now(), Date.now()]);
    db.close();
    const body = { root: other, type: "beacon-draft", reason: "failing", text: "Fix it." };
    const headers: Record<string, string>[] = [{ "x-agentglass-agent": "other-chair" }, { "x-agentglass-builder": other }];
    for (const header of headers) {
      const r = await call(b, "POST", "/polaris/items/7/action", { ...agent(), ...header }, body);
      expect(r, JSON.stringify(header + JSON.stringify(r.body))).toMatchObject({ status: 403 });
      expect(String(r.body.error)).toContain("its own project");
    }
  });

  test("dock, settings and an over-long text are refused", async () => {
    expect((await act(agent(), { type: "dock" })).status).toBe(403);
    expect((await call(b, "PUT", "/polaris/settings", agent(), { root: ROOT, enabled: false })).status).toBe(403);
    expect((await act(agent(), { type: "beacon-draft", reason: "x", text: "y".repeat(2001) })).status).toBe(400);
    expect((await act(agent(), { type: "merge" })).body.error).toContain("beacon-send-on-click");
  });

  test("an agent cannot answer a Polaris request, and the list answers with the new kind's filter", async () => {
    expect((await call(b, "POST", "/settings/requests/decide", agent(), { id: "pa_0000", approve: true })).status).toBe(403);
    expect(await call(b, "GET", "/settings/requests?states=all", agent())).toMatchObject({ status: 200, body: { ok: true, requests: [] } });
  });
});

describe("with no token nobody is an agent", () => {
  test("the person's dock works and Polaris stays the person's", async () => {
    const b = await boot(null);
    const app = { origin: b.base };
    expect((await enable(b, app)).status).toBe(200);
    expect((await call(b, "POST", "/polaris/items/7/action", app, { root: ROOT, type: "dock" })).status).toBe(200);
  }, SERVER_BOOT_MS);

  test("a write from a caller no credential names is refused, not guessed at", async () => {
    const b = await boot(null);
    const app = { origin: b.base };
    expect((await enable(b, app)).status).toBe(200);
    // No token, no Origin: the shape the docs say stays person-only. It used to be an agent's write.
    const bare = await call(b, "POST", "/polaris/items/7/action", {}, { root: ROOT, type: "beacon-draft", reason: "failing", text: "Fix it." });
    expect(bare.status).toBe(403);
    expect(String(bare.body.error)).toContain("no credential");
    // And a read is still open, so the CLI can look without a credential.
    expect((await call(b, "GET", `/polaris/settings?root=${encodeURIComponent(ROOT)}`, {})).status).toBe(200);
  }, SERVER_BOOT_MS);
});
