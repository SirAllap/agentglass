/*
 * The preview under "Where this shows up", for a Jira card: it draws what the card gets,
 * which is a button for each of the hand-off and the review that is set up.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
// The libraries below read the window's storage when they load, so they load under a stub that goes back when the file ends.
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { PrView } = await import("../src/components/TrackerMapParts.tsx");
const { JIRA, jiraSteps } = await import("../src/lib/jiraWorkflow.ts");
import type { JiraSteps } from "../../shared/providers.ts";

const off = { enabled: false, blocks: [] };

describe("the preview tells the truth about a Jira card", () => {
  const draw = (all: JiraSteps) => {
    const st = jiraSteps(all);
    return renderToStaticMarkup(React.createElement(PrView, { adapter: JIRA, status: "Building", steps: st, all: st, writes: true, hover: null, linked: true }));
  };
  const blocks = { handoff: { enabled: true, blocks: [{ type: "comment" as const, text: "Opened" }] }, review: { enabled: true, blocks: [{ type: "move" as const, statusNames: ["Peer check"] }] }, merge: off };

  test("the review step is a button beside the hand-off, as it is on the card, not an item in a menu", () => {
    const html = draw(blocks);
    expect(html.match(/data-slot="button"/g)?.length).toBe(2);
    expect(html).not.toContain('data-slot="menu"');
    expect(html).toContain("Transition to Peer check");
  });

  test("a hand-off that only comments is still a button, because the card gets one", () => {
    const html = draw({ ...blocks, review: off });
    expect(html.match(/data-slot="button"/g)?.length).toBe(1);
    expect(html).not.toContain("No control from a step here.");
  });

  test("no steps, no control", () => {
    expect(draw({ handoff: off, review: off, merge: off })).toContain("No control from a step here.");
  });
});
