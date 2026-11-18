/*
 * guide run, the panel's half, with a fake shell: a run's step reports the
 * person's hand to the server (POST /browser/guide/event) instead of to a
 * `guide next`, tagged with the visit on the card; a single step answers only
 * its own --wait-*; `guide say` changes the card in place; a lost target's
 * card offers Back and Stop; a run's Stop leaves Resume on the card.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runGuide, setGuideShell, type DrivableWebview, type GuideRunReport } from "../src/lib/browserDrive.ts";
import { answerGuide, resetGuideBus } from "../src/lib/browserGuideBus.ts";
import { GUIDE_AUDIT_MS, GUIDE_DONE_MS, GUIDE_RESUME_MS, activityReducer, auditAfterFade, auditLeft, bubbleOf, guideCard, guideResumable, type Activity } from "../src/lib/browserAgentActivity.ts";
import type { BrowserAskFrame } from "../../shared/types.ts";

const T = "t1";
const el = { getWebContentsId: () => 7, executeJavaScript: async () => ({ total: 1, url: "http://127.0.0.1/" }) } as unknown as DrivableWebview;
const ask = (op: string, args: Record<string, unknown>) => ({ id: "a", op, args: { page: T, ...args } }) as unknown as BrowserAskFrame;

function fakeShell() {
  const calls: Record<string, unknown>[] = [];
  const reports: GuideRunReport[] = [];
  let push: (ev: unknown) => void = () => {};
  setGuideShell({
    observe: async (req) => { calls.push(req); return { ok: true, found: true }; },
    onObserved: (fn) => { push = fn; return () => { push = () => {}; }; },
    report: async (ev) => { reports.push(ev); return { ok: true }; },
  });
  return { calls, reports, push: (ev: unknown) => push(ev) };
}
afterEach(() => { setGuideShell(null); resetGuideBus(); });

const runPoint = (wait: string, visit: number, extra: Record<string, unknown> = {}) => runGuide(el, ask("point", {
  selector: "#name", say: "Type your name in the 'Name' box.", wait, run: { visit }, ...extra,
  activity: { kind: "guide", tab: T, phase: "point", say: "Type your name in the 'Name' box.", step: { n: 2, m: 4 } },
}));

describe("a run's events go to the server (F1)", () => {
  test("typing, a click, a submit, a navigation and lost are posted with the visit", async () => {
    const sh = fakeShell();
    await runPoint("input", 3);
    expect(sh.calls[0]).toMatchObject({ wait: "input", watchLost: true });
    const id = sh.calls[0]!.stepId;
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, input: true });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, target: { rect: { x: 1, y: 1, w: 1, h: 1 } }, clicked: true });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, submitted: true });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, navigated: { url: "http://127.0.0.1:4321/b" } });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, gone: { url: "http://127.0.0.1:4321/b" } });
    expect(sh.reports).toEqual([
      { tab: T, event: "input", visit: 3 },
      { tab: T, event: "click", visit: 3 },
      { tab: T, event: "submit", visit: 3 },
      { tab: T, event: "navigated", visit: 3, url: "http://127.0.0.1:4321/b" },
      { tab: T, event: "lost", visit: 3, url: "http://127.0.0.1:4321/b" },
    ]);
  });

  test("the card's buttons on a run go to the server too, and Resume after Stop", async () => {
    const sh = fakeShell();
    await runPoint("click", 1);
    answerGuide(T, "back");
    answerGuide(T, "stop");
    answerGuide(T, "resume");
    expect(sh.reports.map((r) => r.event)).toEqual(["back", "stop", "resume"]);
  });

  test("a run step with no target shows the card and starts no observer", async () => {
    const sh = fakeShell();
    const r = await runGuide(el, ask("point", { say: "Read the 'Terms' page, then press OK.", wait: "ok", run: { visit: 1 } }));
    expect(r).toEqual({ ok: true, value: { followed: false } });
    expect(sh.calls.filter((c) => !c.stop)).toHaveLength(0);
  });
});

describe("a single step answers its own wait (F9)", () => {
  test("--wait-input: a click on the field does not answer, the typing does", async () => {
    const sh = fakeShell();
    await runGuide(el, ask("point", { selector: "#q", say: "Type 'orbit' in the search box.", wait: "input" }));
    const id = sh.calls[0]!.stepId;
    const next = runGuide(el, ask("guide", { action: "next", waitMs: 2000 }));
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, target: { rect: { x: 1, y: 1, w: 1, h: 1 } }, clicked: true });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: id, input: true });
    expect(await next).toEqual({ ok: true, value: { event: "input" } });
    expect(sh.reports).toHaveLength(0);
  });
});

describe("--text picks among matches (F5)", () => {
  test("the page script filters the matches by the label", async () => {
    fakeShell();
    let src = "";
    const guest = { getWebContentsId: () => 7, executeJavaScript: async (s: string) => { src = s; return { total: 2, tagged: true, url: "http://127.0.0.1/" }; } } as unknown as DrivableWebview;
    await runGuide(guest, ask("point", { selector: "a.c", text: "2 comments", say: "Click '2 comments'." }));
    expect(src).toContain('"2 comments"');
    expect(src).toContain("label(n).includes(want)");
  });
  test("no match with the text is refused, naming it", async () => {
    fakeShell();
    const guest = { getWebContentsId: () => 7, executeJavaScript: async () => ({ total: 0, url: "http://127.0.0.1/" }) } as unknown as DrivableWebview;
    const r = await runGuide(guest, ask("point", { selector: "a.c", text: "9 comments", say: "Click '9 comments'." }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('with text "9 comments"');
  });
});

describe("the card (F5 say, F9 lost, F7 Resume)", () => {
  const started = (): Activity => {
    let s: Activity = {};
    s = activityReducer(s, { kind: "guide", tab: T, phase: "start", say: "Sign up", run: true, at: 1 });
    s = activityReducer(s, { kind: "guide", tab: T, phase: "point", say: "Click the 'Start' button.", step: { n: 2, m: 4 }, at: 2 });
    return s;
  };
  test("guide say changes the words in place; the step count stays", () => {
    const s = activityReducer(started(), { kind: "guide", tab: T, phase: "say", say: "Click the green 'Start' button." });
    const steps = s[T]!.guide!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ say: "Click the green 'Start' button.", n: 2, m: 4 });
  });
  test("a lost target: the sentence, and Back and Stop, even on step 1", () => {
    const s = activityReducer(started(), { kind: "guide", tab: T, phase: "say", say: "Can't find Start here. Back?", lost: true });
    const b = bubbleOf(s[T]!.guide!.steps[0]!, true);
    expect(b.text).toBe("Can't find Start here. Back?");
    expect(b.buttons).toEqual(["back", "stop"]);
  });
  test("a run's Stop leaves Resume for 10 minutes; a plain guide's does not", () => {
    const s = activityReducer(started(), { type: "guideAnswer", tab: T, answer: "stop", at: 100 });
    expect(s[T]!.guide).toMatchObject({ on: false, resumeUntil: 100 + GUIDE_RESUME_MS });
    let p: Activity = activityReducer({}, { kind: "guide", tab: T, phase: "start", say: "One step", at: 1 });
    p = activityReducer(p, { type: "guideAnswer", tab: T, answer: "stop", at: 100 });
    expect(p[T]!.guide!.resumeUntil).toBeUndefined();
  });
});

describe("the end of a run (OK on the last step, run-done)", () => {
  const atLast = (): Activity => {
    let s: Activity = activityReducer({}, { kind: "guide", tab: T, phase: "start", say: "Sign up", run: true, at: 1 });
    for (let n = 1; n <= 4; n++) {
      s = activityReducer(s, { kind: "guide", tab: T, phase: "point", say: `Step ${n}`, step: { n, m: 4 }, at: n * 10 });
      if (n < 4) s = activityReducer(s, { type: "guideAnswer", tab: T, answer: "ok", at: n * 10 + 5 });
    }
    return s;
  };
  test("OK on the last step ends the card at once: Done · 4 steps for 2 s, then gone, no Resume", () => {
    const s = activityReducer(atLast(), { type: "guideAnswer", tab: T, answer: "ok", at: 100 });
    const g = s[T]!.guide!;
    expect(g).toMatchObject({ on: false, endedAt: 100 });
    expect(guideCard(g)).toMatchObject({ title: "Done \u00b7 4 steps", done: true });
    expect(auditLeft(g, 100)).toBe(GUIDE_DONE_MS);
    expect(auditLeft(g, 100 + GUIDE_DONE_MS)).toBe(0);
    expect(guideResumable(g, 101)).toBe(false);
    expect(auditAfterFade(g, 100 + GUIDE_DONE_MS)).toBe("gone");
  });
  test("OK on a step before the last does not end the run", () => {
    let s: Activity = activityReducer({}, { kind: "guide", tab: T, phase: "start", run: true, at: 1 });
    s = activityReducer(s, { kind: "guide", tab: T, phase: "point", say: "Step 3", step: { n: 3, m: 4 }, at: 2 });
    s = activityReducer(s, { type: "guideAnswer", tab: T, answer: "ok", at: 3 });
    expect(s[T]!.guide!.on).toBe(true);
  });
  test("the server's end after it keeps the card's clock; after a close it brings no empty card back", () => {
    const s = activityReducer(activityReducer(atLast(), { type: "guideAnswer", tab: T, answer: "ok", at: 100 }), { kind: "guide", tab: T, phase: "end", at: 900 });
    expect(s[T]!.guide!.endedAt).toBe(100);
    const closed = activityReducer(s, { type: "guideAnswer", tab: T, answer: "close", at: 950 });
    expect(activityReducer(closed, { kind: "guide", tab: T, phase: "end", at: 990 })[T]!.guide).toBeUndefined();
  });
  test("run-done (end with no Stop) never offers Resume; the person's Stop does", () => {
    const done = activityReducer(atLast(), { kind: "guide", tab: T, phase: "end", at: 100 });
    expect(guideResumable(done[T]!.guide!, 101)).toBe(false);
    expect(auditLeft(done[T]!.guide!, 100)).toBe(GUIDE_DONE_MS);
    const stopped = activityReducer(activityReducer(atLast(), { type: "guideAnswer", tab: T, answer: "stop", at: 100 }), { kind: "guide", tab: T, phase: "end", at: 200 });
    const g = stopped[T]!.guide!;
    expect(guideResumable(g, 201)).toBe(true);
    expect(guideCard(g).title).toBe("Guide stopped");
    expect(auditLeft(g, 100)).toBe(GUIDE_AUDIT_MS);
    expect(auditAfterFade(g, 100 + GUIDE_AUDIT_MS)).toBe("small");
  });
  test("a stale resumeUntil without the person's Stop is not Resume", () => {
    expect(guideResumable({ run: true, resumeUntil: 1e12, steps: [{ n: 4, m: 4, say: "x", waitClick: false, at: 1, did: "ok" }] }, 2)).toBe(false);
  });
});
