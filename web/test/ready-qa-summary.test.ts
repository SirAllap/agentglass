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
});
