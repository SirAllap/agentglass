/* A summary step (#20): the card shows what the page is about under the say line, ends on OK,
   and the block is drawn as text inside the card, never over the page. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activityReducer, bubbleOf, GUIDE_SUMMARY_HEAD, type Activity, type GuideEvent } from "../src/lib/browserAgentActivity.ts";

const T = "t1";
const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
const run = (...evs: GuideEvent[]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
const rect = { x: 40, y: 100, w: 120, h: 30 };

describe("summary step", () => {
  test("the summary rides on the step and on the card, with OK to go on", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Read the post, then press OK.", summary: "A post about orbit-1042.", target: { rect } }));
    const step = s[T]!.guide!.steps[0]!;
    expect(step.summary).toBe("A post about orbit-1042.");
    const b = bubbleOf(step, true);
    expect(b.text).toBe("Read the post, then press OK.");
    expect(b.summary).toBe("A post about orbit-1042.");
    expect(b.buttons).toContain("ok");
  });
  test("a step with no summary shows no block", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Click 'reply'.", target: { rect } }));
    expect(bubbleOf(s[T]!.guide!.steps[0]!, true).summary).toBeUndefined();
  });
  test("the next step drops the summary", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Read it, then press OK.", summary: "A post.", target: { rect } }),
      g({ phase: "point", say: "Click 'reply'.", target: { rect } }));
    expect(s[T]!.guide!.steps[1]!.summary).toBeUndefined();
  });
  test("the heading is sentence case", () => {
    expect(GUIDE_SUMMARY_HEAD).toBe("About this page");
  });
  test("source: the card draws it as React text inside the bubble, and its text scrolls inside the block", () => {
    const src = readFileSync(new URL("../src/components/browser/AgentPresence.tsx", import.meta.url), "utf8");
    expect(src).toContain("{b.summary && <GuideSummary text={b.summary} />}");
    expect(src).not.toMatch(/GuideSummary[\s\S]{0,400}dangerouslySetInnerHTML/);
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.agx-bubble-summary-text \{[^}]*max-height:[^}]*overflow-y: auto/);
  });
});
