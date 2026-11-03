/*
 * The approve card, drawn. No DOM under bun test, so what these see is the first
 * paint plus the decisions pulled out into lib/approveCard.ts: a high-risk card
 * cannot be approved before the tick, an unknown setting still renders, and a
 * long value is clamped until it is opened.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApproveCard } from "../src/components/ApproveCard.tsx";
import { approveReady, changesOf, lineDiff, riskOf, riskOfChanges, timeLeft } from "../src/lib/approveCard.ts";
import type { SettingRequestView } from "../../shared/settingClass.ts";

const now = Date.now();
const req = (diff: string[], over: Partial<SettingRequestView> = {}): SettingRequestView =>
  ({ id: "sr_1", setting: "launch.mode", label: "Permission mode agents launch in", who: "an agent calling itself \"orbit-worker\"", diff, at: now - 60_000, expires: now + 9 * 60_000, ...over });

const draw = (r: SettingRequestView) => renderToStaticMarkup(React.createElement(ApproveCard, { r, busy: false, error: null, onAnswer: () => {} }));
const title = (html: string) => /class="agx-ac-title"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
const button = (html: string, which: string) => new RegExp(`<button[^>]*data-answer="${which}"[^>]*>`).exec(html)?.[0] ?? "";

describe("a high-risk change", () => {
  const high = req(["Permission mode agents launch in", 'value: "auto" -> "bypassPermissions"']);

  test("Approve is disabled until the tick, and the tick is on the card", () => {
    const html = draw(high);
    expect(riskOf("launch.mode")).toBe("high");
    expect(button(html, "approve")).toContain("disabled");
    expect(html).toContain('data-ack=""');
    expect(html).toContain("I understand this gives an agent more power on this machine.");
    // The decision the component reads: the tick is what turns it on.
    expect(approveReady("high", false, false)).toBe(false);
    expect(approveReady("high", true, false)).toBe(true);
  });

  test("Decline is never gated by the tick: refusing is always safe", () => {
    expect(button(draw(high), "decline")).not.toContain("disabled");
    expect(approveReady("high", false, true)).toBe(false); // still disabled while answering
  });

  test("a medium card needs no tick and can be approved at once", () => {
    const html = draw(req(["Spending limits", "value: 40 -> 60"], { setting: "budgets" }));
    expect(button(html, "approve")).not.toContain("disabled");
    expect(html).not.toContain('data-ack=""');
  });
});

describe("a setting nobody described", () => {
  const unknown = req(["Something the server labels", 'value: "off" -> "on"'], { setting: "acme.unheard.setting" });

  test("still renders, and its title is the raw key", () => {
    const html = draw(unknown);
    expect(title(html)).toBe("acme.unheard.setting");
    expect(html).toContain("Approve");
    expect(html).toContain("Decline");
    expect(riskOf("acme.unheard.setting")).toBe("medium");
  });

  test("and says nothing it cannot know: no In short, no This lets the agent", () => {
    const html = draw(unknown);
    expect(html).not.toContain("In short.");
    expect(html).not.toContain("This lets the agent");
  });
});

describe("a setting the table knows", () => {
  test("leads with the plain-English title, the one-liner and what it lets the agent do", () => {
    const html = draw(req(["Permission mode agents launch in", 'value: "auto" -> "bypassPermissions"']));
    expect(title(html)).toBe("The permission mode every agent the app starts runs in");
    expect(html).toContain("In short.");
    expect(html).toContain("This lets the agent");
    expect(html).toContain("Act with fewer questions in every terminal the app starts");
  });

  test("a family key covers the ids under it", () => {
    expect(riskOf("launch.flags.claude")).toBe("high");
    expect(riskOf("plugins.sessionReads.repos")).toBe("low");
    expect(riskOf("plugin.acme-orbit.unboxed")).toBe("high");
  });

  test("a docker or network lift inside the policy is high, though the policy is medium", () => {
    const policy = (lines: string[]) => changesOf(["Orchestration policy", ...lines]).changes;
    const docker = policy(["workers.builder.envelope.docker: false -> true"]);
    expect(riskOfChanges("orchestration.policy", docker)).toBe("high");
    const network = policy(["workers.builder.envelope.network: false -> true"]);
    expect(riskOfChanges("orchestration.policy", network)).toBe("high");
    // A commit lift is a smaller power than a container that shares the machine.
    const commit = policy(["workers.builder.envelope.commit: false -> true"]);
    expect(riskOfChanges("orchestration.policy", commit)).toBe("medium");
    // Taking a lift away never raises anything.
    const off = policy(["workers.builder.envelope.docker: true -> false"]);
    expect(riskOfChanges("orchestration.policy", off)).toBe("medium");
  });

  test("and that lift is what draws the tick, not the setting's own row", () => {
    const html = draw(req(["Orchestration policy", "workers.builder.envelope.docker: false -> true"], { setting: "orchestration.policy" }));
    expect(html).toContain("High risk");
    expect(button(html, "approve")).toContain("disabled");
  });
});

describe("the change itself", () => {
  test("before and after are two chips, the old one struck", () => {
    const html = draw(req(["Permission mode agents launch in", 'value: "auto" -> "bypassPermissions"']));
    expect(html).toContain("agx-ac-v old");
    expect(html).toContain("agx-ac-v new");
    expect(html).toContain("&quot;auto&quot;");
    expect(html).toContain("&quot;bypassPermissions&quot;");
    expect(html).toContain("→");
  });

  test("a long value is clamped to three lines and offers Show full", () => {
    const long = "x".repeat(120);
    const html = draw(req(["Builder prompt", `value: "short" -> "${long}"`]));
    expect(html).toContain("clamp");
    expect(html).toContain("Show full");
  });

  test("a short value has no Show full", () => {
    const html = draw(req(["Workers at once", "value: 3 -> 5"]));
    expect(html).not.toContain("Show full");
  });

  test("the diff is split at its arrow, not inside a value that carries one", () => {
    const { changes, notes } = changesOf(["Builder prompt", 'value: "a -> b" -> "c -> d"', "a plugin line with no arrow"]);
    expect(changes).toEqual([{ name: "value", before: '"a -> b"', after: '"c -> d"', long: false }]);
    expect(notes).toEqual(["a plugin line with no arrow"]);
  });

  test("Show full is a diff: a line that stayed is context, not a delete plus an add", () => {
    const d = lineDiff('"one\\ntwo"', '"one\\nthree"');
    expect(d).toEqual([{ kind: "same", text: "one" }, { kind: "del", text: "two" }, { kind: "add", text: "three" }]);
  });
});

describe("the wait", () => {
  test("the footer counts the minutes the request has left", () => {
    const html = draw(req(["Workers at once", "value: 3 -> 5"], { at: now - 21 * 60_000, expires: now + 9 * 60_000 }));
    expect(html).toContain("No answer in <b>9 min</b> = declined");
  });

  test("the bar drains from what is left of the whole wait", () => {
    expect(timeLeft({ at: 0, expires: 600_000 }, 300_000)).toEqual({ fraction: 0.5, minutes: 5 });
    expect(timeLeft({ at: 0, expires: 600_000 }, 900_000)).toEqual({ fraction: 0, minutes: 0 });
  });
});
