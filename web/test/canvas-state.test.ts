/*
 * The window's copy of a live canvas: what a frame does to it, and how the one
 * shared socket keeps its subscriptions.
 *
 * The reducer is the whole rule for "does this follow what I have", so it is
 * called directly with frames. The hub takes its socket as an argument so a
 * test can hand it a fake and read what it sent.
 */
import { describe, expect, test } from "bun:test";
import type { CanvasFrame, CanvasScene } from "../../shared/pluginCanvas.ts";
import { EMPTY_CANVAS, reduceCanvas, type CanvasState } from "../src/lib/canvasState.ts";
import { RESUBSCRIBE_EVERY_MS, backoffMs, createCanvasHub, type CanvasSocket } from "../src/lib/canvasLive.ts";

const SCENE: CanvasScene = [
  { id: "gate", type: "lane", title: "Gate", state: "open" },
  { id: "t1", type: "token", parent: "gate", label: "item 1" },
];

const snap = (over: Partial<Extract<CanvasFrame, { type: "snapshot" }>> = {}): CanvasFrame =>
  ({ type: "snapshot", plugin: "acme", panel: "board", epoch: 1, version: 5, scene: SCENE, running: true, ...over });

const ops = (from: number, to: number, epoch = 1): CanvasFrame => ({
  type: "ops", plugin: "acme", panel: "board", epoch, from, to,
  ops: [{ op: "add", node: { id: `t${to}`, type: "token", parent: "gate", label: `item ${to}` } }],
});

const loaded = (): CanvasState => reduceCanvas(EMPTY_CANVAS, snap()).state;

describe("reduceCanvas", () => {
  test("a snapshot replaces everything and says the scene is there", () => {
    const r = reduceCanvas({ ...EMPTY_CANVAS, gone: true }, snap());
    expect(r.state).toMatchObject({ epoch: 1, version: 5, running: true, gone: false, loaded: true });
    expect(r.state.scene.map((n) => n.id)).toEqual(["gate", "t1"]);
    expect(r.applied).toBeNull();
    expect(r.resubscribe).toBe(false);
  });

  test("ops that follow, in order, are applied and handed back for the view to animate", () => {
    const a = reduceCanvas(loaded(), ops(5, 6));
    expect(a.resubscribe).toBe(false);
    expect(a.state.version).toBe(6);
    expect(a.state.scene.map((n) => n.id)).toEqual(["gate", "t1", "t6"]);
    expect(a.applied?.map((o) => o.op)).toEqual(["add"]);
    const b = reduceCanvas(a.state, ops(6, 7));
    expect(b.state.version).toBe(7);
    expect(b.state.scene).toHaveLength(4);
  });

  test("a gap in versions asks for a snapshot and touches nothing", () => {
    const s = loaded();
    const r = reduceCanvas(s, ops(6, 7));
    expect(r.resubscribe).toBe(true);
    expect(r.state).toBe(s);
    expect(r.applied).toBeNull();
  });

  test("a repeated or older batch is a gap too", () => {
    const s = reduceCanvas(loaded(), ops(5, 6)).state;
    expect(reduceCanvas(s, ops(5, 6)).resubscribe).toBe(true);
  });

  test("a new epoch (the plugin restarted) asks for a snapshot even when the numbers line up", () => {
    const s = loaded();
    const r = reduceCanvas(s, ops(5, 6, 2));
    expect(r.resubscribe).toBe(true);
    expect(r.state).toBe(s);
  });

  test("ops before any snapshot cannot be applied to nothing", () => {
    expect(reduceCanvas(EMPTY_CANVAS, ops(-1, 0)).resubscribe).toBe(true);
    expect(reduceCanvas(EMPTY_CANVAS, ops(0, 1)).resubscribe).toBe(true);
  });

  test("a batch the server accepted but the window cannot apply asks for the truth", () => {
    const bad: CanvasFrame = { type: "ops", plugin: "acme", panel: "board", epoch: 1, from: 5, to: 6, ops: [{ op: "remove", id: "nothing-here" }] };
    const s = loaded();
    const r = reduceCanvas(s, bad);
    expect(r.resubscribe).toBe(true);
    expect(r.state).toBe(s);
  });

  test("a version that goes backwards inside one frame is not followed", () => {
    expect(reduceCanvas(loaded(), ops(5, 5)).resubscribe).toBe(true);
  });

  test("gone marks the canvas gone, keeps the last scene to dim, and a snapshot brings it back", () => {
    const g = reduceCanvas(loaded(), { type: "gone", plugin: "acme", panel: "board" });
    expect(g.state.gone).toBe(true);
    expect(g.state.running).toBe(false);
    expect(g.state.scene).toHaveLength(2);
    expect(reduceCanvas(g.state, ops(5, 6)).resubscribe).toBe(true);
    const back = reduceCanvas(g.state, snap({ epoch: 2, version: 0 }));
    expect(back.state).toMatchObject({ gone: false, epoch: 2, version: 0 });
  });

  test("a snapshot that is not a scene is gone, never half drawn", () => {
    const withStyle = [{ id: "x", type: "token", label: "a", style: "position:fixed" }] as unknown as CanvasScene;
    for (const scene of [withStyle, "nope" as unknown as CanvasScene, [{ id: "Bad Id", type: "token", label: "a" }] as unknown as CanvasScene]) {
      const r = reduceCanvas(loaded(), snap({ scene }));
      expect(r.state.gone).toBe(true);
      expect(r.state.scene).toEqual([]);
      expect(r.state.loaded).toBe(false);
    }
  });

  test("a snapshot the window refuses is asked for again, never given up on", () => {
    const r = reduceCanvas(loaded(), snap({ scene: [{ id: "x", type: "script" }] as never }));
    expect(r.state.gone).toBe(true);
    expect(r.resubscribe).toBe(true);
  });

  test("a snapshot with a version that is not a count is gone", () => {
    expect(reduceCanvas(loaded(), snap({ version: -1 })).state.gone).toBe(true);
    expect(reduceCanvas(loaded(), snap({ epoch: Number.NaN })).state.gone).toBe(true);
  });
});

// ------------------------------------------------------------------ the hub

class FakeSocket implements CanvasSocket {
  readyState = 0;
  sent: { type: string; plugin: string; panel: string }[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; this.readyState = 3; }
  // test side
  open() { this.readyState = 1; this.onopen?.({}); }
  say(f: CanvasFrame) { this.onmessage?.({ data: JSON.stringify(f) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const clock = { t: 1_000_000 };
  const hub = createCanvasHub({
    now: () => clock.t,
    open: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    timer: {
      set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clear: (h) => { (h as { live: boolean }).live = false; },
    },
  });
  const fire = () => { const t = timers.filter((x) => x.live).pop(); if (t) { t.live = false; t.fn(); } };
  return { hub, sockets, timers, fire, clock };
}

describe("the shared socket", () => {
  test("a scene the window keeps refusing costs one subscribe a second, not one per frame", () => {
    const h = harness();
    h.hub.subscribe("acme", "board", () => {});
    const s = h.sockets[0]!;
    s.open();
    s.sent.length = 0;
    const bad = snap({ scene: [{ id: "x", type: "script" }] as never });
    for (let i = 0; i < 50; i++) s.say(bad);
    expect(s.sent).toHaveLength(0);
    expect(h.timers.filter((t) => t.live)).toHaveLength(1);
    h.clock.t += RESUBSCRIBE_EVERY_MS;
    h.fire();
    expect(s.sent).toEqual([{ type: "subscribe", plugin: "acme", panel: "board" }]);
    for (let i = 0; i < 50; i++) s.say(bad);
    expect(s.sent).toHaveLength(1);
  });

  test("nothing is dialled until a canvas asks, and everything asked before it opens is sent when it does", () => {
    const h = harness();
    expect(h.sockets).toHaveLength(0);
    h.hub.subscribe("acme", "board", () => {});
    h.hub.subscribe("acme", "meter", () => {});
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.sent).toEqual([]);
    h.sockets[0]!.open();
    expect(h.sockets[0]!.sent).toEqual([
      { type: "subscribe", plugin: "acme", panel: "board" },
      { type: "subscribe", plugin: "acme", panel: "meter" },
    ]);
  });

  test("one socket serves every canvas, and the last one out closes it after saying so", () => {
    const h = harness();
    const a = h.hub.subscribe("acme", "board", () => {});
    const b = h.hub.subscribe("acme", "meter", () => {});
    const s = h.sockets[0]!;
    s.open();
    s.sent.length = 0;
    a();
    expect(s.sent).toEqual([{ type: "unsubscribe", plugin: "acme", panel: "board" }]);
    expect(s.closed).toBe(false);
    b();
    expect(s.sent.at(-1)).toEqual({ type: "unsubscribe", plugin: "acme", panel: "meter" });
    expect(s.closed).toBe(true);
    expect(h.hub.size()).toBe(0);
  });

  test("two windows on one canvas share one subscription; the second is handed what is known", () => {
    const h = harness();
    const seen: number[] = [];
    h.hub.subscribe("acme", "board", () => {});
    const s = h.sockets[0]!;
    s.open();
    s.say(snap());
    const off2 = h.hub.subscribe("acme", "board", (st) => seen.push(st.version));
    expect(seen).toEqual([5]);
    expect(s.sent.filter((f) => f.type === "subscribe")).toHaveLength(1);
    off2();
    expect(s.sent.some((f) => f.type === "unsubscribe")).toBe(false);
  });

  test("frames reach only the canvas they name, through the reducer", () => {
    const h = harness();
    const got: Record<string, number[]> = { board: [], meter: [] };
    h.hub.subscribe("acme", "board", (st) => got.board!.push(st.version));
    h.hub.subscribe("acme", "meter", (st) => got.meter!.push(st.version));
    const s = h.sockets[0]!;
    s.open();
    s.say(snap());
    s.say(ops(5, 6));
    expect(got.board).toEqual([5, 6]);
    expect(got.meter).toEqual([]);
  });

  test("a gap is answered with another subscribe, and a frame nobody follows is ignored", () => {
    const h = harness();
    h.hub.subscribe("acme", "board", () => {});
    const s = h.sockets[0]!;
    s.open();
    s.say(snap());
    s.sent.length = 0;
    h.clock.t += RESUBSCRIBE_EVERY_MS;
    s.say(ops(9, 10));
    expect(s.sent).toEqual([{ type: "subscribe", plugin: "acme", panel: "board" }]);
    s.say({ ...snap(), panel: "unknown" });
    s.onmessage?.({ data: "not json" });
    expect(s.sent).toHaveLength(1);
  });

  test("a dropped socket comes back after 1s and re-sends every live subscription", () => {
    const h = harness();
    h.hub.subscribe("acme", "board", () => {});
    h.sockets[0]!.open();
    h.sockets[0]!.drop();
    expect(h.timers.at(-1)!.ms).toBe(1000);
    h.fire();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.open();
    expect(h.sockets[1]!.sent).toEqual([{ type: "subscribe", plugin: "acme", panel: "board" }]);
  });

  test("backoff doubles from 1s to a ceiling of 15s and starts over once it connects", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    const h = harness();
    h.hub.subscribe("acme", "board", () => {});
    h.sockets[0]!.drop();
    h.fire();
    h.sockets[1]!.drop();
    expect(h.timers.filter((t) => t.live).at(-1)!.ms).toBe(2000);
    h.fire();
    h.sockets[2]!.open();
    h.sockets[2]!.drop();
    expect(h.timers.filter((t) => t.live).at(-1)!.ms).toBe(1000);
  });

  test("leaving while it is down cancels the retry instead of dialling for nobody", () => {
    const h = harness();
    const off = h.hub.subscribe("acme", "board", () => {});
    h.sockets[0]!.open();
    h.sockets[0]!.drop();
    off();
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });
});
