/*
 * The guide card's Copy chip: the text the agent passed with `--copy` lands
 * on the step, shows under the say line with a Copy button, and is text,
 * never markup. No copy, no chip.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activityReducer, bubbleOf, type Activity, type GuideEvent } from "../src/lib/browserAgentActivity.ts";
import { GuideCopy } from "../src/components/browser/AgentPresence.tsx";

const T = "t1";
const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
const run = (...evs: GuideEvent[]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
const rect = { x: 40, y: 100, w: 120, h: 30 };
const CMD = "git switch -c orbit-1042\ngit push -u origin orbit-1042";

describe("copy on the guide card", () => {
  test("a point with copy puts it on the step and the bubble", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Paste this.", copy: CMD, target: { rect } }));
    const step = s[T]!.guide!.steps[0]!;
    expect(step.copy).toBe(CMD);
    expect(bubbleOf(step, true).copy).toBe(CMD);
  });

  test("a move keeps the copy; no copy means no chip", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Paste this.", copy: CMD }), g({ phase: "point", target: { rect } }));
    expect(s[T]!.guide!.steps[0]!.copy).toBe(CMD);
    const bare = run(g({ phase: "start" }), g({ phase: "point", say: "Click it.", target: { rect } }));
    expect(bubbleOf(bare[T]!.guide!.steps[0]!, true).copy).toBeUndefined();
  });

  test("after the person's click the card says Got it, with nothing to copy", () => {
    const s = run(g({ phase: "start" }), g({ phase: "wait", say: "Click Rotate.", copy: CMD, waitClick: true, target: { rect } }), g({ phase: "wait", clicked: true }));
    expect(bubbleOf(s[T]!.guide!.steps[0]!, true).copy).toBeUndefined();
  });

  test("the chip reads Copy and the preview shows markup as text", () => {
    const html = renderToStaticMarkup(React.createElement(GuideCopy, { text: '<img src=x onerror="alert(1)"><b>hi</b>' }));
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain(">Copy</button>");
    expect(html).not.toContain("title=");
  });
});
