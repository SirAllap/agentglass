import { describe, expect, test } from "bun:test";
import { activityReducer, agentAskRefusal, agentState, glassBlocks, tabState, type Activity } from "../src/lib/browserAgentActivity.ts";
import { isHandoffArmed, onHandoff, runHandoff, takeOverHandoff, type DrivableWebview } from "../src/lib/browserDrive.ts";

/* The glass over a page takes the person's clicks. During a handoff it took the
   banner's Done too, so the call waited for a click nobody could make. */
describe("does the glass block the person's input", () => {
  const cases: Array<[string, { held: boolean; acting: boolean; paused: boolean; handoff?: boolean }, boolean]> = [
    ["agent acting", { held: true, acting: true, paused: false }, true],
    ["agent acting, handoff armed", { held: true, acting: true, paused: false, handoff: true }, false],
    ["handoff ended, agent goes on", { held: true, acting: true, paused: false, handoff: false }, true],
    ["Take over", { held: true, acting: true, paused: true }, false],
    ["Take over during a handoff", { held: true, acting: true, paused: true, handoff: true }, false],
    ["held, nothing acted yet (a look, a read)", { held: true, acting: false, paused: false }, false],
    ["quiet window run out", { held: false, acting: true, paused: false }, false],
    ["nobody", { held: false, acting: false, paused: false }, false],
  ];
  for (const [name, a, want] of cases) test(name, () => expect(glassBlocks(a)).toBe(want));
});

describe("handoff on the tab's state", () => {
  const begin = (s: Activity, op = "click") => activityReducer(s, { type: "begin", tab: "t1", agent: "chk", op });
  test("the pill says the person is needed, not Reading", () => {
    const s = activityReducer(begin({}, "handoff"), { type: "handoff", tab: "t1", on: true });
    expect(agentState(s.t1!).key).toBe("handoff");
    expect(tabState(s.t1, "chk", Date.now())?.word).toBe("Needs you");
  });
  test("the agent stays attached: not paused, and its waits keep the handoff", () => {
    let s = activityReducer(begin({}), { type: "handoff", tab: "t1", on: true });
    s = activityReducer(s, { type: "end", tab: "t1", action: null });
    s = begin(s, "handoff");
    expect(s.t1!.paused).toBe(false);
    expect(s.t1!.handoff).toBe(true);
    s = activityReducer(s, { type: "handoff", tab: "t1", on: false });
    expect(s.t1!.handoff).toBe(false);
    expect(agentState(s.t1!).key).toBe("reading");
  });
  test("Take over keeps its meaning: the tab is the person's", () => {
    let s = activityReducer(begin({}), { type: "handoff", tab: "t1", on: true });
    s = activityReducer(s, { type: "pause", tab: "t1", paused: true });
    expect(agentState(s.t1!).key).toBe("yours");
  });
  test("a tab no agent touched gets no handoff mark", () => {
    expect(activityReducer({}, { type: "handoff", tab: "t9", on: true })).toEqual({});
  });
});

/* A guest with just enough of a webview: the banner is "drawn", and the Done
   click arrives the way the real one does, as the nonce on the console. */
function fakeGuest() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  let nonce = "";
  const el = {
    getURL: () => "https://acme.test/login",
    getTitle: () => "Sign in",
    executeJavaScript: async (code: string) => {
      const m = /"agx-handoff-done:" \+ "([^"]+)"/.exec(code);
      if (m) nonce = m[1]!;
      return code.includes("attachShadow") ? true : undefined;
    },
    addEventListener: (k: string, fn: (e: Event) => void) => { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k)!.add(fn); },
    removeEventListener: (k: string, fn: (e: Event) => void) => { listeners.get(k)?.delete(fn); },
  };
  const pressDone = () => { for (const fn of listeners.get("console-message") ?? []) fn({ message: "agx-handoff-done:" + nonce } as unknown as Event); };
  return { el: el as unknown as DrivableWebview, pressDone, listening: () => listeners.get("console-message")?.size ?? 0 };
}

describe("handoff -> Done", () => {
  test("Done answers the waiting call, and the glass is told before and after", async () => {
    const g = fakeGuest();
    const told: boolean[] = [];
    const off = onHandoff((el, on) => { if (el === g.el) told.push(on); });
    try {
      const armed = await runHandoff(g.el, { reason: "Type the 2FA code" });
      expect(armed).toMatchObject({ ok: true, value: { state: "armed" } });
      expect(told).toEqual([true]);
      const wait = runHandoff(g.el, { check: true, waitMs: 5000 });
      setTimeout(g.pressDone, 50);
      const res = await wait;
      expect(res).toMatchObject({ ok: true, value: { state: "done" } });
      expect(told).toEqual([true, false]);
      expect(g.listening()).toBe(0);
    } finally { off(); }
  });
  test("cancel (the CLI's timeout) ends it and brings the glass back", async () => {
    const g = fakeGuest();
    const told: boolean[] = [];
    const off = onHandoff((el, on) => { if (el === g.el) told.push(on); });
    try {
      await runHandoff(g.el, { reason: "Solve the CAPTCHA" });
      expect(await runHandoff(g.el, { cancel: true })).toMatchObject({ ok: true, value: { state: "cancelled" } });
      expect(told).toEqual([true, false]);
    } finally { off(); }
  });
  test("the panel keeps the deadline: banner down, glass back, the next check reads timeout", async () => {
    const g = fakeGuest();
    const told: boolean[] = [];
    const off = onHandoff((el, on) => { if (el === g.el) told.push(on); });
    try {
      await runHandoff(g.el, { reason: "Solve the CAPTCHA", timeoutMs: 150 });
      // A check in flight when the deadline fires.
      expect(await runHandoff(g.el, { check: true, waitMs: 3000 })).toMatchObject({ ok: true, value: { state: "timeout" } });
      expect(told).toEqual([true, false]);
      expect(g.listening()).toBe(0);
      // And a caller that was away when it fired (killed, between checks).
      await runHandoff(g.el, { reason: "again", timeoutMs: 100 });
      await new Promise((r) => setTimeout(r, 250));
      expect(told).toEqual([true, false, true, false]);
      expect(await runHandoff(g.el, { check: true })).toMatchObject({ ok: true, value: { state: "timeout" } });
      // Said once: the check after that is about no handoff at all.
      expect(await runHandoff(g.el, { check: true })).toMatchObject({ ok: true, value: { state: "none" } });
    } finally { off(); }
  });
  test("a banner that could not be drawn does not leave the glass lifted", async () => {
    const g = fakeGuest();
    (g.el as unknown as { executeJavaScript: () => Promise<unknown> }).executeJavaScript = async () => false;
    const told: boolean[] = [];
    const off = onHandoff((el, on) => { if (el === g.el) told.push(on); });
    try {
      expect(await runHandoff(g.el, { reason: "x" })).toMatchObject({ ok: false });
      expect(told).toEqual([true, false]);
    } finally { off(); }
  });
});

describe("a done during a handoff", () => {
  test("keeps the handoff, so the glass stays lifted over Done", () => {
    let s = activityReducer({}, { type: "begin", tab: "t1", agent: "chk", op: "handoff" });
    s = activityReducer(s, { type: "end", tab: "t1", action: null });
    s = activityReducer(s, { type: "handoff", tab: "t1", on: true });
    s = activityReducer(s, { type: "done", tab: "t1" });
    expect(s.t1!.done).toBe(true);
    expect(s.t1!.handoff).toBe(true);
    expect(glassBlocks({ held: true, acting: true, paused: false, handoff: s.t1!.handoff })).toBe(false);
  });
});

describe("Take over during a handoff", () => {
  test("ends it: banner down, glass told, the waiting check reads takenover", async () => {
    const g = fakeGuest();
    const told: boolean[] = [];
    const off = onHandoff((el, on) => { if (el === g.el) told.push(on); });
    try {
      await runHandoff(g.el, { reason: "Type the 2FA code" });
      const wait = runHandoff(g.el, { check: true, waitMs: 3000 });
      setTimeout(() => { void takeOverHandoff(g.el); }, 50);
      expect(await wait).toMatchObject({ ok: true, value: { state: "takenover", takenOver: true } });
      expect(told).toEqual([true, false]);
      expect(g.listening()).toBe(0);
      // A caller between checks hears it once, then there is no handoff.
      await runHandoff(g.el, { reason: "again" });
      await takeOverHandoff(g.el);
      expect(await runHandoff(g.el, { check: true })).toMatchObject({ value: { state: "takenover", takenOver: true } });
      expect(await runHandoff(g.el, { check: true })).toMatchObject({ value: { state: "none" } });
    } finally { off(); }
  });
  test("with nothing armed it does nothing", async () => {
    const g = fakeGuest();
    await takeOverHandoff(g.el);
    expect(await runHandoff(g.el, { check: true })).toMatchObject({ value: { state: "none" } });
  });
  test("a taken-over tab still lets the handoff's check and cancel through, nothing else", () => {
    let s = activityReducer({}, { type: "begin", tab: "t1", agent: "chk", op: "handoff" });
    s = activityReducer(s, { type: "handoff", tab: "t1", on: true });
    s = activityReducer(s, { type: "pause", tab: "t1", paused: true });
    expect(agentAskRefusal(s.t1, { op: "handoff", args: { check: true } })).toBeNull();
    expect(agentAskRefusal(s.t1, { op: "handoff", args: { cancel: true } })).toBeNull();
    expect(agentAskRefusal(s.t1, { op: "handoff", args: { reason: "again" } })).toContain("took this tab over");
    expect(agentAskRefusal(s.t1, { op: "read", args: {} })).toContain("took this tab over");
  });
});

describe("a panel that mounts mid-handoff", () => {
  test("reads the handoff back from browserDrive and marks the tab", async () => {
    const g = fakeGuest();
    expect(isHandoffArmed(g.el)).toBe(false);
    await runHandoff(g.el, { reason: "Type the 2FA code" });
    expect(isHandoffArmed(g.el)).toBe(true);
    // Fresh state, as after a remount: the seed marks the tab, so the glass stays lifted.
    const s = activityReducer({}, { type: "handoff", tab: "t1", on: true, seed: true });
    expect(s.t1!.handoff).toBe(true);
    expect(glassBlocks({ held: true, acting: true, paused: false, handoff: s.t1!.handoff })).toBe(false);
    expect(agentAskRefusal(s.t1, { op: "click", args: {} })).toContain("handoff");
    await runHandoff(g.el, { cancel: true });
    expect(isHandoffArmed(g.el)).toBe(false);
  });
});
