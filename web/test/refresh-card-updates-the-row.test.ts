/*
 * "REFRESH CARD" READ THE CARD AND CHANGED HALF OF IT.
 *
 * The card panel draws from two places: the description, the comments and the
 * files come from the detail this button fetches, while status, tags, assignee,
 * sprint and points are the BOARD's copy of the card. The button replaced only
 * the first half, so pressing it looked like it did nothing and the change
 * appeared a minute later when the board next polled — "it takes far too long
 * to bring in the changes… it should be something fast and reactive".
 *
 * The call was never the slow part. Measured against the real workspace on
 * 2026-09-01: /clickup/task answers in 734–826 ms for the card in question.
 * What was missing was handing the fresh row back to the board.
 *
 * Pinned on the source, because the button lives inside a component that needs
 * a live panel to render and the failure was a missing wire, not a rule.
 */
import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const from = source.indexOf("function CardDetail(");
const detail = source.slice(from, source.indexOf("\nfunction ", from + 10));
const button = detail.slice(detail.indexOf("api.clickupTask(t.id)"));
const naked = button.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the card's own refresh", () => {
  test("hands the fresh card back to the board as well as to this panel", () => {
    expect(naked).toContain("setFull(");
    expect(naked, "the row keeps whatever the last board poll read").toContain("onFresh");
  });

  test("and the panel wires that to the row's override", () => {
    expect(source).toContain("onFresh={(task) => setOver(");
  });

  test("the fresh row is the server's, not a guess assembled here", () => {
    expect(naked).toContain("r.task");
  });
});
