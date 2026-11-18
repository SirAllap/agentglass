/* Guide cards in live use: the "Guide done" record must not sit over the next guide or the page,
   and a click on a step that asks for more must not wipe the step's words. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activityReducer, auditLeft, bubbleOf, GUIDE_AUDIT_MS, GUIDE_GOT_IT, type Activity, type ActivityEvent, type GuideEvent } from "../src/lib/browserAgentActivity.ts";

const T = "t1";
const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
const run = (...evs: ActivityEvent[]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
const rect = { x: 40, y: 100, w: 120, h: 30 };
const SAY = "Click the search box, then type orbit-1042 and press Enter.";

describe("the Guide done card", () => {
  test("a new guide on the tab replaces it at once", () => {
    const s = run(g({ phase: "start", at: 1 }), g({ phase: "point", say: "Open keys", target: { rect } }), g({ phase: "end", at: 2 }),
      g({ phase: "start", say: "Next guide", at: 3 }));
    expect(s[T]!.guide!.on).toBe(true);
    expect(auditLeft(s[T]!.guide, 3)).toBeUndefined();
    expect(s[T]!.guide!.steps).toEqual([]);
  });

  test("it fades about 6 s after the end, and not before", () => {
    const s = run(g({ phase: "start", at: 1_000 }), g({ phase: "end", at: 2_000 }));
    expect(GUIDE_AUDIT_MS).toBe(6000);
    expect(auditLeft(s[T]!.guide, 2_000)).toBe(6000);
    expect(auditLeft(s[T]!.guide, 7_999)).toBe(1);
    expect(auditLeft(s[T]!.guide, 8_000)).toBe(0);
    expect(auditLeft(s[T]!.guide, 60_000)).toBe(0);
  });

  test("its close never ends a guide that is on", () => {
    const s = run(g({ phase: "start", at: 1 }), g({ phase: "end", at: 2 }), g({ phase: "start", at: 3 }),
      { type: "guideAnswer", tab: T, answer: "close", at: 4 });
    expect(s[T]!.guide!.on).toBe(true);
  });

  test("clicks pass through it to the page; only its Resume takes them; reduced motion has no fade", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const rule = css.match(/\.agx-presence-audit \{[^}]*\}/)![0];
    expect(rule).toContain("pointer-events: none");
    expect(css).toMatch(/\.agx-presence-audit \.agx-bubble-foot \{ pointer-events: auto; \}/);
    expect(css).toMatch(/\.agx-presence-audit\.is-fading \{ opacity: 0; \}/);
    const calm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(calm).toMatch(/\.agx-presence-audit \{ transition: none; \}/);
  });
});

describe("a step that asks for more after the click", () => {
  test("the words stay; Got it is only the state line", () => {
    const s = run(g({ phase: "start" }), g({ phase: "wait", say: SAY, waitClick: true, target: { rect } }), g({ phase: "wait", clicked: true }));
    const b = bubbleOf(s[T]!.guide!.steps[0]!, true);
    expect(b.text).toBe(SAY);
    expect(b.note).toBe(GUIDE_GOT_IT);
    expect(b.waiting).toBe(false);
    expect(b.buttons).toEqual(["stop"]);
  });

  test("the next point replaces the words", () => {
    const s = run(g({ phase: "start" }), g({ phase: "wait", say: SAY, waitClick: true, target: { rect } }), g({ phase: "wait", clicked: true }),
      g({ phase: "point", say: "Open the first result.", target: { rect } }));
    const steps = s[T]!.guide!.steps;
    expect(bubbleOf(steps[steps.length - 1]!, false).text).toBe("Open the first result.");
  });
});
