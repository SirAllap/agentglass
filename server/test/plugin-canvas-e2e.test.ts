/*
 * A live canvas, end to end, against a real server: two real plugin processes
 * with real tokens, a window's socket, and every attempt a hostile plugin has.
 *
 * "big" declares scope full on purpose: it is the plugin the old refusal (by
 * scope) would have let read everything. "small" is a read-scope neighbour
 * whose scene must stay out of reach of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { CANVAS_LIMITS, loopingIds, validateScene, type CanvasScene } from "../../shared/pluginCanvas.ts";
import { FLUSH_MS } from "../src/plugin-canvas.ts";

let dir: string, base: string, port: number, proc: ReturnType<typeof Bun.spawn> | null = null;
type Json = Record<string, any>;

const PANELS = Array.from({ length: 8 }, (_, i) => ({ id: i === 0 ? "board" : `extra${i}`, title: `Board ${i}`, canvas: true }));
const manifest = (name: string, scope: string, panels: unknown[]) => ({
  name, publisher: "acme", description: "Draws a live board.", entrypoint: `bun run plugin.js agx-canvas-marker-${name}`, scope,
  contributes: { panels },
});

// Writes its own token where the test can reach it (a hostile plugin has it
// anyway), draws one label, then answers events until it is stopped.
const PLUGIN = `
const base = process.env.AGENTGLASS_URL, token = process.env.AGENTGLASS_READ_TOKEN;
const h = { "Content-Type": "application/json", Authorization: "Bearer " + token };
require("fs").writeFileSync("token.txt", token);
const me = await (await fetch(base + "/plugin/self", { headers: h })).json();
await fetch(base + "/plugin/self/panel/board/ops", { method: "POST", headers: h, body: JSON.stringify({ ops: [{ op: "add", node: { id: "hello", type: "label", text: "hello from " + me.name } }] }) });
for (;;) {
  const res = await fetch(base + "/plugin/self/events?wait=5000", { headers: h }).catch(() => null);
  if (res && (res.status === 401 || res.status === 403)) process.exit(0);
  if (!res) await Bun.sleep(300);
}
`;

async function boot(): Promise<void> {
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
      NODE_ENV: "test", AGENTGLASS_BWRAP: "/nonexistent/bwrap", AGENTGLASS_PLUGINS_UNBOXED: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

const post = (p: string, b: unknown, token?: string) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof b === "string" ? b : JSON.stringify(b) });
const ops = (token: string, panel: string, list: unknown[], extra: Json = {}) => post(`/plugin/self/panel/${panel}/ops`, { ops: list, ...extra }, token);
const tokenOf = (name: string) => readFileSync(join(dir, "agentglass", "plugins", name, "token.txt"), "utf8");
const add = (id: string, extra: Json = {}) => ({ op: "add", node: { id, type: "label", text: id, ...extra } });

/** The window: an unauthenticated loopback caller, exactly what the desktop app is. */
function openWindow(headers?: Record<string, string>): Promise<{ ws: WebSocket; frames: Json[]; next: (pred: (f: Json) => boolean, ms?: number) => Promise<Json> }> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugins/panels/live`, { headers } as never);
    const frames: Json[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    ws.onerror = () => rej(new Error("socket refused"));
    ws.onopen = () => res({
      ws, frames,
      next: async (pred, ms = 5000) => {
        for (let t = 0; t < ms; t += 25) { const f = frames.find(pred); if (f) return f; await Bun.sleep(25); }
        throw new Error("no such frame: " + JSON.stringify(frames).slice(0, 300));
      },
    });
  });
}
const refused = (headers?: Record<string, string>) => openWindow(headers).then((w) => { w.ws.close(); return false; }, () => true);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-plugin-canvas-"));
  for (const [name, scope, panels] of [["big", "full", PANELS], ["small", "read", [{ id: "board", title: "Small", canvas: true }, { id: "still", title: "Still" }]]] as const) {
    const src = join(dir, `src-${name}`);
    mkdirSync(src);
    writeFileSync(join(src, "plugin.json"), JSON.stringify(manifest(name, scope, panels as unknown[])));
    writeFileSync(join(src, "plugin.js"), PLUGIN);
  }
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  for (const name of ["big", "small"]) {
    const inst = (await (await post("/plugins/install", { source: join(dir, `src-${name}`) })).json()) as Json;
    if (!inst.ok) throw new Error("install failed: " + JSON.stringify(inst));
    const en = (await (await post("/plugins/enable", { name })).json()) as Json;
    if (!en.ok) throw new Error("enable failed: " + JSON.stringify(en));
  }
  for (const name of ["big", "small"]) for (let i = 0; i < 100 && !existsSync(join(dir, "agentglass", "plugins", name, "token.txt")); i++) await Bun.sleep(100);
  // The token file exists before the plugin has drawn anything, and what it
  // draws then sits in the server's coalescing window for FLUSH_MS. A test that
  // started inside that window had its own first operations joined to the
  // plugin's draw, a frame that began before the snapshot the window already
  // held, so the window was sent a second snapshot instead of the "ops" frame
  // the test waits for: 5 s of silence, the test's timeout, and bun kills the
  // server it spawned for the 15 tests after it. Start from a scene that has
  // been drawn and flushed.
  for (const name of ["big", "small"]) {
    const w = await openWindow();
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: name, panel: "board" }));
    await w.next((f) => f.plugin === name && ((f.type === "snapshot" && f.scene.length > 0) || f.type === "ops"));
    w.ws.close();
  }
  await Bun.sleep(FLUSH_MS + 50);
}, SERVER_BOOT_MS);

afterAll(async () => {
  for (const name of ["big", "small"]) { try { await post("/plugins/disable", { name }); } catch { /* server gone */ } }
  const p = proc;
  proc = null;
  try { p?.kill(); } catch { /* already gone */ }
  await p?.exited;
  const left = Bun.spawnSync(["pgrep", "-f", "agx-canvas-marker-"]).stdout.toString().trim();
  if (left) { Bun.spawnSync(["kill", ...left.split("\n")]); throw new Error(`plugin processes outlived the server: ${left}`); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("the window sees what a plugin draws, live", () => {
  test("a snapshot on subscribe, then the plugin's operations as they happen", async () => {
    const w = await openWindow();
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: "big", panel: "board" }));
    const snap = await w.next((f) => f.type === "snapshot" && f.plugin === "big");
    expect(snap.scene.map((n: Json) => n.text)).toEqual(["hello from big"]);
    expect(snap.running).toBe(true);
    const r = await ops(tokenOf("big"), "board", [add("second"), { op: "set", id: "second", props: { tone: "success" } }]);
    expect(r.status).toBe(200);
    const f = await w.next((x) => x.type === "ops" && x.plugin === "big");
    expect(f.ops.map((o: Json) => o.op)).toEqual(["add", "set"]);
    expect(f.to).toBe(f.from + 2 - 1);
    w.ws.close();
  });

  test("eight panels on one socket, and an ordinary request still answers at once", async () => {
    const w = await openWindow();
    for (const p of PANELS) w.ws.send(JSON.stringify({ type: "subscribe", plugin: "big", panel: p.id }));
    for (const p of PANELS) await w.next((f) => f.type === "snapshot" && f.panel === p.id);
    const t0 = performance.now();
    expect((await fetch(base + "/health")).status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1000);
    w.ws.close();
  });

  test("a stopped plugin's panel is `gone`, and its scene does not outlive it", async () => {
    const w = await openWindow();
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: "small", panel: "board" }));
    await w.next((f) => f.type === "snapshot" && f.plugin === "small");
    await post("/plugins/disable", { name: "small" });
    await w.next((f) => f.type === "gone" && f.plugin === "small");
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: "small", panel: "board" }));
    await w.next((f) => f.type === "gone" && f.plugin === "small" && w.frames.filter((x) => x.type === "gone").length >= 2);
    expect(JSON.stringify(w.frames)).not.toContain("hello from small\"]");
    w.ws.close();
    await post("/plugins/enable", { name: "small" });
    for (let i = 0; i < 100; i++) { const r = await ops(tokenOf("small"), "board", [add("back")]).catch(() => null); if (r?.status === 200) break; await Bun.sleep(100); }
  });
});

describe("a plugin cannot reach what is not its own", () => {
  test("its token does not open the live socket, whatever scope it declared", async () => {
    for (const name of ["big", "small"]) expect(await refused({ Authorization: `Bearer ${tokenOf(name)}` }), name).toBe(true);
  });

  test("nor read the drawn panels or settings of the others; the full-scope one is the case that used to pass", async () => {
    for (const name of ["big", "small"]) {
      for (const p of ["/plugins/panels", "/plugins/settings", "/plugins/panels/live"]) {
        const r = await fetch(base + p, { headers: { Authorization: `Bearer ${tokenOf(name)}` } });
        expect(r.status, `${name} ${p}`).toBe(403);
      }
      expect((await post("/plugins/settings", { plugin: "small", values: {} }, tokenOf(name))).status, `${name} POST settings`).toBe(403);
    }
  });

  test("the name comes from the token: `small` cannot draw on `big`'s panels, and a panel it did not declare as a canvas is refused", async () => {
    const t = tokenOf("small");
    expect((await ops(t, "extra1", [add("x")])).status).toBe(400);
    expect((await ops(t, "still", [add("x")])).status).toBe(400);
    expect((await ops(t, "nope", [add("x")])).status).toBe(400);
    expect((await post("/plugin/self/panel", { id: "board", tree: { type: "divider" } }, t)).status).toBe(400);
    expect((await post("/plugin/self/panel/board/ops", { ops: [add("x")] })).status).toBe(403);
  });
});

describe("a plugin that is stopped while it is still sending", () => {
  test("the batch that finishes arriving afterwards is refused, and the next run starts on an empty board", async () => {
    const t = tokenOf("small");
    const body = JSON.stringify({ ops: [add("ghost")] });
    let send!: (chunk: string) => void, end!: () => void;
    const stream = new ReadableStream<Uint8Array>({ start(ctl) { send = (c) => ctl.enqueue(new TextEncoder().encode(c)); end = () => ctl.close(); } });
    const inflight = fetch(`${base}/plugin/self/panel/board/ops`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    send(body.slice(0, 10));
    await Bun.sleep(300);
    await post("/plugins/disable", { name: "small" });
    send(body.slice(10));
    end();
    expect((await inflight).status).toBe(403);
    // The next run: the plugin draws only its own hello.
    rmSync(join(dir, "agentglass", "plugins", "small", "token.txt"), { force: true });
    await post("/plugins/enable", { name: "small" });
    for (let i = 0; i < 100 && !existsSync(join(dir, "agentglass", "plugins", "small", "token.txt")); i++) await Bun.sleep(100);
    const w = await openWindow();
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: "small", panel: "board" }));
    const snap = await w.next((f) => f.type === "snapshot" && f.plugin === "small" && f.scene.length > 0);
    w.ws.close();
    expect(snap.scene.map((n: Json) => n.id)).toEqual(["hello"]);
  });
});

describe("exploit attempts against the scene", () => {
  test("script, style, URLs, markdown, prototype tricks: every one refused, and the scene is untouched", async () => {
    const t = tokenOf("big");
    const before = await (async () => { const w = await openWindow(); w.ws.send(JSON.stringify({ type: "subscribe", plugin: "big", panel: "board" })); const s = await w.next((f) => f.type === "snapshot" && f.plugin === "big"); w.ws.close(); return JSON.stringify(s.scene); })();
    const attacks: unknown[][] = [
      [add("x1", { style: "position:fixed;inset:0" })],
      [add("x1", { href: "javascript:alert(1)" })],
      [add("x1", { src: "http://127.0.0.1:4000/health" })],
      [add("x1", { onclick: "fetch('/x')" })],
      [{ op: "add", node: { id: "x1", type: "markdown", text: "![](http://127.0.0.1:1/beacon)" } }],
      [{ op: "add", node: { id: "x1", type: "link", href: "https://evil.example" } }],
      [{ op: "add", node: { id: "x1", type: "html", html: "<script>1</script>" } }],
      [{ op: "add", node: { id: "__proto__", type: "label", text: "x" } }],
      [{ op: "eval", code: "process.exit()" }],
      [add("ok-first"), add("x1", { tone: "javascript:1" })],
      [{ op: "add", node: { id: "g", type: "gauge", shape: "arc", value: 1e308, max: 1 } }],
      [{ op: "move", id: "hello", parent: "hello" }],
    ];
    for (const a of attacks) expect((await ops(t, "board", a)).status, JSON.stringify(a)).toBe(400);
    // Spelled as text: an object literal's `__proto__:` sets a prototype and never reaches the wire.
    const raw = '{"ops":[{"op":"add","node":{"id":"x1","type":"label","text":"x","__proto__":{"polluted":true}}}]}';
    expect((await post("/plugin/self/panel/board/ops", raw, t)).status).toBe(400);
    expect((await post("/plugin/self/panel/board/ops", '{"ops":[{"op":"add","node":{"id":"x1","type":"label","text":"x","constructor":{"prototype":{"polluted":true}}}}]}', t)).status).toBe(400);
    const w = await openWindow();
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: "big", panel: "board" }));
    const after = await w.next((f) => f.type === "snapshot" && f.plugin === "big");
    w.ws.close();
    expect(JSON.stringify(after.scene)).toBe(before);
    expect(({} as Json).polluted).toBeUndefined();
  });

  test("a body over the cap is 413 without the server parsing it, and the server is still answering", async () => {
    const t = tokenOf("big");
    const huge = JSON.stringify({ ops: [add("h", { text: "x".repeat(70 * 1024) })] });
    const r = await post("/plugin/self/panel/board/ops", huge, t);
    expect(r.status).toBe(413);
    // The big one goes through curl: Bun 1.3.9's own fetch client hangs the
    // whole test process (and the server looks gone) when the answer comes
    // before it has finished sending 8 MB, on any route, the old ones too.
    const f = join(dir, "wide.txt");
    writeFileSync(f, "[".repeat(8 * 1024 * 1024));
    const wide = Bun.spawnSync(["curl", "-s", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", `Authorization: Bearer ${t}`, "--data-binary", `@${f}`, `${base}/plugin/self/panel/board/ops`]);
    expect(wide.stdout.toString()).toBe("413");
    // No declared length, so the reader has to count: chunked.
    const chunked = Bun.spawnSync(["curl", "-s", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", `Authorization: Bearer ${t}`, "-H", "Transfer-Encoding: chunked", "--data-binary", `@${f}`, `${base}/plugin/self/panel/board/ops`]);
    expect(chunked.stdout.toString()).toBe("413");
    expect((await fetch(base + "/health")).status).toBe(200);
  });

  test("more operations than the budget is 429 with a wait, then the plugin may go on", async () => {
    const t = tokenOf("big");
    let status = 0, retry = 0;
    for (let i = 0; i < 12 && status !== 429; i++) {
      const r = await ops(t, "board", Array.from({ length: 100 }, (_, j) => ({ op: "set", id: "hello", props: { text: `n${i}-${j}` } })));
      status = r.status;
      if (status === 429) retry = ((await r.json()) as Json).retryAfterMs;
    }
    expect(status).toBe(429);
    expect(retry).toBeGreaterThan(0);
    await Bun.sleep(Math.min(retry + 50, 3000));
    expect((await ops(t, "board", [{ op: "set", id: "hello", props: { text: "calm" } }])).status).toBe(200);
  });

  test("an empty batch is not free: a loop of them is refused too", async () => {
    const t = tokenOf("small");
    let status = 0;
    for (let i = 0; i < 400 && status !== 429; i++) status = (await ops(t, "board", [])).status;
    expect(status).toBe(429);
  });
});

describe("the board vocabulary against the same real server", () => {
  const t = () => tokenOf("big");
  const node = (n: Json) => ({ op: "add", node: n });
  // A refused batch is 400 whatever the token bucket holds: a 429 is waited out and sent again.
  async function fire(list: unknown[], raw?: string): Promise<number> {
    for (let i = 0; i < 20; i++) {
      const r = raw ? await post("/plugin/self/panel/board/ops", raw, t()) : await ops(t(), "board", list);
      if (r.status !== 429) return r.status;
      await Bun.sleep(Math.min(((await r.json()) as Json).retryAfterMs + 50, 3000));
    }
    throw new Error("still rate limited");
  }
  async function scene(): Promise<CanvasScene> {
    const w = await openWindow();
    w.ws.send(JSON.stringify({ type: "subscribe", plugin: "big", panel: "board" }));
    const s = await w.next((f) => f.type === "snapshot" && f.plugin === "big");
    w.ws.close();
    return s.scene;
  }
  const BOARD = { id: "line", type: "board", w: 1180, h: 560 };
  const part = (id: string, x: number) => ({ id, type: "part", parent: "line", x, y: 40, w: 300, h: 200 });

  test("a machine is accepted: board, parts, a bay of tokens, a trace with points", async () => {
    expect(await fire([{ op: "clear" }, node(BOARD), node(part("inbox", 40)), node(part("queue", 500)),
      node({ id: "slots", type: "bay", parent: "queue", cols: 4, rows: 3 }), node({ id: "slots2", type: "bay", parent: "inbox", cols: 2, rows: 2 }),
      node({ id: "wire", type: "edge", parent: "line", from: "inbox", to: "queue", kind: "trace", points: [[340, 140], [420, 140], [420, 100], [500, 100]] }),
      node({ id: "n1", type: "token", label: "ORBIT-1042", parent: "slots2" })])).toBe(200);
    const s = await scene();
    expect(s.map((n) => n.id)).toEqual(["line", "inbox", "queue", "slots", "slots2", "wire", "n1"]);
    expect(validateScene(s).ok).toBe(true);
  });

  test("every attempt on the new types is 400, the scene is untouched and the server answers", async () => {
    const before = JSON.stringify(await scene());
    const pts = (points: unknown) => [node({ id: "e2", type: "edge", parent: "line", from: "inbox", to: "queue", points })];
    const attacks: unknown[][] = [];
    for (const [id, n] of [["b2", { type: "board", w: 400, h: 300 }], ["p2", part("p2", 0)], ["y2", { type: "bay", parent: "queue", cols: 1, rows: 1 }]] as const) {
      for (const k of ["style", "href", "onclick", "innerHTML", "constructor"]) attacks.push([node({ ...n, id, [k]: "x" })]);
    }
    attacks.push([{ op: "set", id: "inbox", props: { style: "position:fixed" } }], [{ op: "set", id: "line", props: { href: "javascript:1" } }], [{ op: "set", id: "slots", props: { onclick: "1" } }]);
    for (const points of [[[0, 0], [1e308, 1]], [["1", "2"], [3, 4]], [[[0, 0]], [[1, 1]]], Array.from({ length: 13 }, (_, i) => [i, i]), [[0, 0], [-1, 5]], [[0, 0], [1.5, 2]], [[0, 0]]]) attacks.push(pts(points));
    attacks.push([{ op: "set", id: "wire", props: { points: [[0, 0], [9, 9]].concat([[1e308, 0]]) } }]);
    attacks.push([node({ id: "e3", type: "edge", from: "inbox", to: "queue", points: [[0, 0], [9, 9]] })]); // points on a root edge
    attacks.push([node({ ...BOARD, id: "b3" }), node({ ...BOARD, id: "b4" })]); // a third board (the scene has one, two more)
    attacks.push([node({ ...part("p3", 0), parent: undefined })]); // a part at root
    attacks.push([node({ id: "lb", type: "label", text: "x" }), { op: "move", id: "lb", parent: "slots" }]); // a label moved into a bay
    attacks.push([{ op: "move", id: "slots", parent: "line" }], [{ op: "move", id: "slots", parent: null }]); // a bay out of its part
    attacks.push([node({ id: "pr", type: "press", parent: "line", activity: "busy" })], [node({ id: "tk", type: "token", label: "x", parent: "line" })]); // board children that are not part/edge
    attacks.push([node({ id: "c1", type: "core", parent: "inbox", unit: "\u202Ereq" })], [node({ id: "c2", type: "counter", parent: "inbox", label: "c", value: 1, unit: "\u200B" })]);
    attacks.push([node({ id: "g1", type: "gate", parent: "inbox", state: "open", max: 61 })]);
    attacks.push([node({ id: "y3", type: "bay", parent: "queue", cols: 13, rows: 5 })], [{ op: "set", id: "slots", props: { cols: 12, rows: 8 } }]);
    attacks.push([node({ id: "ok1", type: "label", text: "fine", parent: "inbox" }), node({ id: "bad1", type: "bay", parent: "line", cols: 1, rows: 1 })]); // atomic
    for (const a of attacks) expect(await fire(a), JSON.stringify(a)).toBe(400);
    // JSON null is what NaN becomes on the wire, and a prototype key only exists as text
    expect(await fire([], '{"ops":[{"op":"add","node":{"id":"e2","type":"edge","parent":"line","from":"inbox","to":"queue","points":[[0,0],[null,1]]}}]}')).toBe(400);
    expect(await fire([], '{"ops":[{"op":"add","node":{"id":"b9","type":"board","w":400,"h":300,"__proto__":{"polluted":1}}}]}')).toBe(400);
    expect(await fire([], '{"ops":[{"op":"add","node":{"id":"p9","type":"part","parent":"line","x":0,"y":0,"w":30,"h":30,"__proto__":{"polluted":1}}}]}')).toBe(400);
    expect(JSON.stringify(await scene())).toBe(before);
    expect(({} as Json).polluted).toBeUndefined();
    expect((await fetch(base + "/health")).status).toBe(200);
  });

  test("a snapshot a window would replay with a label in a bay is refused by name", async () => {
    const s = await scene();
    expect(validateScene(s).ok).toBe(true);
    const r = validateScene([...s, { id: "stray", type: "label", text: "no", parent: "slots" }]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("a bay holds only tokens");
    const r2 = validateScene([...s, { id: "p9", type: "part", x: 0, y: 0, w: 30, h: 30 }]);
    expect(r2.ok ? "" : r2.error).toContain("a part lives directly in a board");
  });

  test("70 busy cores are accepted and the loop budget still caps what runs", async () => {
    const cores = Array.from({ length: 70 }, (_, i) => node({ id: `core${i}`, type: "core", parent: "queue", activity: "busy" }));
    expect(await fire(cores.slice(0, 35))).toBe(200);
    expect(await fire(cores.slice(35))).toBe(200);
    const s = await scene();
    expect(s.filter((n) => n.type === "core").length).toBe(70);
    const on = loopingIds(s, false);
    expect(on.size).toBeLessThanOrEqual(CANVAS_LIMITS.loops);
    expect([...on].filter((id) => id.startsWith("core")).length).toBe(CANVAS_LIMITS.loops / 2);
    expect(loopingIds(s, true).size).toBe(0);
    expect(await fire([{ op: "remove", id: "core0" }])).toBe(200);
  });

  test("a batch of 100 rides on one edge is accepted and the scene does not grow", async () => {
    const nodes = (await scene()).length;
    const rides = Array.from({ length: 100 }, (_, i) => ({ op: "move", id: "n1", parent: i % 2 ? "slots2" : "slots", via: "wire", ms: 2000, easing: "ease-in-out" }));
    expect(await fire(rides)).toBe(200);
    const s = await scene();
    expect(s.length).toBe(nodes);
    expect(s.find((n) => n.id === "n1")?.parent).toBe("slots2");
    expect(await fire([...rides, rides[0]])).toBe(400); // 101 ops is over the batch cap
    expect((await fetch(base + "/health")).status).toBe(200);
  });
});
