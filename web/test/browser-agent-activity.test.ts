import { readFileSync } from "node:fs";
import { FLASH_MS, flashScript } from "../src/lib/browserDrive.ts";
import { describe, expect, test } from "bun:test";
import {
  LOG_MAX, activityReducer, actionOf, agentLabel, ago, flashPlan, isActVerb, lapKeyframes, pausedRefusal, presenceLabel, travelMs, type Activity,
} from "../src/lib/browserAgentActivity.ts";

const begin = (s: Activity, tab = "t1", agent = "orbit-ci") => activityReducer(s, { type: "begin", tab, agent });

describe("agent activity per tab", () => {
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
  });
  test("travel grows with distance and stays inside its clamp", () => {
    expect(travelMs(0, 0)).toBe(260);
    expect(travelMs(3000, 0)).toBe(680);
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
