/*
 * A ROW THAT WAITS ON A PERSON, AND THE ONE CONTROL IT NEEDS.
 *
 * A failed headless worker leaves a report: "stopped and is no longer here,
 * left blocked: the turn failed; its files are in …". Nothing has to be
 * allowed or denied, so the card used to offer only "Open terminal" — and a
 * row whose directory is still there waits until it is a week old. Dismiss is
 * per row: clearing one report must not clear the next one beside it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitingSection } from "../src/components/agents/AgentsSections.tsx";
import type { WaitItem } from "../src/lib/agentsScreen.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const report = (id: number, name: string): WaitItem => ({
  kind: "report", key: `o-${id}`, reportId: id, name, since: NOW - 2 * HOUR,
  text: `stopped and is no longer here, left blocked: the turn failed; its files are in /code/acme/orbit-${id}`,
});
const render = (items: WaitItem[]) => renderToStaticMarkup(React.createElement(WaitingSection, {
  items, root: "/code/acme/orbit", seat: null, now: NOW, stale: null, onChanged() {},
}));

describe("a waiting row that asks for no decision", () => {
  test("still has a Dismiss of its own, one per row", () => {
    const html = render([report(7, "go-usage"), report(8, "go-usage2")]);
    expect(html.match(/>Dismiss</g)).toHaveLength(2);
    expect(html).toContain("go-usage");
    expect(html).toContain("go-usage2");
    expect(html).toContain("Clear this row");
  });
});
