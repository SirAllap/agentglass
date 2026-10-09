/*
 * A /control command that wants an answer, against a running server: the frame a
 * window receives carries a request id, the window answers on POST
 * /control/result, and the caller of /control gets that answer back. The window
 * here is a bare /stream socket that answers by hand, which is all the protocol
 * asks of one; what the real window computes is web/test's business.
 *
 * Pinned: no window is a 503 for a read as for an open; the first of two windows
 * to answer wins; a duplicate and a made-up id settle nothing; a command with no
 * `id` that is not a read is still fire-and-forget; a read waits whether or not
 * it carried an `id`; /control/result refuses a foreign page and a body that is
 * not a reply; and the audit line carries the door and the verdict, no value.
 * The timeout is control-pending.test.ts: waiting five real seconds here would
 * prove the same line twice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-control-reply-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
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
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

const sockets: WebSocket[] = [];
interface Win { frames: { data: any; rid?: string }[]; ws: WebSocket }
async function window_(): Promise<Win> {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  const frames: Win["frames"] = [];
  ws.addEventListener("message", (ev) => {
    try { const f = JSON.parse(String((ev as MessageEvent).data)); if (f.type === "control") frames.push({ data: f.data, rid: f.rid }); } catch { /* not json */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  // A control frame goes to windows that said hello, as the app's does on every connect.
  ws.send(JSON.stringify({ type: "hello", clientId: `win-${crypto.randomUUID()}`, browser: true }));
  await Bun.sleep(100);
  return { frames, ws };
}

afterEach(async () => {
  for (const w of sockets.splice(0)) try { w.close(); } catch { /* gone */ }
  await Bun.sleep(150);
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + "/control", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const result = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + "/control/result", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
/** Wait for a frame that carries an id: the command is parked server-side by then. */
async function ridOf(w: Win): Promise<string> {
  for (let i = 0; i < 50; i++) { const f = w.frames.find((x) => x.rid); if (f) return f.rid!; await Bun.sleep(40); }
  throw new Error("no frame with a request id arrived");
}

describe("a read", () => {
  test("with no window attached is a 503 'no window'", async () => {
    const r = await post({ cmd: "ui", do: "ui.state" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: "no window" });
  });

  test("waits for the window's answer and hands it to the caller, with no id needed", async () => {
    const w = await window_();
    const asked = post({ cmd: "ui", do: "ui.read", args: { panel: "chat" } });
    const rid = await ridOf(w);
    expect(w.frames[0]!.data).toEqual({ cmd: "ui", do: "ui.read", args: { panel: "chat" } });
    const value = { state: { count: 0 }, untrusted: {} };
    expect(await (await result({ rid, ok: true, applied: true, value })).json()).toEqual({ ok: true, known: true });
    const r = await asked;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, applied: true, value });
  });

  test("a read the registry does not have, or with a bad panel, is a 400 before any window is asked", async () => {
    const w = await window_();
    expect((await post({ cmd: "ui", do: "ui.read", args: { panel: "../secrets" } })).status).toBe(400);
    expect((await post({ cmd: "ui", do: "ui.read" })).status).toBe(400);
    expect(w.frames).toEqual([]);
  });
});

describe("a command with an id", () => {
  test("gets {ok, applied} back, and its own id echoed as a label (the wire id is the server's)", async () => {
    const w = await window_();
    const asked = post({ cmd: "ui", do: "settings.open", args: { page: "appearance" }, id: "my-req.1" });
    const rid = await ridOf(w);
    expect(rid).not.toBe("my-req.1");
    await result({ rid, ok: true, applied: true });
    expect(await (await asked).json()).toEqual({ ok: true, applied: true, id: "my-req.1" });
  });

  test("a window that could not run it says so", async () => {
    const w = await window_();
    const asked = post({ cmd: "ui", do: "bench.toggle", id: "x" });
    await result({ rid: await ridOf(w), ok: false, applied: false, error: "this window does not know that door" });
    expect(await (await asked).json()).toMatchObject({ ok: false, applied: false, error: "this window does not know that door", id: "x" });
  });

  test("an id that is not a slug is a label nobody can use, so the command is fire-and-forget", async () => {
    const w = await window_();
    const r = await post({ cmd: "ui", do: "bench.toggle", id: "has space" });
    expect(await r.json()).toMatchObject({ ok: true, windows: 1 });
    await Bun.sleep(100);
    expect(w.frames[0]!.rid).toBeUndefined();
  });
});

describe("an open with no id", () => {
  test("is still fire-and-forget: it answers at once and its frame carries no request id", async () => {
    const w = await window_();
    const r = await post({ cmd: "ui", do: "bench.toggle" });
    expect(await r.json()).toMatchObject({ ok: true, windows: 1 });
    await Bun.sleep(100);
    expect(w.frames).toEqual([{ data: { cmd: "ui", do: "bench.toggle", args: {} } }]);
  });
});

describe("POST /control/result", () => {
  test("two windows answering one ask: the first settles it, the second is ignored", async () => {
    const a = await window_();
    const b = await window_();
    const asked = post({ cmd: "ui", do: "ui.state" });
    const rid = await ridOf(a);
    await ridOf(b);
    expect(await (await result({ rid, ok: true, applied: true, value: "from-a" })).json()).toEqual({ ok: true, known: true });
    expect(await (await result({ rid, ok: true, applied: true, value: "from-b" })).json()).toEqual({ ok: true, known: false });
    expect(await (await asked).json()).toMatchObject({ value: "from-a" });
  });

  test("an id nobody was given settles nothing", async () => {
    expect(await (await result({ rid: "c1-guess", ok: true, applied: true })).json()).toEqual({ ok: true, known: false });
  });

  test("a body that is not a reply is a 400", async () => {
    expect((await result([1, 2])).status).toBe(400);
    expect((await result("x")).status).toBe(400);
  });

  test("a page on another origin is refused", async () => {
    expect((await result({ rid: "c1-x", ok: true, applied: true }, { Origin: "https://evil.example" })).status).toBe(403);
  });

  test("a reply carrying a token has it stripped on the way to the agent", async () => {
    const w = await window_();
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const asked = post({ cmd: "ui", do: "ui.state" });
    await result({ rid: await ridOf(w), ok: true, applied: true, value: { untrusted: { cmd: `curl -H "Authorization: ${token}"` } } });
    expect(JSON.stringify(await (await asked).json())).not.toContain(token);
  });
});

describe("the audit line", () => {
  test("names the door and the verdict, written when the answer came, and never the value", async () => {
    const w = await window_();
    const asked = post({ cmd: "ui", do: "ui.read", args: { panel: "gates" } });
    await result({ rid: await ridOf(w), ok: true, applied: true, value: { state: { count: 3 }, untrusted: { gates: [{ summary: "rm -rf /home/ana/orbit" }] } } });
    await asked;
    const log = await (await fetch(base + "/actions?limit=50")).json() as { actions: { action: string; ok: boolean; target: string | null; detail: string | null }[] };
    const line = log.actions.find((a) => a.action === "/control/ui.read");
    expect(line).toBeDefined();
    expect(line!.ok).toBe(true);
    expect(JSON.stringify(log)).not.toContain("rm -rf");
    expect(JSON.stringify(log)).not.toContain("gates");
  });
});
