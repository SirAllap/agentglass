/*
 * guide run: a plan the server walks on the panel's events.
 *
 * An agent declares N steps once; the panel reports the person's hand on the
 * page (a click on the target, typing, a submit, a navigation, the target
 * gone) over POST /browser/guide/event, and the server moves the plan on with
 * no agent call. The agent reads one event per `guide next`, in order. These
 * drive the runner itself and the real door (`parseAsk`, `askBrowser`,
 * `guidePanelEvent`) against a stand-in panel. Fakes only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setBrowserAsker, askBrowser, guidePanelEvent, lostSay, parseAsk, resetBrowserDrive, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import {
  RESUME_MS, RUN_EVENT_CAP, guideLock, guideOf, lintPlan, parsePlan, resetGuides, resumeRun, runInput, runSummary,
  NAV_SETTLE_MS, sayStandsAlone, setGuideClock, startGuide, startRun, takeRunEvent, type Guide, type PlanStep,
} from "../src/browserGuide.ts";

const prevState = process.env.AGENTGLASS_STATE_DIR;
beforeAll(() => { process.env.AGENTGLASS_STATE_DIR = mkdtempSync(join(tmpdir(), "agx-guide-run-")); });
afterAll(() => { if (prevState === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = prevState; });

let now = Date.parse("2026-11-13T15:02:00");
let seen: BrowserAsk[] = [];
beforeEach(() => {
  resetBrowserDrive();
  now = Date.parse("2026-11-13T15:02:00");
  seen = [];
  setGuideClock(() => now);
  __setBrowserAsker(async (a): Promise<BrowserReply> => {
    seen.push(a);
    if (a.op === "tabs") return { ok: true, value: [{ id: "t1", active: true }] };
    return { ok: true, value: {} };
  });
});
afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });

/* An invented sign-up page: click, type, navigate, submit. */
const FOUR: PlanStep[] = [
  { target: "#start", say: "Click the 'Start' button.", wait: "click" },
  { target: "#name", say: "Type your name in the 'Name' box.", wait: "input" },
  { target: "a.next", say: "Click 'Next page'.", wait: "nav" },
  { target: "form#signup", say: "Press 'Send' to send the form.", wait: "submit" },
];

function begin(steps: PlanStep[] = FOUR): Guide {
  const st = startGuide("t1", "orbit-guide", "Sign up on the test page");
  if ("error" in st) throw new Error(st.error);
  startRun(st.guide, steps.map((s) => ({ ...s })));
  return st.guide;
}
const drain = (g: Guide) => { const out = []; for (let e = takeRunEvent(g); e; e = takeRunEvent(g)) out.push(e); return out; };
const visit = (g: Guide) => g.run!.visits.length;

describe("the plan (Decisions: F8 selectors only, F10 five waits)", () => {
  test("an observe id is refused; selectors with text are kept", () => {
    const bad = parsePlan([{ target: "e14", say: "Click 'Save'." }]);
    expect("error" in bad && bad.error).toContain("observe id");
    const ok = parsePlan({ steps: [{ target: "a.comments", text: "2 comments", say: "Click '2 comments'." }] });
    expect("steps" in ok && ok.steps[0]).toEqual({ target: "a.comments", text: "2 comments", say: "Click '2 comments'.", wait: "click" });
  });
  test("default wait is click with a target and ok without; a sixth wait is refused", () => {
    const p = parsePlan([{ say: "Read the 'Terms' page." }, { target: "#x", say: "Click 'X'." }]);
    expect("steps" in p && p.steps.map((s) => s.wait)).toEqual(["ok", "click"]);
    expect("error" in parsePlan([{ target: "#x", say: "Click 'X'.", wait: "hover" }])).toBe(true);
    expect("error" in parsePlan([{ say: "Type 'x'.", wait: "input" }])).toBe(true);
    expect("error" in parsePlan([{ target: "#x", say: "Click 'X'.", act: "click" }])).toBe(true);
  });
});

describe("the run (F5 steps and index, F7 N fixed)", () => {
  test("four steps, each on its own wait, end in run-done with N unchanged", () => {
    const g = begin();
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "input", visit: visit(g) });
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/page2" });
    runInput(g, { event: "submit", visit: visit(g) });
    const evs = drain(g);
    expect(evs.filter((e) => e.event === "step").map((e) => `${e.step}/${e.of}`)).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    const done = evs[evs.length - 1]!;
    expect(done.event).toBe("run-done");
    expect(done.endedBy).toBe("done");
    expect((done.summary as unknown[]).length).toBe(4);
    expect(g.run!.endedBy).toBe("done");
  });

  test("only the step's own wait moves it on: clicking a text box is not typing in it", () => {
    const g = begin();
    runInput(g, { event: "click", visit: visit(g) });
    expect(g.run!.index).toBe(1);
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g) });
    runInput(g, { event: "submit", visit: visit(g) });
    runInput(g, { event: "ok", visit: visit(g) });
    expect(g.run!.index).toBe(1);
    runInput(g, { event: "input", visit: visit(g) });
    expect(g.run!.index).toBe(2);
  });

  test("a submit whose report was lost to the unload: the press in the form, then the navigation, ends the step", () => {
    const g = begin([{ target: "form#signup", say: "Press 'Send' to send the form.", wait: "submit" }]);
    runInput(g, { event: "navigated", visit: visit(g) });
    expect(g.run!.endedAt).toBeUndefined();
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/sent" });
    expect(g.run!.endedBy).toBe("done");
    expect(runSummary(g.run!).rows[0]!.endedBy).toBe("submit");
  });

  test("an event of a visit no longer on the card moves nothing", () => {
    const g = begin();
    const old = visit(g);
    runInput(g, { event: "click", visit: old });
    runInput(g, { event: "input", visit: old });
    expect(g.run!.index).toBe(1);
  });

  test("Back goes one step back and never ends the guide; from step 1 it stays on 1", () => {
    const g = begin();
    runInput(g, { event: "back", visit: visit(g) });
    expect(g.run!.index).toBe(0);
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "input", visit: visit(g) });
    runInput(g, { event: "back", visit: visit(g) });
    expect(g.run!.index).toBe(1);
    expect(g.run!.endedAt).toBeUndefined();
  });
});

describe("the summary (F6 one row per visit, F7 clicks)", () => {
  test("every visit is a row, in order, with endedBy, seconds, url and clicks", () => {
    const g = begin();
    runInput(g, { event: "click", visit: visit(g) });               // 1: target
    now += 4000;
    runInput(g, { event: "input", visit: visit(g) });               // 2: input
    runInput(g, { event: "back", visit: visit(g) });                // 3: back
    runInput(g, { event: "click", visit: visit(g) });               // 2 again: a click on the field, not the wait
    runInput(g, { event: "input", visit: visit(g) });               // 2: input
    runInput(g, { event: "click", visit: visit(g) });               // 3: the press on the link
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/b" }); // 3: nav
    runInput(g, { event: "submit", visit: visit(g) });              // 4: submit
    const rows = runSummary(g.run!).rows;
    expect(rows.map((r) => `${r.n}.${r.visit}:${r.endedBy}`)).toEqual(["1.1:target", "2.1:input", "3.1:back", "2.2:input", "3.2:nav", "4.1:submit"]);
    expect(rows.length).toBe(6);
    expect(rows[0]!.clicks).toBe(1);
    expect(rows[3]!.clicks).toBe(1);
    expect(rows[1]!.seconds).toBe(4);
    expect(rows[5]!.url).toBe("http://127.0.0.1:4321/b");
  });

  /* One row per visit: the step left by Back is a visit, and so is each step
     seen again, so one Back from step 3 on 4 steps is 1, 2, 3, 2, 3, 4. */
  test("Back from step 3 lands on 2, and every visit is its own row", () => {
    const g = begin();
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "input", visit: visit(g) });
    runInput(g, { event: "back", visit: visit(g) });
    expect(g.run!.index).toBe(1);
    runInput(g, { event: "input", visit: visit(g) });
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g) });
    runInput(g, { event: "submit", visit: visit(g) });
    expect(runSummary(g.run!).rows.map((r) => `${r.n}:${r.endedBy}`)).toEqual(["1:target", "2:input", "3:back", "2:input", "3:nav", "4:submit"]);
  });
});

describe("a nav step waits for the person's own press", () => {
  /* Measured on a wiki: Back from a lost step onto a nav step was answered at
     once by the page's own redirect (an article moved to a new title), and
     the person was sent on, four times. */
  const NAV: PlanStep[] = [
    { target: "a.moved", say: "Click 'Old title'.", wait: "nav" },
    { say: "Read the page, then press OK.", wait: "ok" },
  ];
  test("a redirect with no press on the target does not answer it; the press, then the navigation, does", () => {
    const g = begin(NAV);
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/new-title?redirect=no" });
    expect(g.run!.index).toBe(0);
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/new-title" });
    expect(g.run!.index).toBe(1);
  });
  test("Back onto the nav step starts it with no press: the redirect that follows does not bounce it on", () => {
    const g = begin(NAV);
    runInput(g, { event: "click", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g) });
    runInput(g, { event: "back", visit: visit(g) });
    expect(g.run!.index).toBe(0);
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/new-title?redirect=no" });
    expect(g.run!.index).toBe(0);
  });
  test("a form the person sent from the target counts as the press", () => {
    const g = begin([{ target: "form#search", say: "Search for 'orbit'.", wait: "nav" }]);
    runInput(g, { event: "submit", visit: visit(g) });
    runInput(g, { event: "navigated", visit: visit(g) });
    expect(g.run!.endedBy).toBe("done");
  });
  test("a nav step with no target: a redirect in its first moments is the page's, a later navigation answers it", () => {
    const g = begin([{ say: "Open the settings page.", wait: "nav" }]);
    runInput(g, { event: "navigated", visit: visit(g), url: "http://127.0.0.1:4321/new-title?redirect=no" });
    expect(g.run!.endedAt).toBeUndefined();
    now += NAV_SETTLE_MS;
    runInput(g, { event: "navigated", visit: visit(g) });
    expect(g.run!.endedBy).toBe("done");
  });
});

describe("lost (F9, F10)", () => {
  test("the agent gets lost once with the URL, and the run waits on the step until Back", () => {
    const g = begin();
    runInput(g, { event: "click", visit: visit(g) });
    drain(g);
    expect(runInput(g, { event: "lost", visit: visit(g), url: "http://127.0.0.1:4321/x" })).toBe("lost");
    expect(runInput(g, { event: "lost", visit: visit(g) })).toBe(null);
    const evs = drain(g);
    expect(evs).toEqual([{ event: "lost", step: 2, url: "http://127.0.0.1:4321/x" }]);
    expect(g.run!.index).toBe(1);
    runInput(g, { event: "back", visit: visit(g) });
    expect(g.run!.index).toBe(0);
  });
});

describe("the queue (F3 cap)", () => {
  test("at 200 events the run ends with overflow, and run-done is the 200th", () => {
    const g = begin([{ target: "#a", say: "Click 'A'.", wait: "click" }, { target: "#b", say: "Click 'B'.", wait: "click" }]);
    for (let i = 0; i < 400; i++) runInput(g, { event: "back", visit: visit(g) });
    const evs = drain(g);
    expect(evs.length).toBe(RUN_EVENT_CAP);
    expect(evs[evs.length - 1]!.event).toBe("run-done");
    expect(evs[evs.length - 1]!.endedBy).toBe("overflow");
  });
});

describe("the lock (Risk, F2 restart)", () => {
  test("a guided tab refuses every agent act while a run goes, the owner's too", () => {
    begin();
    expect(guideLock("click", true, "t1", true, "orbit-guide")).toContain("guide mode");
    expect(guideLock("fill", true, "t1", true, "someone-else")).toContain("guide mode");
  });

  test("a restart ends the run with restart and keeps the tab locked", () => {
    const g = begin();
    runInput(g, { event: "click", visit: visit(g) });
    resetGuides(true); // the server comes back and reads the file again
    const back = guideOf("t1")!;
    expect(back.run!.endedBy).toBe("restart");
    expect(back.run!.queue.some((e) => e.event === "run-done" && e.endedBy === "restart")).toBe(true);
    expect(guideLock("click", true, "t1", true, "orbit-guide")).toContain("guide mode");
  });
});

describe("Resume (F7, F11)", () => {
  test("within 10 minutes: the lock again, the step it ended on, and resumed to the agent", async () => {
    begin();
    await guidePanelEvent({ tab: "t1", event: "click", visit: 1 });
    const r = await guidePanelEvent({ tab: "t1", event: "stop" });
    expect(r.ok).toBe(true);
    expect(guideLock("click", true, "t1", true, "orbit-guide")).toBe(null);
    now += RESUME_MS - 1000;
    const again = await guidePanelEvent({ tab: "t1", event: "resume" });
    expect(again.ok).toBe(true);
    const g = guideOf("t1")!;
    expect(g.as).toBe("orbit-guide");
    expect(g.run!.index).toBe(1);
    expect(guideLock("click", true, "t1", true, "orbit-guide")).toContain("guide mode");
    expect(drain(g).some((e) => e.event === "resumed" && e.step === 2)).toBe(true);
  });

  test("after 10 minutes there is no Resume", async () => {
    begin();
    await guidePanelEvent({ tab: "t1", event: "stop" });
    now += RESUME_MS + 1000;
    const r = resumeRun("t1");
    expect("error" in r && r.error).toContain("10 minutes");
  });
});

describe("the panel's route (F1)", () => {
  test("a step's event draws the next step with a point and its visit; nothing that acts is sent", async () => {
    begin();
    await guidePanelEvent({ tab: "t1", event: "click", visit: 1 });
    const point = seen.find((a) => a.op === "point")!;
    expect(point.args.selector).toBe("#name");
    expect(point.args.wait).toBe("input");
    expect(point.args.run).toEqual({ visit: 2 });
    expect(seen.every((a) => a.op === "point" || a.op === "guide" || a.op === "tab")).toBe(true);
  });

  test("lost tells the person on the card, as text", async () => {
    begin([{ target: "a.reply", text: "reply", say: "Click 'reply'.", wait: "click" }]);
    await guidePanelEvent({ tab: "t1", event: "lost", visit: 1 });
    const say = seen.find((a) => a.op === "guide" && a.args.action === "say")!;
    expect((say.args.activity as { say: string; lost: boolean })).toMatchObject({ say: "Can't find \"reply\" on this page. Back?", lost: true });
  });

  test("lost on an OK step offers Skip, and Skip (its OK) moves the run on; a click step's lost card does not", async () => {
    begin([{ target: "#notes", say: "Read the notes, then press OK.", wait: "ok" }, { target: "a.reply", say: "Click 'reply'.", wait: "click" }]);
    await guidePanelEvent({ tab: "t1", event: "lost", visit: 1 });
    const say = seen.find((a) => a.op === "guide" && a.args.action === "say")!;
    expect(say.args.activity).toMatchObject({ lost: true, skip: true });
    seen = [];
    await guidePanelEvent({ tab: "t1", event: "ok", visit: 1 });
    expect(guideOf("t1")!.run!.index).toBe(1);
    await guidePanelEvent({ tab: "t1", event: "lost", visit: 2 });
    const again = seen.find((a) => a.op === "guide" && a.args.action === "say")!;
    expect(again.args.activity).toMatchObject({ lost: true });
    expect((again.args.activity as { skip?: boolean }).skip).toBeUndefined();
  });

  test("lost says the target in words, never the raw selector", () => {
    expect(lostSay({ target: 'role=link[name="History"]' })).toBe('Can\'t find "History" on this page. Back?');
    expect(lostSay({ target: "text=Sign in" })).toBe('Can\'t find "Sign in" on this page. Back?');
    expect(lostSay({ target: 'role=link[name="History"]', text: "History link" })).toBe('Can\'t find "History link" on this page. Back?');
    expect(lostSay({ target: "a.reply > span" })).toBe("Can't find it on this page. Back?");
    expect(lostSay({ target: "testid=save" })).not.toContain("testid=");
  });

  test("POST /browser/guide/event is a window-only route behind the desk key", async () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/WINDOW_ONLY_OPS[^\n]*"guide\/event"/);
    const at = src.indexOf('if (op === "guide/event") {');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 300)).toContain("mayHostBrowser(req)");
  });
});

describe("the agent's verbs (F6 run, F9 wait flags, F5 say and text)", () => {
  test("guide run needs page, why and a plan; the answer carries lint warnings", async () => {
    expect("error" in parseAsk("guide", { action: "run", why: "x", plan: FOUR })).toBe(true);
    expect("error" in parseAsk("guide", { action: "run", page: "t1", plan: FOUR })).toBe(true);
    const p = parseAsk("guide", { action: "run", page: "t1", why: "Sign up", as: "orbit-guide", plan: [...FOUR, { say: "Search for it like you would" }] });
    if ("error" in p) throw new Error(p.error);
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(true);
    const v = r.value as { steps: number; warnings: string[] };
    expect(v.steps).toBe(5);
    expect(v.warnings.length).toBe(1);
    expect(v.warnings[0]).toContain("step 5");
    /* The first step is drawn by the server, with its selector. */
    expect(seen.find((a) => a.op === "point")!.args.selector).toBe("#start");
  });

  test("guide next on a run returns the queued events in order", async () => {
    const p = parseAsk("guide", { action: "run", page: "t1", why: "Sign up", as: "orbit-guide", plan: FOUR });
    if ("error" in p) throw new Error(p.error);
    await askBrowser(p.ask);
    await guidePanelEvent({ tab: "t1", event: "click", visit: 1 });
    const next = async () => { const q = parseAsk("guide", { action: "next", as: "orbit-guide", waitMs: 0 }); if ("error" in q) throw new Error(q.error); return (await askBrowser(q.ask)).value as Record<string, unknown>; };
    expect(await next()).toMatchObject({ event: "step", step: 1, of: 4 });
    expect(await next()).toMatchObject({ event: "step", step: 2, of: 4 });
    expect(await next()).toMatchObject({ pending: true, step: 2, of: 4 });
  });

  test("point takes --wait-* and --text; guide say takes the card's new words", () => {
    for (const w of ["ok", "click", "nav", "input", "submit"]) {
      const p = parseAsk("point", { selector: "#q", say: "Type 'hello'.", wait: w, text: "Search" });
      expect("ask" in p && p.ask.args.wait).toBe(w);
    }
    expect("error" in parseAsk("point", { selector: "#q", say: "x", wait: "hover" })).toBe(true);
    const s = parseAsk("guide", { action: "say", say: "Click 'Reply' under the first comment." });
    expect("ask" in s && s.ask.args.say).toBe("Click 'Reply' under the first comment.");
  });

  test("guide say changes the card on screen in place", async () => {
    const p = parseAsk("guide", { action: "run", page: "t1", why: "Sign up", as: "orbit-guide", plan: FOUR });
    if ("error" in p) throw new Error(p.error);
    await askBrowser(p.ask);
    const q = parseAsk("guide", { action: "say", as: "orbit-guide", say: "Click the green 'Start' button." });
    if ("error" in q) throw new Error(q.error);
    const r = await askBrowser(q.ask);
    expect(r.value).toEqual({ step: 1, say: "Click the green 'Start' button." });
    expect(guideOf("t1")!.run!.steps[0]!.say).toBe("Click the green 'Start' button.");
    expect(seen.some((a) => a.op === "guide" && a.args.action === "say")).toBe(true);
  });
});

describe("lint (F4 Preflight 3)", () => {
  const PASS = [
    "Click the 'Reply' button.",
    "Type: hello world",
    "Open: Settings",
    "Click: Save",
    'Write "Thanks for the fix" in the box.',
    "Scroll down to the comments.",
    "Select the second row.",
    "Press Enter to send.",
    "Paste the command into the terminal box.",
    "Step two: click the Submit button.",
  ];
  const FAIL = [
    "Search for it like you would",
    "Do the thing we talked about.",
    "Now the next one.",
    "Click it.",
    "Open this.",
    "Read that.",
    "Go ahead.",
    "Same as before.",
    "Choose something.",
    "Copy it like you did.",
  ];
  test.each(PASS)("stands alone: %s", (s) => { expect(sayStandsAlone(s)).toBe(true); });
  test.each(FAIL)("flagged: %s", (s) => { expect(sayStandsAlone(s)).toBe(false); });
  test("a warning, never a refusal", () => {
    expect(lintPlan([{ say: "Search for it like you would", wait: "ok" }]).length).toBe(1);
    expect("steps" in parsePlan([{ say: "Search for it like you would" }])).toBe(true);
  });
});
