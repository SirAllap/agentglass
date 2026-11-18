/*
 * Guide mode's panel half, driven with a fake shell: the relay's asks run
 * (finding 1), the person's End guide / Stop reach `guide next` (2), observer
 * reports never make steps (5), and one acting-verb list (4).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runBrowserAsk, runGuide, setGuideShell, type DrivableWebview } from "../src/lib/browserDrive.ts";
import { answerGuide, onGuideEvent, resetGuideBus } from "../src/lib/browserGuideBus.ts";
import { activityReducer, actionOf, agentAskRefusal, isActVerb, type Activity, type GuideEvent } from "../src/lib/browserAgentActivity.ts";
import { ACT_VERBS, LOG_ACT_VERBS } from "../../shared/browserActVerbs.ts";
import { WORKER_ACT_VERBS, groupOfVerb } from "../../shared/browserLimits.ts";
import type { BrowserAskFrame } from "../../shared/types.ts";

const T = "t1";
const el = { getWebContentsId: () => 7, executeJavaScript: async () => ({ total: 1, url: "https://x.example/" }) } as unknown as DrivableWebview;
const ask = (op: string, args: Record<string, unknown>) => ({ id: "a", op, args: { page: T, ...args } }) as unknown as BrowserAskFrame;

function fakeShell() {
  const calls: Record<string, unknown>[] = [];
  let push: (ev: unknown) => void = () => {};
  setGuideShell({
    observe: async (req) => { calls.push(req); return { ok: true, found: true }; },
    onObserved: (fn) => { push = fn; return () => { push = () => {}; }; },
  });
  return { calls, push: (ev: unknown) => push(ev) };
}

afterEach(() => { setGuideShell(null); resetGuideBus(); });

describe("the panel runs the relay's guide asks", () => {
  test("start and point reach the bubble, point starts the observer, a click answers guide next, end stops it", async () => {
    const sh = fakeShell();
    const seen: GuideEvent[] = [];
    const off = onGuideEvent((e) => seen.push(e));
    await runGuide(el, ask("guide", { action: "start", activity: { kind: "guide", tab: T, phase: "start", say: "Rotate the key" } }));
    const p = await runGuide(el, ask("point", { selector: "#rotate", say: "Press Rotate", waitClick: true,
      activity: { kind: "guide", tab: T, phase: "wait", say: "Press Rotate", waitClick: true } }));
    expect(p).toEqual({ ok: true, value: { followed: true } });
    expect(sh.calls[0]).toMatchObject({ guestId: 7, tab: T, selector: "#rotate", waitClick: true });
    const next = runGuide(el, ask("guide", { action: "next", waitMs: 2000 }));
    sh.push({ kind: "guide", tab: T, phase: "wait", stepId: sh.calls[0]!.stepId, target: { rect: { x: 1, y: 2, w: 3, h: 4 } }, clicked: true });
    expect(await next).toEqual({ ok: true, value: { event: "click" } });
    await runGuide(el, ask("guide", { action: "end", activity: { kind: "guide", tab: T, phase: "end" } }));
    expect(sh.calls.at(-1)).toEqual({ guestId: 7, stop: true });
    off();
    expect(seen.map((e) => e.phase)).toEqual(["start", "wait", "wait", "end"]);
  });

  test("the panel's verb runner sends guide and point here, not to unknown operation", async () => {
    const sh = fakeShell();
    const guest = { getWebContentsId: () => 7, executeJavaScript: async () => ({ total: 1, url: "https://x.example/" }), addEventListener: () => {}, removeEventListener: () => {},
      getURL: () => "https://x.example/", getTitle: () => "x" } as unknown as DrivableWebview;
    const r = await runBrowserAsk(guest, ask("point", { selector: "#a", say: "Look" }));
    expect(r.ok).toBe(true);
    expect(sh.calls).toHaveLength(1);
    expect((await runBrowserAsk(guest, ask("guide", { action: "next", waitMs: 1 }))).ok).toBe(true);
  });

  test("an id from observe is followed by its CSS", async () => {
    const sh = fakeShell();
    await runGuide(el, ask("point", { selector: "e12", say: "Here" }));
    expect(sh.calls[0]!.selector).toBe('[data-agx-e="e12"]');
  });
});

describe("End guide and Stop reach the server's guide next", () => {
  test("Stop answers a waiting next and takes the observer down", async () => {
    const sh = fakeShell();
    await runGuide(el, ask("point", { selector: "#a", say: "Look" }));
    const next = runGuide(el, ask("guide", { action: "next", waitMs: 2000 }));
    answerGuide(T, "stop");
    expect(await next).toEqual({ ok: true, value: { event: "stop" } });
    expect(sh.calls.at(-1)).toEqual({ guestId: 7, stop: true });
  });

  test("Stop pressed with no next waiting is held for the next one, even past a new point", async () => {
    fakeShell();
    await runGuide(el, ask("point", { selector: "#a", say: "Look" }));
    answerGuide(T, "stop");
    await runGuide(el, ask("point", { selector: "#b", say: "Then here" }));
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "stop" } });
  });

  test("one answer per step: a press then its navigation is one click; nothing is pending", async () => {
    const sh = fakeShell();
    await runGuide(el, ask("point", { selector: "#a", say: "Look" }));
    const stepId = sh.calls[0]!.stepId;
    sh.push({ kind: "guide", tab: T, phase: "point", stepId, clicked: true, target: { rect: { x: 0, y: 0, w: 1, h: 1 } } });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId, navigated: { url: "https://x.example/" } });
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "click" } });
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: null } });
  });
});

describe("one step's observer never speaks for the next", () => {
  test("a target that cannot be followed takes the step before's observer down", async () => {
    const sh = fakeShell();
    const seen: GuideEvent[] = [];
    const off = onGuideEvent((e) => seen.push(e));
    await runGuide(el, ask("point", { selector: "#save", say: "Press Save", waitClick: true }));
    const first = sh.calls[0]!.stepId;
    const p = await runGuide(el, ask("point", { selector: "text=Continue", say: "Then Continue",
      activity: { kind: "guide", tab: T, phase: "point", say: "Then Continue" } }));
    expect(p).toEqual({ ok: true, value: { followed: false } });
    expect(sh.calls.at(-1)).toEqual({ guestId: 7, stop: true });
    /* A report #save's observer still had in flight: no rect on step 2, no click answer. */
    seen.length = 0;
    sh.push({ kind: "guide", tab: T, phase: "wait", stepId: first, target: { rect: { x: 1, y: 1, w: 1, h: 1 } }, clicked: true });
    expect(seen).toEqual([]);
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: null } });
    off();
  });

  test("point --expect: guide next after the click says whether the CSS matches, by a read", async () => {
    const sh = fakeShell();
    const asked: string[] = [];
    /* A slow page: the first two reads miss, the third matches. */
    /* point's own match read (data-agx-guide) is not one of them. */
    const page = { getWebContentsId: () => 7, executeJavaScript: async (code: string) => {
      if (code.includes("data-agx-guide")) return { total: 1, url: "https://x.example/" };
      asked.push(code); return asked.length >= 3 && code.includes("#plan:checked");
    } } as unknown as DrivableWebview;
    await runGuide(page, ask("point", { selector: "#plan", say: "Tick it", waitClick: true, expect: "#plan:checked" }));
    sh.push({ kind: "guide", tab: T, phase: "wait", stepId: sh.calls[0]!.stepId, clicked: true, target: { rect: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(await runGuide(page, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "click", expected: true } });
    expect(asked[0]).toContain("document.querySelector");
    /* Once per step: a later answer of the same step does not read again, and a step without expect never does. */
    await runGuide(page, ask("point", { selector: "#go", say: "Go", waitClick: true }));
    sh.push({ kind: "guide", tab: T, phase: "wait", stepId: sh.calls[1]!.stepId, clicked: true, target: { rect: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(await runGuide(page, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "click" } });
    expect(asked).toHaveLength(3);
  });

  test("a late navigation of step 1 does not answer step 2", async () => {
    const sh = fakeShell();
    await runGuide(el, ask("point", { selector: "#submit", say: "Submit", waitClick: true }));
    const one = sh.calls[0]!.stepId;
    sh.push({ kind: "guide", tab: T, phase: "wait", stepId: one, clicked: true, target: { rect: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "click" } });
    await runGuide(el, ask("point", { selector: "#done", say: "Now Done" }));
    const two = sh.calls[1]!.stepId;
    expect(two).not.toBe(one);
    sh.push({ kind: "guide", tab: T, phase: "wait", stepId: one, navigated: { url: "https://x.example/ok" } });
    sh.push({ kind: "guide", tab: T, phase: "point", navigated: { url: "https://x.example/ok" } });
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: null } });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: two, clicked: true, target: { rect: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "click" } });
  });

  test("a point after a held Stop starts no observer and answers stop at once", async () => {
    const sh = fakeShell();
    await runGuide(el, ask("point", { selector: "#a", say: "Look" }));
    answerGuide(T, "stop");
    const n = sh.calls.length;
    const p = await runGuide(el, ask("point", { selector: "#b", say: "Then here" }));
    expect(p).toEqual({ ok: true, value: { followed: false, event: "stop" } });
    expect(sh.calls.slice(n).some((c) => !c.stop)).toBe(false);
    expect(await runGuide(el, ask("guide", { action: "next", waitMs: 10 }))).toEqual({ ok: true, value: { event: "stop" } });
  });
});

describe("observer reports never make a step", () => {
  const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
  const run = (...evs: GuideEvent[]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
  const rect = { x: 1, y: 2, w: 3, h: 4 };
  test("after the click, a rect report with no say stays on step 1; a wait-click point is a step", () => {
    const s = run(
      g({ phase: "start", say: "Why" }),
      g({ phase: "wait", say: "Press it", waitClick: true }),
      g({ phase: "wait", target: { rect }, clicked: true }),
      g({ phase: "wait", target: { rect: { ...rect, y: 9 } } }),
      g({ phase: "wait", say: "Press it", clicked: true }),
    );
    expect(s[T]!.guide!.steps).toHaveLength(1);
    expect(s[T]!.guide!.steps[0]).toMatchObject({ did: "click", waitClick: true, rect: { y: 9 } });
  });
});

describe("one acting-verb list", () => {
  test("eval, open, navigate, hover and scroll are acts for the panel lock", () => {
    const guided = { agent: "orbit", working: 0, paused: false, log: [], guide: { on: true, startedAt: 0, steps: [] } };
    for (const op of ["eval", "open", "navigate", "hover", "scroll", "focus", "blur", "resize", "zoom", "click"]) {
      expect(ACT_VERBS, op).toContain(op);
      expect(agentAskRefusal(guided, { op, args: {} }), op).not.toBeNull();
    }
  });
  test("the log and the pill count only acts that change the page, never the eye's verbs", () => {
    for (const op of ["click", "fill", "type", "press", "select", "upload", "drag", "eval", "navigate", "open"]) {
      expect(LOG_ACT_VERBS, op).toContain(op);
      expect(isActVerb(op), op).toBe(true);
      expect(actionOf({ op, args: {} }, true, 1), op).not.toBeNull();
    }
    for (const op of ["hover", "focus", "blur", "scroll", "resize", "zoom"]) {
      expect(isActVerb(op), op).toBe(false);
      expect(actionOf({ op, args: { selector: "#a" } }, true, 1), op).toBeNull();
    }
    expect(LOG_ACT_VERBS.every((v) => ACT_VERBS.includes(v))).toBe(true);
  });
  test("the worker Act switch gives exactly what it gave before", () => {
    expect([...WORKER_ACT_VERBS]).toEqual(["click", "dblclick", "rightclick", "hover", "focus", "blur", "type", "fill", "select", "check", "press", "scroll", "resize", "zoom", "back", "forward", "reload"]);
    expect(groupOfVerb("eval")).toBe("eval");
    expect(groupOfVerb("open")).toBeNull();
    expect(groupOfVerb("upload")).toBe("cookies-storage");
    expect(groupOfVerb("drag")).toBeNull();
  });
});
