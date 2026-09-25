/*
 * Who may become the window an ask is delivered to.
 *
 * Registering decides who receives every ask, fill text and URLs included. It
 * used to be open to anything that held the machine token, which every agent
 * shell does: one `hello` on /stream plus one POST /browser/ready made a
 * newest registration that took every ask and left the real window idle, with
 * no sign to the person. Now the route asks for the desktop app's key where the
 * app started the server, and an Origin where it did not.
 *
 * Real servers and real sockets: the takeover was a sequence across a socket
 * and a route, and a source read shows neither.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { DESK_HEADER } from "../src/desk.ts";

const SERVER_SRC = new URL("../src/index.ts", import.meta.url).pathname;
const KEY = "k".repeat(64);
const index = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
const api = await Bun.file(new URL("../../web/src/lib/api.ts", import.meta.url).pathname).text();
const dirs: string[] = [];
const procs: Array<{ kill: () => unknown }> = [];
const sockets: WebSocket[] = [];

afterAll(() => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
});

/** A server on its own port and data dir; `desk` starts it the way the app does. */
async function boot(desk: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agx-winreg-"));
  dirs.push(dir);
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
    XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
    AGENTGLASS_STATE_DIR: dir, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
    AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
  };
  if (desk) env.AGENTGLASS_DESK_FD = `3:${process.pid}`;
  const child = spawn("bun", ["run", SERVER_SRC], { env, stdio: ["ignore", "ignore", "pipe", "pipe"] });
  procs.push(child);
  const pipe = child.stdio[3] as Writable;
  pipe.on("error", () => { /* the server went away before reading it */ });
  pipe.end(desk ? `${KEY}\n` : "");
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return base; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
}

async function window(base: string, hello: string | null): Promise<{ frames: any[]; ws: WebSocket }> {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  const frames: any[] = [];
  ws.addEventListener("message", (ev) => {
    try { const f = JSON.parse(String((ev as MessageEvent).data)); if (f.type === "browser") frames.push(f); } catch { /* not json */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  if (hello) ws.send(JSON.stringify({ type: "hello", clientId: hello, browser: true }));
  return { frames, ws };
}

/** Answers every ask the window is sent, as the panel does. */
function answering(base: string, w: { ws: WebSocket }, client: string, key: string | null): void {
  w.ws.addEventListener("message", (ev) => {
    const f = JSON.parse(String((ev as MessageEvent).data));
    if (f.type !== "browser") return;
    void fetch(base + "/browser/result", {
      method: "POST", headers: { "content-type": "application/json", Origin: base, ...(key ? { [DESK_HEADER]: key } : {}) },
      body: JSON.stringify({ client, id: f.data.id, ok: true, value: "answered-by-" + client }),
    });
  });
}

const ready = (base: string, client: string, headers: Record<string, string>) =>
  fetch(base + "/browser/ready", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ client, on: true }) });

const tabs = (base: string) =>
  fetch(base + "/browser/tabs", { method: "POST", headers: { "content-type": "application/json", Origin: base }, body: JSON.stringify({ as: "orbit" }) })
    .then((r) => r.json() as Promise<any>);

describe("a server the desktop app started", () => {
  test("registering needs the app's key; a forger that registers later does not take the asks", async () => {
    const base = await boot(true);
    const desk = await window(base, "w-real");
    answering(base, desk, "w-real", KEY);
    expect((await ready(base, "w-real", { Origin: base, [DESK_HEADER]: KEY })).status).toBe(200);
    await Bun.sleep(20);

    const evil = await window(base, "w-evil");
    // The machine token is not the key, and neither is an Origin: both are what an agent shell has.
    expect((await ready(base, "w-evil", { Origin: base })).status).toBe(403);
    expect((await ready(base, "w-evil", {})).status).toBe(403);
    expect((await ready(base, "w-evil", { Origin: base, [DESK_HEADER]: "x".repeat(64) })).status).toBe(403);
    await Bun.sleep(20);

    const r = await tabs(base);
    expect(r.ok).toBe(true);
    expect(r.value ?? r).toBeDefined();
    expect(desk.frames).toHaveLength(1);
    expect(evil.frames).toHaveLength(0);
  }, SERVER_BOOT_MS + 15_000);
});

describe("a server started by hand", () => {
  test("an Origin-less caller cannot register; the app's own Origin can", async () => {
    const base = await boot(false);
    expect((await ready(base, "w-bare", {})).status).toBe(403);
    expect((await ready(base, "w-app", { Origin: base })).status).toBe(200);
  }, SERVER_BOOT_MS + 15_000);
});


describe("the renderer side", () => {
  test("the renderer carries the desk key on /browser/ready", () => {
    expect(api).toMatch(/browserReady: \(client: string, on: boolean, lanes: string\[\] = \[\]\) => post<[^\n]*"\/browser\/ready", \{ client, on, lanes \}, deskHeader\(\)\)/);
  });
});

describe("naming a socket", () => {
  test("a socket names itself once: a second hello does not rename it, so it cannot squat on another id", async () => {
    const base = await boot(true);
    const w = await window(base, "w-first");
    answering(base, w, "w-first", KEY);
    w.ws.send(JSON.stringify({ type: "hello", clientId: "w-second", browser: true }));
    await Bun.sleep(100);
    expect((await ready(base, "w-second", { [DESK_HEADER]: KEY })).status).toBe(200);
    // w-second was never bound to a socket, so the ask is refused at once rather than delivered to w-first.
    const r = await tabs(base);
    expect(r.ok).toBe(false);
    expect(w.frames).toHaveLength(0);
  }, SERVER_BOOT_MS + 15_000);
});

describe("hello before ask, at runtime", () => {
  test("a window that says hello and registers in the same breath is asked", async () => {
    const base = await boot(true);
    const w = await window(base, "w-fast");
    answering(base, w, "w-fast", KEY);
    await ready(base, "w-fast", { [DESK_HEADER]: KEY });   // no pause after the hello
    const r = await tabs(base);
    expect(r.ok).toBe(true);
    expect(w.frames).toHaveLength(1);
  }, SERVER_BOOT_MS + 15_000);

  test("a registration that lands before its socket is named heals on the server's retry", async () => {
    const base = await boot(true);
    await window(base, null);   // the retry is only worth waiting for while somebody is connected
    expect((await ready(base, "w-slow", { [DESK_HEADER]: KEY })).status).toBe(200);
    const pending = tabs(base);
    await Bun.sleep(100);                                  // the ask is refused once, then retried
    const w = await window(base, "w-slow");
    answering(base, w, "w-slow", KEY);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(w.frames).toHaveLength(1);
  }, SERVER_BOOT_MS + 15_000);
});

describe("the parts a test server cannot show (read as source)", () => {
  test("a paired device's socket cannot name itself as a browser window", () => {
    const at = index.indexOf('if (f.type === "hello"');
    const end = index.indexOf("}", index.indexOf("browserSockets.set(f.clientId, ws)", at));
    expect(at).toBeGreaterThan(0);
    expect(index.slice(at, end)).toContain("!ws.data?.deviceId");
  });
});
