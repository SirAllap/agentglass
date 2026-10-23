import { readFileSync } from "node:fs";
import { FLASH_MS, flashScript } from "../src/lib/browserDrive.ts";
import { describe, expect, test } from "bun:test";
import {
  glassHeld, pageOf,
  LOG_MAX, steadyStep, STEADY_INIT, CANDIDATE_MS, MIN_SHOW_MS, activityReducer, actionOf, agentLabel, doneMayMark, agentState, boxState, lookAt, pointerAt, tabState, IDLE_RELEASE_MS, ago, flashPlan, isActVerb, lapKeyframes, pausedRefusal, presenceLabel, travelMs, type Activity,
} from "../src/lib/browserAgentActivity.ts";

const begin = (s: Activity, tab = "t1", agent = "orbit-ci") => activityReducer(s, { type: "begin", tab, agent });

describe("agent activity per tab", () => {
  test("done marks the tab and the agent's next ask clears it", () => {
    const d = activityReducer(activityReducer(begin({}), { type: "end", tab: "t1", action: null }), { type: "done", tab: "t1" });
    expect(d.t1!.done).toBe(true);
    expect(d.t1!.working).toBe(0);
    expect(begin(d).t1!.done).toBeUndefined();
  });
  // A `done` sent while an act is still in flight read as finished: the glass came down mid-act.
  test("done is ignored while an ask is in flight", () => {
    const s = begin({});
    const d = activityReducer(s, { type: "done", tab: "t1" });
    expect(d).toBe(s);
    expect(d.t1!.working).toBe(1);
    expect(d.t1!.done).toBeUndefined();
  });
  // Only the agent driving the tab may say it is finished; `--page` and a caller with no name skip the container check.
  test("done marks the tab only for the agent that drives it", () => {
    const s = activityReducer(begin({}), { type: "end", tab: "t1", action: null });
    expect(doneMayMark(s.t1, "orbit-ci")).toBe(true);
    expect(doneMayMark(s.t1, " orbit-ci ")).toBe(true);
    expect(doneMayMark(s.t1, "acme-bot")).toBe(false);
    expect(doneMayMark(s.t1, undefined)).toBe(false);
    expect(doneMayMark(s.t1, "")).toBe(false);
    expect(doneMayMark(undefined, "orbit-ci")).toBe(false);
  });
  test("the panel marks a tab done only through that check", () => {
    const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('if (doneMayMark(actsRef.current[owner.id], ask.args.as)) dispatchAct({ type: "done", tab: owner.id });');
    expect(panel.match(/type: "done"/g)?.length).toBe(1);
  });
  test("working counts asks in flight and returns to quiet", () => {
    let s = begin(begin({}));
    expect(s.t1!.working).toBe(2);
    s = activityReducer(s, { type: "end", tab: "t1", action: null });
    s = activityReducer(s, { type: "end", tab: "t1", action: null });
    s = activityReducer(s, { type: "end", tab: "t1", action: null });
    expect(s.t1!.working).toBe(0);
  });
  test("the log keeps the last LOG_MAX actions, oldest dropped", () => {
    let s = begin({});
    for (let i = 0; i < LOG_MAX + 5; i++) {
      s = activityReducer(s, { type: "end", tab: "t1", action: { verb: "click", target: `#b${i}`, ok: true, at: i } });
    }
    expect(s.t1!.log.length).toBe(LOG_MAX);
    expect(s.t1!.log[0]!.target).toBe("#b5");
  });
  test("pause is remembered across asks and refuses nothing on an untouched tab", () => {
    expect(activityReducer({}, { type: "pause", tab: "t9", paused: true })).toEqual({});
    let s = activityReducer(begin({}), { type: "pause", tab: "t1", paused: true });
    s = begin(s, "t1", "other");
    expect(s.t1!.paused).toBe(true);
    expect(s.t1!.agent).toBe("other");
    s = activityReducer(s, { type: "pause", tab: "t1", paused: false });
    expect(s.t1!.paused).toBe(false);
  });
  test("forget drops a closed tab", () => {
    expect(activityReducer(begin({}), { type: "forget", tab: "t1" })).toEqual({});
  });
});

describe("what is written down", () => {
  test("a fill logs field names only, never values", () => {
    const a = actionOf({ op: "fill", args: { fields: { "#email": "a@acme.test", "#pw": "hunter2" } } }, true, 5)!;
    expect(a.target).toBe("#email +1");
    expect(JSON.stringify(a)).not.toContain("hunter2");
  });
  test("type logs the selector, not the text", () => {
    const a = actionOf({ op: "type", args: { selector: "#pw", text: "hunter2" } }, false, 5)!;
    expect(a).toEqual({ verb: "type", target: "#pw", ok: false, at: 5 });
  });
  test("reads are not rows", () => {
    expect(actionOf({ op: "observe", args: {} }, true, 1)).toBeNull();
    expect(isActVerb("shot")).toBe(false);
  });
  test("a long selector is clipped to one line", () => {
    expect(actionOf({ op: "click", args: { selector: "x".repeat(300) } }, true, 1)!.target.length).toBe(80);
  });
});

describe("the flash and the labels", () => {
  test("plans", () => {
    expect(flashPlan({ op: "click", args: { selector: "e17" } })).toEqual({ kind: "selector", selector: "e17" });
    expect(flashPlan({ op: "fill", args: { fields: { "#a": "1" } } })).toEqual({ kind: "selector", selector: "#a" });
    expect(flashPlan({ op: "press", args: { key: "Enter" } })).toEqual({ kind: "focus" });
    expect(flashPlan({ op: "observe", args: { selector: "x" } })).toBeNull();
  });
  test("labels", () => {
    expect(agentLabel(" wf-probe ", "orbit")).toBe("wf-probe");
    expect(agentLabel("", "orbit")).toBe("orbit");
    expect(agentLabel(undefined, "default")).toBe("agent");
  });
  test("refusal says what to do", () => {
    expect(pausedRefusal("wf-probe")).toContain("took this tab over");
    expect(pausedRefusal("wf-probe")).toContain("open --as wf-probe");
  });
  test("ago", () => { expect(ago(65_000, 0)).toBe("1m"); expect(ago(3000, 0)).toBe("3s"); });
});

describe("the panel is wired to it", () => {
  const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
  test("an ask on a tab is counted in flight and written down when it answers", () => {
    expect(panel.includes('dispatchAct({ type: "begin"')).toBe(true);
    expect(panel.includes("actionOf(ask, ok, Date.now())")).toBe(true);
    expect(panel.includes('dispatchAct({ type: "forget"')).toBe(true);
  });
  test("the badge is drawn in the bar and in the toolbar", () => {
    expect(panel.includes("<AgentPill")).toBe(true);
    expect(panel.includes("<AgentChip")).toBe(true);
  });
});

describe("taking a tab over", () => {
  const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
  test("a paused tab refuses before anything reaches the page", () => {
    const h = panel.slice(panel.indexOf("setBrowserAskHandler((ask) => {"), panel.indexOf("setBrowserAskHandler(null)"));
    const refuse = h.indexOf("pausedRefusal(");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(h.indexOf("const serve = "));
    expect(h.slice(refuse - 300, refuse + 200)).toContain("client: clientId()");
  });
  test("the toolbar has the control", () => {
    expect(panel.includes('type: "pause"')).toBe(true);
  });
});

describe("the flash where an agent acted", () => {
  const sel = flashScript({ kind: "selector", selector: "#save" });
  test("it is inert, short, and gone by itself", () => {
    expect(sel).toContain("pointer-events:none");
    expect(sel).toContain(`setTimeout(() => box.remove(), ${FLASH_MS})`);
    expect(FLASH_MS).toBe(600);
  });
  test("reduced motion gets the outline with no transition", () => {
    expect(sel).toContain("prefers-reduced-motion: reduce");
    expect(sel).toContain('(calm ? "" : "transition:');
  });
  test("it uses the system colour, none of ours", () => {
    expect(sel).toContain("Highlight");
    expect(sel).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
  test("a focus plan starts from the focused element and the selector one from the locator", () => {
    expect(flashScript({ kind: "focus" })).toContain("document.activeElement");
    expect(sel).toContain("#save");
  });
  test("the driver flashes only an answer that succeeded", () => {
    const d = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");
    const fn = d.slice(d.indexOf("export async function runBrowserAsk("), d.indexOf("export const FLASH_MS"));
    expect(fn.includes("if (reply.ok) flashWhereActed(")).toBe(true);
  });
  // The pointer set off when the act answered, a page load behind every click.
  test("the pointer is aimed before the act runs, and the aim draws nothing", () => {
    const d = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");
    const fn = d.slice(d.indexOf("export async function runBrowserAsk("), d.indexOf("export const FLASH_MS"));
    expect(fn.indexOf("aimAt(a[0], ask);")).toBeGreaterThan(-1);
    expect(fn.indexOf("aimAt(a[0], ask);")).toBeLessThan(fn.indexOf("await runVerb("));
    expect(flashScript({ kind: "focus" }, 700, false)).toContain("if (false)");
  });
});

describe("the log opens from the badge", () => {
  const badge = readFileSync(new URL("../src/components/browser/AgentBadge.tsx", import.meta.url), "utf8");
  test("it is an existing popover and shows the four things a row owes", () => {
    expect(badge.includes("<AnchoredMenu")).toBe(true);
    for (const f of ["r.verb", "r.target", "r.ok", "ago(now, r.at)"]) expect(badge.includes(f)).toBe(true);
  });
  test("a row only ever reads the fields the log stores, never a value", () => {
    expect(badge.includes(".text")).toBe(false);
    expect(badge.includes(".fields")).toBe(false);
  });
});

describe("the presence drawn over a driven tab", () => {
  test("the pointer's words name the element, never what was typed", () => {
    expect(presenceLabel("type", "Email")).toBe("Typing in Email");
    expect(presenceLabel("press", "", "Enter")).toBe("Pressing Enter");
    expect(presenceLabel("click", "")).toBe("Clicking");
    const sel = flashScript({ kind: "selector", selector: "#email" });
    // the landing reads a label, a placeholder or visible text — a field's value is never read.
    // Sliced to the landing's own lines: the shared locator before it reads button values on purpose.
    const own = sel.slice(sel.indexOf("Where it landed"));
    expect(own).toContain('e.getAttribute("placeholder")');
    expect(own).not.toContain(".value");
    // a rich-text editor's visible text IS what was typed: an editor is named by its label or nothing
    expect(own).toMatch(/const editor = e\.isContentEditable[^;]*role[^;]*textbox/);
    expect(own).toContain('(editor ? "" : e.innerText)');
  });
  test("travel grows with distance and stays inside its clamp", () => {
    expect(travelMs(0, 0)).toBe(110);
    expect(travelMs(3000, 0)).toBe(240);
    expect(travelMs(200, 0)).toBeGreaterThan(travelMs(50, 0));
  });
  test("the lap stays inside the page on every keyframe, corners included", () => {
    const W = 1066, H = 560, inset = 7;
    const kf = lapKeyframes(W, H, inset, 10);
    expect(kf.length).toBeGreaterThan(8);
    expect(kf[0]!.offset).toBe(0);
    expect(kf[kf.length - 1]!.offset).toBe(1);
    let prev = -1;
    for (const f of kf) {
      expect(f.offset).toBeGreaterThanOrEqual(prev);
      prev = f.offset;
      const m = f.transform.match(/translate\(([\d.]+)px, ([\d.]+)px\)/);
      expect(m).not.toBeNull();
      const [x, y] = [Number(m![1]), Number(m![2])];
      expect(x).toBeGreaterThanOrEqual(inset - 0.01);
      expect(x).toBeLessThanOrEqual(W - inset + 0.01);
      expect(y).toBeGreaterThanOrEqual(inset - 0.01);
      expect(y).toBeLessThanOrEqual(H - inset + 0.01);
    }
  });
  test("a page too small for the rounded path gets no lap rather than a broken one", () => {
    expect(lapKeyframes(20, 20)).toEqual([]);
  });
});

describe("the dock's state word", () => {
  const st = (working: number, op?: string, paused = false) => agentState({ working, op, paused }).word;
  test("one capitalised word per kind of act, a read for the rest, Thinking between asks", () => {
    expect(st(1, "click")).toBe("Clicking");
    expect(st(1, "fill")).toBe("Typing");
    expect(st(1, "back")).toBe("Navigating");
    expect(st(1, "observe")).toBe("Reading");
    // Busy with no named op: neutral, not a guess at a read.
    expect(st(1)).toBe("Working");
    expect(st(0, "click")).toBe("Thinking");
    expect(st(1, "click", true)).toBe("You have it");
  });
  test("the op of the ask begun is kept on the tab", () => {
    const s = activityReducer({}, { type: "begin", tab: "t1", agent: "orbit-ci", op: "type" });
    expect(s.t1!.op).toBe("type");
  });
});

describe("where the pointer lands", () => {
  // A guest zoomed out to 2319 CSS px inside a 2514 px panel put the pointer rows below the element.
  test("converts guest pixels to the panel's through the two widths", () => {
    const l = { x: 100, y: 600, w: 200, h: 40, vw: 2319 };
    const p = pointerAt(l, 2514);
    expect(p.y).toBe(Math.round(620 * (2514 / 2319)) - 2);
    expect(p.x).toBe(Math.round(134 * (2514 / 2319)) - 3);
  });
  test("an unzoomed guest is taken as it is", () => {
    expect(pointerAt({ x: 10, y: 20, w: 40, h: 10, vw: 800 }, 800)).toEqual({ x: 27, y: 23 });
  });
});

describe("the overview's states", () => {
  const a = (working: number, at = 0, paused = false) => ({ agent: "orbit-ci", working, paused, log: at ? [{ verb: "click", target: "", ok: true, at }] : [], op: "click" });
  // "idle" told nobody the agent had finished.
  test("an act in flight, then Thinking, then Waiting", () => {
    const now = 1_000_000;
    expect(tabState(a(1), undefined, now)?.word).toBe("Clicking");
    expect(tabState(a(0, now - 1000), undefined, now)?.word).toBe("Clicking");
    expect(tabState(a(0, now - 5000), undefined, now)?.word).toBe("Thinking");
    expect(tabState(a(0, now - 60_000), undefined, now)?.word).toBe("Waiting");
    expect(tabState(undefined, undefined, now)).toBeNull();
  });
  test("a read that just ended keeps its word, though the last act is old", () => {
    const now = 1_000_000;
    let s: Activity = {};
    s = activityReducer(s, { type: "begin", tab: "t1", agent: "orbit-ci", op: "click" });
    s = activityReducer(s, { type: "end", tab: "t1", action: { verb: "click", target: "", ok: true, at: now - 60_000 }, at: now - 60_000 });
    s = activityReducer(s, { type: "begin", tab: "t1", agent: "orbit-ci", op: "read" });
    expect(tabState(s.t1, undefined, now)?.word).toBe("Reading");
    s = activityReducer(s, { type: "end", tab: "t1", action: null, at: now - 500 });
    expect(tabState(s.t1, undefined, now)?.word).toBe("Reading");
    expect(tabState(s.t1, undefined, now + 3000)?.word).toBe("Reading");
    expect(tabState(s.t1, undefined, now + 4500)?.word).toBe("Thinking");
  });
  test("quiet without `done` is Waiting, `done` is Done, a restored name alone is nothing", () => {
    const now = 1_000_000;
    expect(tabState(a(0, now - 60_000), undefined, now)?.word).toBe("Waiting");
    expect(tabState({ ...a(0, now - 60_000), done: true }, undefined, now)?.word).toBe("Done");
    expect(tabState({ ...a(1), done: true }, undefined, now)?.word).toBe("Clicking");
    expect(tabState(undefined, "orbit-ci", now)).toBeNull();
    expect(boxState([tabState(a(0, now - 60_000), undefined, now), tabState({ ...a(0, now - 60_000), done: true }, undefined, now)])?.word).toBe("Waiting");
  });
  test("the busiest tab speaks for its box", () => {
    const now = 1_000_000;
    expect(boxState([tabState(a(0, 1), undefined, now), tabState(a(1), undefined, now), null])?.word).toBe("Clicking");
    expect(boxState([tabState(a(1), undefined, now), tabState(a(1, 0, true), undefined, now)])?.word).toBe("You have it");
  });
});

describe("steadyStep: a word shown to a person holds still", () => {
  type K = "reading" | "scripting" | "thinking" | "yours";
  const run = (events: Array<[number, K]>) => {
    let s = STEADY_INIT as import("../src/lib/browserAgentActivity.ts").Steady<K>;
    const seen: K[] = [];
    for (const [t, raw] of events) { const r = steadyStep(s, raw, t); s = r.s; if (s.shown && seen[seen.length - 1] !== s.shown) seen.push(s.shown); }
    return seen;
  };
  test("the first word shows at once", () => {
    expect(steadyStep(STEADY_INIT as never, "reading" as K, 0).s.shown).toBe("reading");
  });
  test("a flip-flop faster than CANDIDATE_MS never shows the other word", () => {
    const ev: Array<[number, K]> = [[0, "reading"]];
    for (let t = 100; t < 5000; t += 100) ev.push([t, t % 200 ? "scripting" : "reading"]);
    expect(run(ev)).toEqual(["reading"]);
  });
  test("a new word shows once it has held CANDIDATE_MS, and not before", () => {
    expect(run([[0, "reading"], [2000, "scripting"], [2000 + CANDIDATE_MS - 1, "scripting"]])).toEqual(["reading"]);
    expect(run([[0, "reading"], [2000, "scripting"], [2000 + CANDIDATE_MS, "scripting"]])).toEqual(["reading", "scripting"]);
  });
  test("a shown word stays MIN_SHOW_MS even when the candidate is old enough", () => {
    expect(run([[0, "reading"], [100, "scripting"], [100 + CANDIDATE_MS, "scripting"], [MIN_SHOW_MS - 1, "scripting"]])).toEqual(["reading"]);
    expect(run([[0, "reading"], [100, "scripting"], [MIN_SHOW_MS, "scripting"]])).toEqual(["reading", "scripting"]);
  });
  test("wait says when the change comes due", () => {
    const a = steadyStep(steadyStep(STEADY_INIT as never, "reading" as K, 0).s, "scripting" as K, 100);
    expect(a.wait).toBe(MIN_SHOW_MS - 100);
  });
  test("You have it is immediate both ways", () => {
    expect(run([[0, "reading"], [10, "yours"], [20, "reading"]])).toEqual(["reading", "yours", "reading"]);
  });
  test("eval is Scripting, ranked like a read", () => {
    expect(agentState({ working: 1, paused: false, op: "eval" }).word).toBe("Scripting");
    expect(boxState([{ key: "scripting", word: "Scripting" }, { key: "thinking", word: "Thinking" }])?.word).toBe("Scripting");
  });
});

describe("the alien's look at the agent's pointer", () => {
  const len = (o: { lx: number; ly: number }) => Math.hypot(o.lx, o.ly);
  test("pupils never leave 1.5px and the head never tips past 6 degrees, however far the pointer", () => {
    for (const [dx, dy] of [[900, 40], [-900, -700], [0, 2000], [60, -30]]) {
      const l = lookAt(dx, dy);
      expect(len(l)).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(Math.abs(l.tilt)).toBeLessThanOrEqual(6);
    }
  });
  test("points toward the pointer, and looks forward when it is on top of the alien", () => {
    expect(lookAt(200, 0).lx).toBeGreaterThan(1.4);
    expect(lookAt(-200, 0).tilt).toBeLessThan(0);
    expect(lookAt(0, -200).ly).toBeLessThan(-1.4);
    expect(lookAt(0.2, 0.2)).toEqual({ lx: 0, ly: 0, tilt: 0 });
  });
});

describe("whether the agent is still working on a tab", () => {
  const a = { live: true, paused: false, working: 0 };
  // Between two asks of one run the in-flight count is 0; the dot and the glass blinked with it.
  test("holds through the gap between two asks until the quiet window runs out", () => {
    expect(glassHeld({ ...a, working: 1 }, false)).toBe(true);
    expect(glassHeld(a, false)).toBe(true);
    expect(glassHeld(a, true)).toBe(false);
  });
  test("an ask in flight holds even after the quiet window", () => {
    expect(glassHeld({ ...a, working: 1 }, true)).toBe(true);
  });
  test("done, taken over or gone from the tab ends it at once", () => {
    expect(glassHeld({ ...a, done: true }, false)).toBe(false);
    expect(glassHeld({ ...a, paused: true }, false)).toBe(false);
    expect(glassHeld({ ...a, live: false }, false)).toBe(false);
  });
});

describe("where the drawn pointer goes", () => {
  // The dock said Pointing and no pointer was drawn: hover and scroll had no place to land.
  test("follows a hover and a scroll to an element, but not a scroll with none", () => {
    expect(flashPlan({ op: "hover", args: { selector: "#menu" } }, true)).toEqual({ kind: "selector", selector: "#menu" });
    expect(flashPlan({ op: "scroll", args: { selector: "#faq" } }, true)).toEqual({ kind: "selector", selector: "#faq" });
    expect(flashPlan({ op: "scroll", args: { by: 400 } }, true)).toBeNull();
  });
  // They move the eye and change nothing: no outline is drawn in the person's page for them.
  test("the outline in the page is still only for acts", () => {
    expect(flashPlan({ op: "hover", args: { selector: "#menu" } })).toBeNull();
    expect(flashPlan({ op: "click", args: { selector: "#go" } })).not.toBeNull();
  });
  test("the aim asks for the pointer's verbs, the flash for the acts'", () => {
    const drive = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");
    expect(drive).toContain("const plan = landed && flashPlan(ask, true);");
    expect(drive).toContain("const plan = flashPlan(ask);");
  });
  test("a #fragment is the same page; a path is not", () => {
    expect(pageOf("https://docs.example.test/guide#install")).toBe(pageOf("https://docs.example.test/guide#usage"));
    expect(pageOf("https://docs.example.test/guide#install")).not.toBe(pageOf("https://docs.example.test/api#install"));
  });
});

describe("the pointer's label stays on the page", () => {
  // A control inside a hover-only toolbar sits at the page's right edge, and its
  // label ("Clicking Edit message …") ran off the window and was cut.
  test("labelFit flips left of the arrow and above it at an edge, and leaves the middle alone", async () => {
    const { labelFit } = await import("../src/lib/browserAgentActivity.ts");
    expect(labelFit(100, 100, 120, 20, 900, 600)).toEqual({ left: 18, top: 20 });
    expect(labelFit(850, 100, 120, 20, 900, 600).left).toBe(900 - 4 - 120 - 850);
    expect(labelFit(850, 100, 120, 20, 900, 600).left + 850 + 120).toBeLessThanOrEqual(896);
    expect(labelFit(100, 590, 120, 20, 900, 600).top).toBe(-26);
    expect(labelFit(10, 100, 2000, 20, 900, 600).left).toBe(-6);
  });
  // The pointer went where the element was BEFORE the act; a control that only
  // exists while its row is hovered has no place until then.
  test("the pointer re-lands where the element is after the act", async () => {
    const src = await Bun.file(new URL("../src/lib/browserDrive.ts", import.meta.url)).text();
    const fn = src.slice(src.indexOf("function flashWhereActed("), src.indexOf("function flashWhereActed(") + 700);
    expect(fn).toContain("land(ask, r)");
  });
});

describe("an agent that went quiet lets go of its tab", () => {
  // A script ended without saying `done`; its tab read "Waiting" for good and the
  // overview kept counting the agent as holding it.
  const quiet = (ago: number, extra = {}) => ({ agent: "agent-a", working: 0, paused: false, log: [], lastAt: Date.now() - ago, ...extra });
  test("Waiting turns into no state after IDLE_RELEASE_MS, with or without done", () => {
    const now = Date.now();
    expect(tabState(quiet(IDLE_RELEASE_MS - 60_000), undefined, now)?.word).toBe("Waiting");
    expect(tabState(quiet(IDLE_RELEASE_MS + 60_000), undefined, now)).toBeNull();
    expect(tabState(quiet(IDLE_RELEASE_MS + 60_000, { done: true }), undefined, now)).toBeNull();
  });
  test("a paused or mid-ask tab is never released", () => {
    const now = Date.now();
    expect(tabState(quiet(IDLE_RELEASE_MS * 3, { paused: true }), undefined, now)).not.toBeNull();
    expect(tabState(quiet(IDLE_RELEASE_MS * 3, { working: 1 }), undefined, now)).not.toBeNull();
  });
  test("the overview counts only agents that still hold a tab", () => {
    const src = readFileSync(new URL("../src/components/browser/BrowserIsland.tsx", import.meta.url), "utf8");
    expect(src).toContain("g.list.filter((t) => g.states[t.id])");
  });
});
