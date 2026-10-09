/*
 * The hand-off confirm names what it will do. The first version asked "Move X
 * to Ready for QA and unassign everyone?" and hid the status it left and the
 * people it removed, so the question could not be answered without opening the
 * card. This draws the summary's first paint and asserts each fact is on it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadyForQaSummary } from "../src/components/PrPanel.tsx";

const task = {
  id: "86abc", customId: "ORBIT-1042", title: "Dark mode toggle for the settings page",
  status: "code review", statusColor: "#d8a800",
  people: [{ id: 1, name: "Ada Lovelace", initials: "AL" }, { id: 2, name: "Sam Rivera", initials: "SR" }],
} as never;

describe("ReadyForQaSummary", () => {
  test("shows id, title, both statuses and every person", () => {
    const html = renderToStaticMarkup(React.createElement(ReadyForQaSummary, { task, target: "ready for qa", targetColor: "#2c6a27" }));
    for (const s of ["ORBIT-1042", "Dark mode toggle for the settings page", "CODE REVIEW", "READY FOR QA", "Ada Lovelace", "Sam Rivera"]) {
      expect(html).toContain(s);
    }
  });
  test("says so when nobody is assigned", () => {
    const html = renderToStaticMarkup(React.createElement(ReadyForQaSummary, { task: { ...(task as object), people: [] } as never, target: "ready for qa" }));
    expect(html).toContain("nobody assigned");
  });
  test("unassign none: names the people who stay and says nobody comes off", () => {
    const html = renderToStaticMarkup(React.createElement(ReadyForQaSummary, { task, target: "TESTING", unassign: "none" }));
    expect(html).toContain("TESTING");
    expect(html).toContain("nobody comes off");
    expect(html).toContain("Stays on");
    expect(html).not.toContain("line-through");
    expect(html).toContain("Everyone assigned stays on the card.");
    // The card and status facts are still all there.
    for (const f of ["ORBIT-1042", "CODE REVIEW", "Ada Lovelace", "Sam Rivera"]) expect(html).toContain(f);
  });
  test("unassign me: only the connected account is struck through", () => {
    const people = [{ id: 1, name: "Ada Lovelace", initials: "AL", me: true }, { id: 2, name: "Sam Rivera", initials: "SR" }];
    const html = renderToStaticMarkup(React.createElement(ReadyForQaSummary, { task: { ...(task as object), people } as never, target: "TESTING", unassign: "me" }));
    expect(html.match(/line-through/g)?.length).toBe(1);
    expect(html).toMatch(/line-through[^>]*>.*?Ada Lovelace/);
    expect(html).toContain("Stays on");
    expect(html).toContain("Only you come off the card.");
  });
  test("unassign defaults to everyone, as before the setting existed", () => {
    const html = renderToStaticMarkup(React.createElement(ReadyForQaSummary, { task, target: "ready for qa" }));
    expect(html.match(/line-through/g)?.length).toBe(2);
    expect(html).not.toContain("Stays on");
    expect(html).toContain("Nobody stays on the card until QA picks it up.");
  });
});
