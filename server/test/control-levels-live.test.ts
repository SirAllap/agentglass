/*
 * The level switch against a running server, one process per setting: a
 * settings.set (level 2) is refused at level 1 and under AGENTGLASS_CONTROL_READONLY,
 * and goes through to a window at level 2 and 3. The window is a bare /stream
 * socket that answers by hand, as in control-reply.test.ts; what it does with a
 * setting is web/test's business. The pure table is control-levels.test.ts.
 *
 * What is pinned here is what only a process can show: the switch is read when
 * the server starts (a refused write reaches NO window, not even a frame), the
 * refusal is a 403 that names the door and the switch, the registry the server
 * serves is cut at the same level, and a refusal leaves a line in the log.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

interface Srv { base: string; proc: ReturnType<typeof Bun.spawn>; dir: string }
const live: Srv[] = [];

async function boot(extra: Record<string, string>): Promise<Srv> {
  const dir = mkdtempSync(join(tmpdir(), "agx-control-levels-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      ...extra,
    },
    stdout: "ignore", stderr: "pipe",
  });
  const s = { base, proc, dir };
  live.push(s);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return s; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

afterAll(() => {
  for (const s of live) {
    try { s.proc.kill(); } catch { /* already gone */ }
    try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
});

const SET = { cmd: "ui", do: "settings.set", args: { id: "diff.wrap", value: true }, as: "tester" };
const post = (s: Srv, body: unknown) =>
  fetch(s.base + "/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A window that answers whatever it is sent with an applied reply, and keeps the frames. */
async function window_(s: Srv) {
  const ws = new WebSocket(s.base.replace("http", "ws") + "/stream");
  const frames: { data: any; rid?: string }[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      const f = JSON.parse(String((ev as MessageEvent).data));
      if (f.type !== "control") return;
      frames.push({ data: f.data, rid: f.rid });
      if (f.rid) void fetch(s.base + "/control/result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rid: f.rid, ok: true, applied: true, value: { ok: true, id: "diff.wrap", prev: false, value: true, undo: "u1" } }),
      });
    } catch { /* not json */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  // A control frame goes to windows that said hello, as the app's does on every connect.
  ws.send(JSON.stringify({ type: "hello", clientId: `win-${crypto.randomUUID()}`, browser: true }));
  await Bun.sleep(100);
  return { frames, close: () => ws.close() };
}

const actions = async (s: Srv) => (await (await fetch(s.base + "/control/actions")).json()) as { level: number; readonly: boolean; actions: { id: string }[] };
const logOf = async (s: Srv) => JSON.stringify(await (await fetch(s.base + "/actions?limit=20")).json());

describe("a level 2 write against a server started at each level", () => {
  const held: [string, Record<string, string>, number][] = [
    ["AGENTGLASS_CONTROL_LEVEL=1", { AGENTGLASS_CONTROL_LEVEL: "1" }, 1],
    ["AGENTGLASS_CONTROL_READONLY=1", { AGENTGLASS_CONTROL_READONLY: "1" }, 1],
    ["READONLY=1 beats LEVEL=3", { AGENTGLASS_CONTROL_READONLY: "1", AGENTGLASS_CONTROL_LEVEL: "3" }, 1],
    // Set and unreadable fails closed: the owner who wrote 0 or off asked for less.
    ["AGENTGLASS_CONTROL_LEVEL=off", { AGENTGLASS_CONTROL_LEVEL: "off" }, 1],
    ["AGENTGLASS_CONTROL_LEVEL= (empty but present)", { AGENTGLASS_CONTROL_LEVEL: "" }, 1],
  ];
  for (const [name, env, level] of held) {
    test(`${name}: refused with the door and whose setting it is, and no window is told`, async () => {
      const s = await boot(env);
      const w = await window_(s);
      const r = await post(s, SET);
      expect(r.status).toBe(403);
      const body = (await r.json()) as { ok: boolean; error: string; level: number };
      expect(body.ok).toBe(false);
      expect(body.level).toBe(level);
      expect(body.error).toContain("settings.set");
      expect(body.error).toContain("level 2");
      // Whose decision it is, and not how to move it.
      expect(body.error).toContain("owner's setting");
      expect(body.error).not.toMatch(/AGENTGLASS_|=\d/);
      await Bun.sleep(150);
      expect(w.frames.length).toBe(0);
      // An open is untouched by the switch.
      const open = await post(s, { cmd: "ui", do: "settings.open", args: { page: "diff" } });
      expect(open.status).toBe(200);
      // The registry served is cut at the same level and says why.
      const a = await actions(s);
      expect(a.level).toBe(1);
      expect(a.actions.some((x) => x.id === "settings.set")).toBe(false);
      expect(a.actions.some((x) => x.id === "settings.open")).toBe(true);
      expect(await logOf(s)).toContain("settings.set");
      w.close();
    }, SERVER_BOOT_MS);
  }

  for (const [name, env, level] of [["no switch (the default)", {}, 2], ["AGENTGLASS_CONTROL_LEVEL=2", { AGENTGLASS_CONTROL_LEVEL: "2" }, 2], ["AGENTGLASS_CONTROL_LEVEL=3", { AGENTGLASS_CONTROL_LEVEL: "3" }, 3]] as const) {
    test(`${name}: allowed, the window receives it and its answer comes back`, async () => {
      const s = await boot(env);
      const w = await window_(s);
      const r = await post(s, SET);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; applied: boolean };
      expect(body).toMatchObject({ ok: true, applied: true });
      expect(w.frames.some((f) => f.data?.do === "settings.set" && f.data?.args?.id === "diff.wrap")).toBe(true);
      expect((await actions(s)).level).toBe(level);
      w.close();
    }, SERVER_BOOT_MS);
  }

  test("a bad value says so once at boot, naming the value and the level held", async () => {
    const s = await boot({ AGENTGLASS_CONTROL_LEVEL: "banana" });
    expect((await actions(s)).level).toBe(1);
    s.proc.kill();
    await s.proc.exited;
    const err = await new Response(s.proc.stderr as ReadableStream).text();
    const lines = err.split("\n").filter((l) => l.includes("AGENTGLASS_CONTROL_LEVEL"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('"banana"');
    expect(lines[0]).toContain("level 1");
  }, SERVER_BOOT_MS);

  test("a palette and a zoom are level 2 writes: refused at level 1 and READONLY, delivered at 2", async () => {
    for (const env of [{ AGENTGLASS_CONTROL_LEVEL: "1" }, { AGENTGLASS_CONTROL_READONLY: "1" }] as Record<string, string>[]) {
      const s = await boot(env);
      const w = await window_(s);
      for (const body of [{ cmd: "theme", dir: 1 }, { cmd: "ui", do: "theme.set", args: { name: "nord" } }, { cmd: "zoom", dir: 1 }, { cmd: "ui", do: "zoom.step", args: { dir: 0 } }]) {
        expect((await post(s, body)).status, JSON.stringify(body)).toBe(403);
      }
      await Bun.sleep(100);
      expect(w.frames.length).toBe(0);
      w.close();
    }
    const s = await boot({});
    const w = await window_(s);
    expect((await post(s, { cmd: "zoom", dir: 1 })).status).toBe(200);
    expect(w.frames.some((f) => f.data?.cmd === "zoom")).toBe(true);
    w.close();
  }, SERVER_BOOT_MS);

  test("a loop of refused writes is a loop of 403s and one log row with a count", async () => {
    const s = await boot({ AGENTGLASS_CONTROL_LEVEL: "1" });
    await window_(s);
    for (let i = 0; i < 7; i++) expect((await post(s, SET)).status).toBe(403);
    const rows = JSON.stringify(await (await fetch(s.base + "/actions?limit=50")).json()).split("settings.set").length - 1;
    expect(rows).toBe(1);
  }, SERVER_BOOT_MS);

  test("a /stream listener that never said hello is not a window: no frame, no request id, and 'no window' stays 503", async () => {
    const s = await boot({});
    const ws = new WebSocket(s.base.replace("http", "ws") + "/stream");
    const seen: string[] = [];
    ws.addEventListener("message", (ev) => { seen.push(String((ev as MessageEvent).data)); });
    await new Promise((r) => ws.addEventListener("open", r));
    await Bun.sleep(100);
    const r = await post(s, { cmd: "ui", do: "ui.state", as: "tester" });
    expect(r.status).toBe(503);
    expect(seen.filter((m) => m.includes('"control"')).length).toBe(0);
    ws.close();
  }, SERVER_BOOT_MS);

  test("an unknown door is the bare 400 at every level, and says nothing about doors above it", async () => {
    const s = await boot({ AGENTGLASS_CONTROL_LEVEL: "1" });
    const r = await post(s, { cmd: "ui", do: "merge.everything", args: {} });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("unknown control command");
  }, SERVER_BOOT_MS);
});
