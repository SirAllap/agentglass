/*
 * Dragging a board card to another column: which of its reachable steps that drop maps to, and why a drop is
 * refused rather than made. The decision is pulled out of JiraBoard.tsx so it can be tested without a renderer;
 * the component only asks it the question and snaps the card back on anything but `ok: true`.
 */
import { describe, expect, test } from "bun:test";
import { dropDecision } from "../src/components/jira/list/boardModel.ts";
import type { MoveFacts } from "../src/components/jira/list/menus/menuModel.ts";

describe("dropDecision", () => {
  test("a column with a matching, fieldless step is the move to make", () => {
    const moves: MoveFacts = { to: [{ status: "In progress", asks: false, key: "11" }, { status: "Done", asks: false, key: "31" }] };
    expect(dropDecision(moves, "Done")).toEqual({ ok: true, key: "31", toStatus: "Done" });
  });

  test("no step reaches that column: refused, not a silent no-op", () => {
    const moves: MoveFacts = { to: [{ status: "In progress", asks: false, key: "11" }] };
    expect(dropDecision(moves, "Done")).toEqual({ ok: false, reason: "No step to Done" });
  });

  test("a step with no move id (nothing a drop can send) is refused the same as a missing step", () => {
    const moves: MoveFacts = { to: [{ status: "Done", asks: false }] };
    expect(dropDecision(moves, "Done")).toEqual({ ok: false, reason: "No step to Done" });
  });

  test("a step that asks for fields is refused: a drop carries nothing to fill them with", () => {
    const moves: MoveFacts = { to: [{ status: "Done", asks: true, key: "31" }] };
    expect(dropDecision(moves, "Done")).toEqual({ ok: false, reason: "Needs details — use Move to…" });
  });

  test("the steps are still being read: refused, not a guess", () => {
    expect(dropDecision("reading", "Done")).toEqual({ ok: false, reason: "Reading the steps…" });
  });

  test("the steps could not be read: the server's own reason, or a default one", () => {
    expect(dropDecision({ error: "Could not reach the server" }, "Done")).toEqual({ ok: false, reason: "Could not reach the server" });
    expect(dropDecision({ error: "" }, "Done")).toEqual({ ok: false, reason: "Could not read the steps" });
  });
});
