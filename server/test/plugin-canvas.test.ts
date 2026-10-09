/*
 * The retained scene and its one door (server/src/plugin-canvas.ts), without a
 * server: who may send, how much, what is kept, and what a window is sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CANVAS_LIMITS } from "../../shared/pluginCanvas.ts";
import type { Contributes } from "../../shared/pluginUi.ts";
import { scopeNeeded } from "../src/auth.ts";
import {
  CanvasHandle, FLUSH_MS, OPS_BURST, OPS_PER_SECOND, SOCKET_BACKLOG_BYTES, SUBSCRIPTIONS_PER_SOCKET, __resetCanvases, applyCanvasOps,
  canvasSnapshot, dropCanvases, flushCanvases, readBoundedJson, setCanvasResolver, takeOps,
} from "../src/plugin-canvas.ts";

afterEach(__resetCanvases);

const c: Contributes = { panels: [{ id: "board", title: "Board", canvas: true }, { id: "other", title: "Other", canvas: true }, { id: "still", title: "Still" }] };
const add = (id: string, extra: Record<string, unknown> = {}) => ({ op: "add", node: { id, type: "label", text: id, ...extra } });

class FakeSocket {
  sent: any[] = [];
  backlog = 0;
  send(t: string) { this.sent.push(JSON.parse(t)); }
  buffered() { return this.backlog; }
  types() { return this.sent.map((f) => f.type); }
}
const live = (...canvas: [string, string][]) => setCanvasResolver((p, panel) => ({ canvas: canvas.some(([a, b]) => a === p && b === panel), running: true }));
const window_ = () => { const s = new FakeSocket(); return { s, h: new CanvasHandle(s) }; };
const sub = (h: CanvasHandle, plugin: string, panel: string) => h.message(JSON.stringify({ type: "subscribe", plugin, panel }));

describe("what a plugin may send", () => {
  test("only to a panel its manifest declared as a canvas", () => {
    expect(applyCanvasOps("a", c, "nope", { ops: [add("x")] }).ok).toBe(false);
    expect(applyCanvasOps("a", c, "still", { ops: [add("x")] }).ok).toBe(false);
    expect(applyCanvasOps("a", c, "board", { ops: [add("x")] }).ok).toBe(true);
  });

  test("the server owns version and epoch; a retried seq is not applied twice", () => {
    const a = applyCanvasOps("a", c, "board", { seq: 7, ops: [add("x")] });
    expect(a).toMatchObject({ ok: true, version: 1, applied: true });
    const again = applyCanvasOps("a", c, "board", { seq: 7, ops: [add("x")] });
    expect(again).toMatchObject({ ok: true, version: 1, applied: false });
    const next = applyCanvasOps("a", c, "board", { seq: 8, ops: [add("y")] });
    expect(next).toMatchObject({ ok: true, version: 2, applied: true });
    expect(canvasSnapshot("a", "board").scene.map((n) => n.id)).toEqual(["x", "y"]);
    // A seq that goes backwards is just a batch: the plugin restarted its count.
    expect(applyCanvasOps("a", c, "board", { seq: 0, ops: [add("z")] })).toMatchObject({ ok: true, applied: true });
    for (const bad of [-1, 1.5, "3", NaN, 2 ** 60]) expect(applyCanvasOps("a", c, "board", { seq: bad, ops: [] }).ok, String(bad)).toBe(false);
  });

  test("a refused batch changes nothing, not even the version", () => {
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    const before = canvasSnapshot("a", "board");
    expect(applyCanvasOps("a", c, "board", { ops: [add("y"), { op: "set", id: "x", props: { style: "x" } }] }).ok).toBe(false);
    expect(canvasSnapshot("a", "board")).toEqual(before);
  });

  test("two plugins with the same panel name have two scenes", () => {
    applyCanvasOps("a", c, "board", { ops: [add("mine")] });
    applyCanvasOps("b", c, "board", { ops: [add("theirs")] });
    expect(canvasSnapshot("a", "board").scene.map((n) => n.id)).toEqual(["mine"]);
    expect(canvasSnapshot("b", "board").scene.map((n) => n.id)).toEqual(["theirs"]);
  });

  test("a stopped plugin leaves no scene for a successor under its name, and a new run is a new epoch", () => {
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    const first = canvasSnapshot("a", "board").epoch;
    dropCanvases("a");
    expect(canvasSnapshot("a", "board")).toEqual({ epoch: 0, version: 0, scene: [] });
    applyCanvasOps("a", c, "board", { ops: [add("y")] });
    expect(canvasSnapshot("a", "board").epoch).not.toBe(first);
  });
});

describe("how much", () => {
  test("a burst is allowed, then the rate; a refusal says when to come back", () => {
    let t = 1_000_000;
    expect(takeOps("a", OPS_BURST, t).ok).toBe(true);
    const r = takeOps("a", 30, t);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.retryAfterMs).toBeGreaterThanOrEqual(400);
    t += 1000;
    expect(takeOps("a", OPS_PER_SECOND, t).ok).toBe(true);
    expect(takeOps("a", 1, t).ok).toBe(false);
  });

  test("an empty or refused request still costs one, and plugins do not share a bucket", () => {
    const t = 5_000_000;
    for (let i = 0; i < OPS_BURST; i++) expect(takeOps("a", 0, t).ok).toBe(true);
    expect(takeOps("a", 0, t).ok).toBe(false);
    expect(takeOps("b", 1, t).ok).toBe(true);
  });

  test("a refused ask does not refill for free: asking again right away stays refused", () => {
    const t = 9_000_000;
    takeOps("a", OPS_BURST, t);
    for (let i = 0; i < 20; i++) expect(takeOps("a", 5, t).ok).toBe(false);
  });
});

describe("a body is cut off before it is parsed", () => {
  const stream = (chunks: string[], pulled: { n: number }) => new Request("http://x/", {
    method: "POST",
    body: new ReadableStream({
      pull(ctl) { const next = chunks[pulled.n++]; if (next === undefined) ctl.close(); else ctl.enqueue(new TextEncoder().encode(next)); },
    }),
    duplex: "half",
  });

  test("a declared length over the cap is refused without reading a byte", async () => {
    const req = new Request("http://x/", { method: "POST", headers: { "content-length": String(CANVAS_LIMITS.bodyBytes + 1) }, body: "{}" });
    expect(await readBoundedJson(req, CANVAS_LIMITS.bodyBytes)).toEqual({ ok: false, status: 413, error: expect.stringContaining("over") });
  });

  test("a body with no declared length is cut at the cap: later chunks are never pulled and JSON.parse never runs", async () => {
    const pulled = { n: 0 };
    const parse = JSON.parse;
    let parsed = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parsed++; return parse(...a); }) as typeof JSON.parse;
    try {
      const chunk = "x".repeat(16 * 1024);
      const r = await readBoundedJson(stream(Array.from({ length: 200 }, () => chunk), pulled), CANVAS_LIMITS.bodyBytes);
      expect(r).toMatchObject({ ok: false, status: 413 });
      expect(parsed).toBe(0);
      expect(pulled.n).toBeLessThan(20);
    } finally { JSON.parse = parse; }
  });

  test("a body under the cap parses, and junk is a 400 rather than a throw", async () => {
    expect(await readBoundedJson(new Request("http://x/", { method: "POST", body: '{"ops":[]}' }), 1000)).toEqual({ ok: true, value: { ops: [] } });
    expect(await readBoundedJson(new Request("http://x/", { method: "POST", body: "{nope" }), 1000)).toMatchObject({ ok: false, status: 400 });
    expect(await readBoundedJson(new Request("http://x/", { method: "POST" }), 1000)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("what a window is sent", () => {
  test("subscribe gets a snapshot; changes arrive as one coalesced frame per flush", () => {
    live(["a", "board"]);
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    flushCanvases();
    const { s, h } = window_();
    sub(h, "a", "board");
    expect(s.sent[0]).toMatchObject({ type: "snapshot", plugin: "a", panel: "board", version: 1, running: true });
    expect(s.sent[0].scene).toHaveLength(1);
    applyCanvasOps("a", c, "board", { ops: [add("y")] });
    applyCanvasOps("a", c, "board", { ops: [add("z")] });
    expect(s.sent).toHaveLength(1);
    flushCanvases();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]).toMatchObject({ type: "ops", from: 1, to: 3, epoch: s.sent[0].epoch });
    expect(s.sent[1].ops.map((o: any) => o.node.id)).toEqual(["y", "z"]);
  });

  test("the timer flushes by itself within the frame budget", async () => {
    live(["a", "board"]);
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    flushCanvases();
    const { s, h } = window_();
    sub(h, "a", "board");
    applyCanvasOps("a", c, "board", { ops: [add("y")] });
    await Bun.sleep(FLUSH_MS * 3);
    expect(s.types()).toEqual(["snapshot", "ops"]);
  });

  test("a window hears only the panels it asked for", () => {
    live(["a", "board"], ["a", "other"], ["b", "board"]);
    const { s, h } = window_();
    sub(h, "a", "board");
    applyCanvasOps("a", c, "other", { ops: [add("x")] });
    applyCanvasOps("b", c, "board", { ops: [add("x")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot"]);
    h.message(JSON.stringify({ type: "unsubscribe", plugin: "a", panel: "board" }));
    applyCanvasOps("a", c, "board", { ops: [add("y")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot"]);
  });

  test("a panel that is not a live canvas is answered with `gone`, and no scene", () => {
    live(["a", "board"]);
    applyCanvasOps("a", c, "board", { ops: [add("secret-row")] });
    const { s, h } = window_();
    sub(h, "a", "still");
    sub(h, "ghost", "board");
    expect(s.sent).toEqual([{ type: "gone", plugin: "a", panel: "still" }, { type: "gone", plugin: "ghost", panel: "board" }]);
    expect(JSON.stringify(s.sent)).not.toContain("secret-row");
  });

  test("a frame that does not follow what the window has becomes a snapshot: a gap, a restarted plugin, a backlog", () => {
    live(["a", "board"]);
    const { s, h } = window_();
    sub(h, "a", "board");
    // Nothing drawn yet: the first frame is the scene itself, because the
    // window's empty epoch 0 is not the epoch the plugin just started.
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot", "snapshot"]);
    applyCanvasOps("a", c, "board", { ops: [add("x2")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot", "snapshot", "ops"]);
    // The plugin restarted: same panel, new epoch.
    dropCanvases("a");
    expect(s.types()).toEqual(["snapshot", "snapshot", "ops", "gone"]);
    applyCanvasOps("a", c, "board", { ops: [add("fresh")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot", "snapshot", "ops", "gone", "snapshot"]);
    expect(s.sent[4].scene.map((n: any) => n.id)).toEqual(["fresh"]);
    // A slow window is sent nothing more (a snapshot on top of a full buffer
    // is worse), and gets one scene when it drains.
    s.backlog = SOCKET_BACKLOG_BYTES + 1;
    const before = s.sent.length;
    applyCanvasOps("a", c, "board", { ops: [add("late")] });
    flushCanvases();
    applyCanvasOps("a", c, "board", { ops: [add("later")] });
    flushCanvases();
    expect(s.sent).toHaveLength(before);
    h.drain();
    expect(s.sent).toHaveLength(before);
    s.backlog = 0;
    h.drain();
    expect(s.types().at(-1)).toBe("snapshot");
    expect(s.sent.at(-1).scene.map((n: any) => n.id)).toEqual(["fresh", "late", "later"]);
    // And exactly once.
    h.drain();
    expect(s.sent).toHaveLength(before + 1);
  });

  test("a window that was behind and finds the socket clear on the next flush is sent the scene, not a frame that skips", () => {
    live(["a", "board"]);
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    flushCanvases();
    const { s, h } = window_();
    sub(h, "a", "board");
    s.backlog = SOCKET_BACKLOG_BYTES + 1;
    applyCanvasOps("a", c, "board", { ops: [add("y")] });
    flushCanvases();
    s.backlog = 0;
    applyCanvasOps("a", c, "board", { ops: [add("z")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot", "snapshot"]);
    expect(s.sent[1].scene.map((n: any) => n.id)).toEqual(["x", "y", "z"]);
  });

  test("two batches that would make a frame the window cannot replay go out as two frames", () => {
    live(["a", "board"]);
    applyCanvasOps("a", c, "board", { ops: [add("seed")] });
    flushCanvases();
    const { s, h } = window_();
    sub(h, "a", "board");
    const sixty = (p: string) => Array.from({ length: 60 }, (_, i) => add(`${p}${i}`));
    applyCanvasOps("a", c, "board", { ops: sixty("p") });
    applyCanvasOps("a", c, "board", { ops: sixty("q") });
    flushCanvases();
    const frames = s.sent.filter((f) => f.type === "ops");
    expect(frames).toHaveLength(2);
    for (const f of frames) expect(f.ops.length).toBeLessThanOrEqual(CANVAS_LIMITS.batchOps);
    expect(frames[0].to).toBe(frames[1].from);
    expect(s.types()).toEqual(["snapshot", "ops", "ops"]);
  });

  test("a subscribe that arrived before the plugin was there is remembered: when it draws, the window is sent the scene", () => {
    setCanvasResolver(() => ({ canvas: false, running: false }));
    const { s, h } = window_();
    sub(h, "a", "board");
    expect(s.types()).toEqual(["gone"]);
    live(["a", "board"]);
    applyCanvasOps("a", c, "board", { ops: [add("hello")] });
    flushCanvases();
    expect(s.types()).toEqual(["gone", "snapshot"]);
    expect(s.sent[1].scene.map((n: any) => n.id)).toEqual(["hello"]);
  });

  test("a window cannot hold more than a few subscriptions, and junk on the socket is ignored", () => {
    setCanvasResolver(() => ({ canvas: true, running: true }));
    const { s, h } = window_();
    for (let i = 0; i < SUBSCRIPTIONS_PER_SOCKET + 5; i++) sub(h, "a", `p${i}`);
    expect(s.sent).toHaveLength(SUBSCRIPTIONS_PER_SOCKET);
    for (const junk of ["", "nope", "{}", '{"type":"subscribe"}', '{"type":"subscribe","plugin":1,"panel":2}', "x".repeat(600), Buffer.from("x")]) h.message(junk as string);
    expect(s.sent).toHaveLength(SUBSCRIPTIONS_PER_SOCKET);
  });

  test("a closed window is not written to", () => {
    live(["a", "board"]);
    const { s, h } = window_();
    sub(h, "a", "board");
    h.close();
    applyCanvasOps("a", c, "board", { ops: [add("x")] });
    flushCanvases();
    expect(s.types()).toEqual(["snapshot"]);
  });
});

describe("the door is FULL_GET", () => {
  test("a read-scope caller, a phone, is refused by scope; the desk's own credential is not", () => {
    expect(scopeNeeded("GET", "/plugins/panels/live")).toBe("full");
    expect(scopeNeeded("GET", "/plugins/panels")).toBe("full");
  });
});

describe("the other /plugin/self writes are read with a ceiling too", () => {
  const src = Bun.file(new URL("../src/index.ts", import.meta.url).pathname);
  test("their body reader is the bounded one, not req.json()", async () => {
    const text = await src.text();
    const at = text.indexOf("const body = async <T,>()");
    expect(at).toBeGreaterThan(0);
    const line = text.slice(at, text.indexOf("\n", at));
    expect(line).toContain("readBoundedJson(req");
    expect(line).not.toContain("req.json()");
  });
});
