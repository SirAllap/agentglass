/*
 * An ask reaches ONE window, not every socket.
 *
 * It used to be broadcast, fill and type text included, to every `/stream`
 * client: a paired phone or a dashboard tab in an ordinary browser received the
 * text an agent typed into a page. Now a window names itself on /stream
 * (`hello`) and in /browser/ready, and the relay addresses the ask to that name.
 *
 * Real server, real sockets: the leak was in what a second socket received, and
 * a stubbed sink cannot show that.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { noteBrowserReady, resetBrowserDrive, askBrowser, parseAsk, setBrowserSink, settleBrowser, dropBrowserTarget } from "../src/browserdrive.ts";

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-addr-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: dir, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** A `/stream` client that records every `browser` frame it is sent. */
async function client(hello: string | null): Promise<{ frames: any[]; ws: WebSocket }> {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  const frames: any[] = [];
  ws.addEventListener("message", (ev) => {
    try { const f = JSON.parse(String((ev as MessageEvent).data)); if (f.type === "browser") frames.push(f); } catch { /* not json */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  if (hello) ws.send(JSON.stringify({ type: "hello", clientId: hello, browser: true }));
  await Bun.sleep(100);
  return { frames, ws };
}

const post = (path: string, body: unknown) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", Origin: base }, body: JSON.stringify(body),
});

/** Ask through the HTTP relay, as the CLI does. */
const ask = (op: string, body: Record<string, unknown>) =>
  post("/browser/" + op, body).then((r) => r.json() as Promise<any>);

describe("addressed delivery", () => {
  test("only the registered window gets the ask; a phone and a dashboard tab see nothing", async () => {
    const desk = await client("w-desk");
    const phone = await client(null);          // never says hello, like the mobile app
    const tab = await client("w-dashboard");   // says hello, never registers a panel
    await post("/browser/ready", { client: "w-desk", on: true });
    desk.ws.addEventListener("message", (ev) => {
      const f = JSON.parse(String((ev as MessageEvent).data));
      if (f.type === "browser") void post("/browser/result", { client: "w-desk", id: f.data.id, ok: true, value: "typed" });
    });
    const r = await ask("fill", { fields: { "#note": "quarterly plan" }, as: "orbit" });
    expect(r.ok).toBe(true);
    expect(desk.frames).toHaveLength(1);
    expect(phone.frames).toHaveLength(0);
    expect(tab.frames).toHaveLength(0);
    await post("/browser/ready", { client: "w-desk", on: false });
  });

  test("a reconnect under the same name takes over, and the dead socket is not asked", async () => {
    const first = await client("w-flaky");
    await post("/browser/ready", { client: "w-flaky", on: true });
    const second = await client("w-flaky");
    second.ws.addEventListener("message", (ev) => {
      const f = JSON.parse(String((ev as MessageEvent).data));
      if (f.type === "browser") void post("/browser/result", { client: "w-flaky", id: f.data.id, ok: true, value: "x" });
    });
    const r = await ask("tabs", { as: "orbit" });
    expect(r.ok).toBe(true);
    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(1);
    await post("/browser/ready", { client: "w-flaky", on: false });
  });

  test("registered but never connected says so at once instead of timing out", async () => {
    await post("/browser/ready", { client: "w-ghost", on: true });
    const t0 = Date.now();
    const r = await ask("tabs", { as: "orbit" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not open");
    expect(Date.now() - t0).toBeLessThan(5000);
    await post("/browser/ready", { client: "w-ghost", on: false });
  });
});

describe("who is picked (relay, no sockets)", () => {
  test("the newest window with no lanes takes the ask; a lane host only its own lane; expiry re-routes", async () => {
    const sent: string[] = [];
    setBrowserSink({
      send: (a, to) => { sent.push(to); queueMicrotask(() => settleBrowser(a.id, { ok: true, value: 1 })); },
      listeners: () => 2,
    });
    noteBrowserReady("older", true);
    await Bun.sleep(5);
    noteBrowserReady("newer", true);
    await Bun.sleep(5);
    noteBrowserReady("older", true);   // a heartbeat must not promote it
    noteBrowserReady("host", true, ["a-lane"]);
    const run = (body: Record<string, unknown>) => {
      const p = parseAsk("tabs", body);
      if ("error" in p) throw new Error(p.error);
      return askBrowser(p.ask);
    };
    await run({ as: "orbit" });
    expect(sent).toEqual(["newer"]);
    noteBrowserReady("newer", false);
    await run({ as: "orbit" });
    expect(sent).toEqual(["newer", "older"]);
    resetBrowserDrive();
  });

  test("a window whose heartbeat expired stops being picked, and the next one is", async () => {
    const sent: string[] = [];
    setBrowserSink({
      send: (a, to) => { sent.push(to); queueMicrotask(() => settleBrowser(a.id, { ok: true, value: 1 })); },
      listeners: () => 2,
    });
    const real = Date.now;
    try {
      Date.now = () => real() - 120_000;   // registered two minutes ago: past the 90 s TTL
      noteBrowserReady("stale-newest", true);
    } finally { Date.now = real; }
    noteBrowserReady("fresh", true);
    const p = parseAsk("tabs", { as: "orbit" });
    if ("error" in p) throw new Error(p.error);
    await askBrowser(p.ask);
    expect(sent).toEqual(["fresh"]);
    resetBrowserDrive();
  });

  test("a newer registration with no live socket loses to an older one that has one", async () => {
    const sent: string[] = [];
    const alive = new Set(["healthy"]);
    setBrowserSink({
      send: (a, to) => { sent.push(to); queueMicrotask(() => settleBrowser(a.id, { ok: true, value: 1 })); },
      listeners: () => 1,
      live: (id) => alive.has(id),
    });
    noteBrowserReady("healthy", true);
    await Bun.sleep(5);
    noteBrowserReady("crashed", true);   // newest, but its socket is gone (or never existed)
    const p = parseAsk("tabs", { as: "orbit" });
    if ("error" in p) throw new Error(p.error);
    expect((await askBrowser(p.ask)).ok).toBe(true);
    expect(sent).toEqual(["healthy"]);
    resetBrowserDrive();
  });
});

describe("who may answer", () => {
  test("ids are not counted, and only the addressed window's answer settles an ask", async () => {
    let seen = "";
    setBrowserSink({ send: (a) => { seen = a.id; }, listeners: () => 1 });
    noteBrowserReady("owner", true);
    const p = parseAsk("tabs", { as: "orbit" });
    if ("error" in p) throw new Error(p.error);
    const pending = askBrowser(p.ask);
    await Bun.sleep(5);
    expect(seen).not.toMatch(/^b\d+$/);
    expect(settleBrowser(seen, { ok: true, value: "forged" }, "someone-else")).toBe(false);
    expect(settleBrowser(seen, { ok: true, value: "real" }, "owner")).toBe(true);
    expect((await pending).value).toBe("real");
    resetBrowserDrive();
  });

  test("a window that closes mid-ask settles it at once", async () => {
    setBrowserSink({ send: () => {}, listeners: () => 1 });
    noteBrowserReady("owner", true);
    const p = parseAsk("tabs", { as: "orbit" });
    if ("error" in p) throw new Error(p.error);
    const pending = askBrowser(p.ask);
    await Bun.sleep(5);
    dropBrowserTarget("owner");
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("closed before answering");
    resetBrowserDrive();
  });
});
