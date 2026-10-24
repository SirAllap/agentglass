/*
 * From a frame to a notification, and back: the live path, the reconnect
 * summary, the switch, and what a close or a tap does on the computer. Every
 * effect is a fake, so nothing here can reach the OS or a network.
 */
import { describe, expect, mock, test } from "bun:test";
import type { AskedAlert } from "../../shared/notifyPayload.ts";
import type { CardNote, PrWatchFire } from "../../shared/types.ts";
import type { HostEntry } from "../src/lib/hosts.ts";
import type { WatchRaise } from "../src/notifications/watchAlerts.ts";

mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("expo-constants", () => ({
  default: { executionEnvironment: "bare" },
  ExecutionEnvironment: { StoreClient: "storeClient", Standalone: "standalone", Bare: "bare" },
}));

const { answerWatch, createWatchAlerts } = await import("../src/notifications/watchRuntime.ts");

const ID = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
const host = { id: "desk", name: "desk", origin: "http://100.64.0.1:4000", token: "t", scope: "full", lastUsed: 0 } as unknown as HostEntry;

const fire = (over: Partial<PrWatchFire> = {}): PrWatchFire => ({
  seq: 1, ruleId: "r1", rule: "ci-pass", repo: "acme/orbit", number: 1042, title: "Add the thing", summary: "CI passed", detail: "", ok: true, alertId: ID(1),
  payload: { title: "CI passed · acme/orbit #1042", line: "Add the thing", target: { kind: "pr", repo: "acme/orbit", number: 1042, root: "/home/dev/orbit" } },
  ...over,
});
const asked = (n: number): AskedAlert => ({
  id: ID(n), key: `k${n}`, ok: true, firedAt: 1_000 * n, seenAt: null, actedAt: null, closedAt: null, osError: null,
  payload: { title: `CI passed · acme/orbit #${1000 + n}`, line: "ok", target: { kind: "pr", repo: "acme/orbit", number: 1000 + n, root: "/home/dev/orbit" } },
});
const card: CardNote = { kind: "mention", id: "86abc12", label: "ORBIT-1042", title: "Fix", status: "open", who: "Ada", said: "ping" };

function rig(opts: { enabled?: boolean | null; foreground?: boolean; open?: AskedAlert[]; since?: number | null; rejectRaise?: boolean; slowEnabled?: boolean } = {}) {
  const raised: { r: WatchRaise; hostId: string; title: string }[] = [];
  const dismissed: string[] = [];
  const sent: { path: string; init?: unknown }[] = [];
  const store = new Map<string, { at: number; ids: string[] }>();
  if (opts.since !== undefined && opts.since !== null) store.set("desk", { at: opts.since, ids: opts.since > 0 ? [ID(opts.since / 1_000)] : [] });
  let enabled = opts.enabled === undefined ? true : opts.enabled;
  const w = createWatchAlerts({
    raise: async (r, hostId, decorate) => { raised.push({ r, hostId, title: decorate(r.title) }); return { ok: !opts.rejectRaise }; },
    dismissAlert: async (id, hostId) => { dismissed.push(`${hostId}:${id}`); },
    foreground: () => opts.foreground ?? false,
    now: () => 1_000_000,
    since: { get: async (id) => store.get(id) ?? null, set: async (id, n) => { store.set(id, n); } },
    readEnabled: async () => { if (opts.slowEnabled) await new Promise((r) => setTimeout(r, 20)); return enabled; },
    ask: (async (_h: unknown, path: string, init?: unknown) => {
      sent.push({ path, init });
      return path === "/alerts/asked" ? { ok: true, value: { ok: true, open: opts.open ?? [] } } : { ok: true, value: { ok: true } };
    }) as never,
  });
  return { w, raised, dismissed, sent, store, setEnabled: (v: boolean | null) => { enabled = v; } };
}
const plain = (t: string): string => t;

describe("live", () => {
  test("a fire raises one notification tagged by its pull request", async () => {
    const t = rig();
    await t.w.onFire(host, fire(), plain);
    expect(t.raised).toHaveLength(1);
    expect(t.raised[0]).toMatchObject({ hostId: "desk", r: { tag: "pr:acme/orbit#1042", data: { kind: "watch", pr: 1042, alertId: ID(1) } } });
  });

  test("a card raises one tagged by the card; the computer is named by the caller", async () => {
    const t = rig();
    await t.w.onCard(host, card, (s) => `desk: ${s}`);
    expect(t.raised[0]).toMatchObject({ title: "desk: Ada mentioned you on ORBIT-1042", r: { tag: "card:86abc12", urgent: true, data: { kind: "watch", card: "86abc12" } } });
  });

  test("the computer's switch decides, asked every time", async () => {
    const t = rig({ enabled: false });
    await t.w.onFire(host, fire(), plain);
    expect(t.raised).toHaveLength(0);
    t.setEnabled(true);
    await t.w.onFire(host, fire({ alertId: ID(2) }), plain);
    expect(t.raised).toHaveLength(1);
  });

  test("a computer that cannot be asked keeps the last answer, and on until it has one", async () => {
    const t = rig({ enabled: null });
    await t.w.onFire(host, fire(), plain);
    expect(t.raised).toHaveLength(1);
    t.setEnabled(false);
    await t.w.onFire(host, fire({ alertId: ID(2) }), plain);
    t.setEnabled(null);
    await t.w.onFire(host, fire({ alertId: ID(3) }), plain);
    expect(t.raised).toHaveLength(1);
  });

  test("nothing while the app is on screen", async () => {
    const t = rig({ foreground: true });
    await t.w.onFire(host, fire(), plain);
    await t.w.onCard(host, card, plain);
    expect(t.raised).toHaveLength(0);
  });

  test("the same fire twice is one", async () => {
    const t = rig();
    await t.w.onFire(host, fire(), plain);
    await t.w.onFire(host, fire(), plain);
    expect(t.raised).toHaveLength(1);
  });

  test("a frame that is not a real pull request or card raises nothing", async () => {
    const t = rig();
    await t.w.onFire(host, fire({ number: -1 }), plain);
    await t.w.onFire(host, null as unknown as PrWatchFire, plain);
    await t.w.onCard(host, { ...card, id: "../x" }, plain);
    expect(t.raised).toHaveLength(0);
  });
});

describe("a comment is told once", () => {
  test("a talk note arriving while the switch is being read stays quiet, and the watch draws once", async () => {
    const t = rig({ slowEnabled: true });
    await t.w.onFire(host, fire({ rule: "comment", number: 7, alertId: ID(3) }), plain); // another pull request: the answer is now known to be on
    const u = t.w.onFire(host, fire({ rule: "comment", alertId: ID(2) }), plain);
    // What the provider does with a talk frame while that is pending:
    const talkBuzzes = t.w.watchToldRecently(host, "acme/orbit", 1042) ? 0 : 1;
    await u;
    expect(talkBuzzes).toBe(0);
    expect(t.raised).toHaveLength(2);
  });

  test("the first fire ever has not read the switch yet, and still claims", async () => {
    const t = rig({ slowEnabled: true });
    const u = t.w.onFire(host, fire({ rule: "comment" }), plain);
    expect(t.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(true);
    await u;
  });

  test("a phone that is off, or looking at the app, claims nothing for the talk note to trip over", async () => {
    const off = rig({ slowEnabled: true, enabled: false });
    await off.w.onFire(host, fire({ rule: "comment" }), plain); // learns it is off
    const p = off.w.onFire(host, fire({ rule: "comment", alertId: ID(2) }), plain);
    expect(off.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(false);
    await p;
    const fg = rig({ slowEnabled: true, foreground: true });
    const q = fg.w.onFire(host, fire({ rule: "comment" }), plain);
    expect(fg.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(false);
    await q;
  });

  test("a talk note that buzzes during the read wins: the watch draws nothing", async () => {
    const t = rig({ slowEnabled: true });
    const p = t.w.onFire(host, fire({ rule: "comment" }), plain);
    t.w.noteTalk(host, "acme/orbit", 1042);
    await p;
    expect(t.raised).toHaveLength(0);
    expect(t.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(false);
  });

  test("a comment watch that drew nothing leaves the talk note free to", async () => {
    const t = rig({ enabled: false });
    await t.w.onFire(host, fire({ rule: "comment" }), plain);
    expect(t.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(false);
    const u = rig({ rejectRaise: true });
    await u.w.onFire(host, fire({ rule: "comment" }), plain);
    expect(u.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(false);
  });

  test("a comment watch that fired first keeps the talk note quiet", async () => {
    const t = rig();
    await t.w.onFire(host, fire({ rule: "comment" }), plain);
    expect(t.w.watchToldRecently(host, "acme/orbit", 1042)).toBe(true);
    expect(t.w.watchToldRecently(host, "acme/orbit", 7)).toBe(false);
  });

  test("a talk note that buzzed first keeps the comment watch quiet", async () => {
    const t = rig();
    t.w.noteTalk(host, "acme/orbit", 1042);
    await t.w.onFire(host, fire({ rule: "comment" }), plain);
    expect(t.raised).toHaveLength(0);
    await t.w.onFire(host, fire({ rule: "ci-fail", ok: false, alertId: ID(2) }), plain);
    expect(t.raised).toHaveLength(1);
  });
});

describe("reconnect", () => {
  test("the first time on a computer it only notes where things stand", async () => {
    const t = rig({ open: [asked(1), asked(2)], since: null });
    await t.w.catchUp(host, plain);
    expect(t.raised).toHaveLength(0);
    expect(t.store.get("desk")).toEqual({ at: 2_000, ids: [ID(2)] });
  });

  test("what was missed is ONE summary, and the next reconnect starts after it", async () => {
    const t = rig({ open: [asked(1), asked(2), asked(3), asked(4)], since: 1_000 });
    await t.w.catchUp(host, plain);
    expect(t.raised).toHaveLength(1);
    expect(t.raised[0]!.r).toMatchObject({ tag: "summary", title: "3 updates while you were away" });
    expect(t.store.get("desk")).toEqual({ at: 4_000, ids: [ID(4)] });
    await t.w.catchUp(host, plain);
    expect(t.raised).toHaveLength(1);
  });

  test("a fire the socket already delivered is not in the summary", async () => {
    const t = rig({ open: [asked(2), asked(3)], since: 1_000 });
    await t.w.onFire(host, fire({ alertId: ID(2), number: 1002, payload: undefined }), plain);
    await t.w.catchUp(host, plain);
    expect(t.raised).toHaveLength(2);
    expect(t.raised[1]!.r.tag).toBe("pr:acme/orbit#1003");
  });

  test("a computer that does not answer changes nothing", async () => {
    const raised: unknown[] = [];
    const w = createWatchAlerts({ raise: async (r) => { raised.push(r); return { ok: true }; }, dismissAlert: async () => {}, foreground: () => false, since: { get: async () => ({ at: 1_000, ids: [ID(1)] }), set: async () => { throw new Error("must not write"); } }, ask: (async () => ({ ok: false, error: "down" })) as never });
    await w.catchUp(host, plain);
    expect(raised).toHaveLength(0);
  });

  test("an alert heard live before the catch-up loaded is not announced by it, nor after a restart", async () => {
    const t = rig({ open: [asked(2)], since: 1_000 });
    await t.w.onFire(host, fire({ alertId: ID(2), number: 1002, payload: undefined }), plain);
    await t.w.onAsked(host, asked(2));
    await t.w.catchUp(host, plain);
    expect(t.raised).toHaveLength(1);
    expect(t.store.get("desk")).toEqual({ at: 2_000, ids: [ID(2)] });
  });

  test("two alerts stamped alike: hearing one live does not bury the other when the socket was down", async () => {
    const a = { ...asked(1), firedAt: 9_000 }, b = { ...asked(2), firedAt: 9_000 };
    const t = rig({ open: [a, b], since: 1_000 });
    await t.w.catchUp(host, plain); // loads the cursor; both are new here
    const u = rig({ open: [a, b], since: null });
    await u.w.catchUp(host, plain); // first run: both noted
    await u.w.onAsked(host, a);
    expect(u.store.get("desk")).toEqual({ at: 9_000, ids: [ID(1), ID(2)] });
    expect(t.raised).toHaveLength(1);
  });

  test("a live alert moves where the next reconnect starts", async () => {
    const t = rig({ open: [], since: 1_000 });
    await t.w.catchUp(host, plain);
    await t.w.onAsked(host, asked(5));
    expect(t.store.get("desk")).toEqual({ at: 5_000, ids: [ID(5)] });
    await t.w.onAsked(host, asked(2));
    expect(t.store.get("desk")).toEqual({ at: 5_000, ids: [ID(5)] });
  });
});

describe("read, on the computer", () => {
  test("an alert closed anywhere takes its notification down; an id that is not one does nothing", async () => {
    const t = rig();
    await t.w.onClosed(host, ID(1));
    await t.w.onClosed(host, "../../x");
    expect(t.dismissed).toEqual([`desk:${ID(1)}`]);
  });

  test("a tap answers the computer's alert, once it is a real id", async () => {
    const sent: { path: string; init: unknown }[] = [];
    const send = (async (_h: unknown, path: string, init: unknown) => { sent.push({ path, init }); return { ok: true, value: {} }; }) as never;
    await answerWatch(host, { kind: "watch", alertId: ID(1) }, send);
    await answerWatch(host, { kind: "watch", alertId: "x/../y" }, send);
    await answerWatch(host, { kind: "watch" }, send);
    await answerWatch(host, null, send);
    expect(sent).toEqual([{ path: "/alerts/asked/close", init: { method: "POST", body: { id: ID(1), acted: true } } }]);
  });
});
