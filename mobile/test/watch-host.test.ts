/*
 * The socket kept for a computer that is not the one in front, so its agents
 * can still reach the phone. What it must NOT do is as much the point as what
 * it does: no timer of its own, and a request only when something on that
 * computer says the list of waiting gates moved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WsFrame } from "../../shared/types.ts";
import type { HostEntry } from "../src/lib/hosts.ts";
import { watchHost, type WatchEvents } from "../src/state/watch-host.ts";
import { REVOKED } from "../src/lib/api.ts";

const host: HostEntry = {
  id: "h1", origin: "http://10.0.0.2:4000", token: "t", label: "Pixel", scope: "answer", pairedAt: 1, lastUsed: 1,
};

function rig(gates: () => unknown = () => ({ ok: true, value: { gates: [{}, {}] } })) {
  const log = { asks: [] as string[], states: [] as string[], waiting: [] as number[], alerts: [] as unknown[], revoked: 0, closed: 0 };
  let onFrame!: (f: WsFrame) => void;
  let onState!: (s: "connecting" | "open" | "offline") => void;
  const release: Array<() => void> = [];
  const deps = {
    openLive: (_h: unknown, o: { onFrame: typeof onFrame; onState: typeof onState }) => {
      onFrame = o.onFrame; onState = o.onState;
      return { wake() {}, close() { log.closed++; } };
    },
    ask: (_h: unknown, path: string) => {
      log.asks.push(path);
      return new Promise((resolve) => { release.push(() => resolve(gates())); });
    },
  };
  const events: WatchEvents = {
    onState: (s) => log.states.push(s),
    onWaiting: (n) => log.waiting.push(n),
    onAlert: (a) => log.alerts.push(a),
    onRevoked: () => { log.revoked++; },
  };
  const stop = watchHost(host, events, deps as never);
  const settle = async () => { while (release.length) { release.shift()!(); await Promise.resolve(); await Promise.resolve(); } };
  return { log, stop, settle, frame: (f: WsFrame) => onFrame(f), state: (s: "connecting" | "open" | "offline") => onState(s) };
}

let timers = 0;
const real = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
beforeEach(() => {
  timers = 0;
  globalThis.setInterval = ((...a: unknown[]) => { timers++; return (real.setInterval as never as (...x: unknown[]) => unknown)(...a); }) as never;
  globalThis.setTimeout = ((...a: unknown[]) => { timers++; return (real.setTimeout as never as (...x: unknown[]) => unknown)(...a); }) as never;
});
afterEach(() => { globalThis.setInterval = real.setInterval; globalThis.setTimeout = real.setTimeout; });

describe("watching a computer that is not in front", () => {
  test("creates no timer of its own", async () => {
    // Broken on purpose: a refresh interval here is N computers asking every
    // twenty seconds for the sake of one badge.
    const r = rig();
    r.state("open");
    await r.settle();
    r.frame({ type: "gate" });
    await r.settle();
    r.stop();
    expect(timers).toBe(0);
  });

  test("asks for the waiting gates once when the socket opens", async () => {
    const r = rig();
    expect(r.log.asks).toEqual([]);
    r.state("open");
    await r.settle();
    expect(r.log.asks).toEqual(["/gate/pending"]);
    expect(r.log.waiting).toEqual([2]);
  });

  test("a gate frame asks again; any other frame does not", async () => {
    const r = rig();
    r.state("open");
    await r.settle();
    for (const type of ["git", "tasks", "devices", "desktop-palette"] as const) r.frame({ type } as WsFrame);
    r.frame({ type: "marks", data: [] });
    await r.settle();
    expect(r.log.asks.length).toBe(1);
    r.frame({ type: "gate" });
    await r.settle();
    expect(r.log.asks.length).toBe(2);
  });

  test("a burst of gate frames during one read costs one more read, not one each", async () => {
    const r = rig();
    r.state("open");
    await r.settle();
    r.frame({ type: "gate" });
    r.frame({ type: "gate" });
    r.frame({ type: "gate" });
    await r.settle();
    expect(r.log.asks.length).toBeLessThanOrEqual(3);
    expect(r.log.asks.length).toBeGreaterThanOrEqual(2);
  });

  test("tells the provider the state of its socket", async () => {
    const r = rig();
    r.state("connecting");
    r.state("offline");
    expect(r.log.states).toEqual(["connecting", "offline"]);
  });

  test("hands over its alerts and nothing else from the frames", () => {
    const r = rig();
    const alert = { title: "x", body: "y", urgency: 2 as const };
    r.frame({ type: "alert", data: alert });
    r.frame({ type: "talk", data: {} as never });
    r.frame({ type: "ci", data: {} as never });
    expect(r.log.alerts).toEqual([alert]);
  });

  test("a 401 marks it and stops asking", async () => {
    const r = rig(() => ({ ok: false, error: REVOKED }));
    r.state("open");
    await r.settle();
    expect(r.log.revoked).toBe(1);
    r.frame({ type: "gate" });
    await r.settle();
    expect(r.log.asks.length).toBe(1);
  });

  test("stopping closes the socket and drops a late answer", async () => {
    const r = rig();
    r.state("open");
    r.stop();
    await r.settle();
    expect(r.log.closed).toBe(1);
    expect(r.log.waiting).toEqual([]);
  });
});

describe("the frames a watch alert needs", () => {
  test("a watched pull request, a card and an alert's open or close are handed over, nothing else is", async () => {
    const got: string[] = [];
    let onFrame!: (f: WsFrame) => void;
    let opened = 0;
    const deps = {
      openLive: (_h: unknown, o: { onFrame: typeof onFrame; onState: (s: string) => void }) => { onFrame = o.onFrame; o.onState("open"); return { wake() {}, close() {} }; },
      ask: async () => ({ ok: true, value: { gates: [] } }),
    };
    const stop = watchHost(host, {
      onState: () => {}, onWaiting: () => {}, onAlert: () => {}, onRevoked: () => {},
      onWatch: (f) => got.push(f.type), onOpen: () => { opened++; },
    }, deps as never);
    for (const type of ["prwatchfire", "card", "askedalert", "askedclosed", "ci", "prchecks", "talk", "marks"]) onFrame({ type, data: {} } as never);
    stop();
    expect(got).toEqual(["prwatchfire", "card", "askedalert", "askedclosed"]);
    expect(opened).toBe(1);
  });

  test("a caller that does not ask for them is not bothered", () => {
    let onFrame!: (f: WsFrame) => void;
    const deps = { openLive: (_h: unknown, o: { onFrame: typeof onFrame }) => { onFrame = o.onFrame; return { wake() {}, close() {} }; }, ask: async () => ({ ok: true, value: { gates: [] } }) };
    const stop = watchHost(host, { onState: () => {}, onWaiting: () => {}, onAlert: () => {}, onRevoked: () => {} }, deps as never);
    expect(() => onFrame({ type: "prwatchfire", data: {} } as never)).not.toThrow();
    stop();
  });
});
