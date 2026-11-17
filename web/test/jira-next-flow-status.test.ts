import { describe, expect, test } from "bun:test";
import { nextFlowStatus } from "../src/components/jira/list/model.ts";
import type { ListStatus } from "../../shared/providers.ts";

// A board's columns with a "Blocked" the board has no column for, placed between two steps by its category.
const cols = ["Ready for engineering", "Blocked", "In development", "Code review", "Done", "Won't do"];
const st = (status: string, offFlow = false): ListStatus => ({ status, type: "custom", orderindex: 0, ...(offFlow ? { offFlow: true as const } : {}) });
const statuses = [st("Ready for engineering"), st("Blocked", true), st("In development"), st("Code review"), st("Done"), st("Won't do", true)];

describe("the tile's Move to skips columns that are not steps", () => {
  test("the step before Blocked moves on past it", () => {
    expect(nextFlowStatus(cols, "Ready for engineering", statuses)).toBe("In development");
  });
  test("a card in Blocked or Won't do is offered no next step", () => {
    expect(nextFlowStatus(cols, "Blocked", statuses)).toBeNull();
    expect(nextFlowStatus(cols, "Won't do", statuses)).toBeNull();
  });
  test("Done is last: a Won't do after it is not its next step", () => {
    expect(nextFlowStatus(cols, "Done", statuses)).toBeNull();
  });
  test("without any off-flow status it is the next column, as before", () => {
    expect(nextFlowStatus(["A", "B", "C"], "A", [st("A"), st("B"), st("C")])).toBe("B");
    expect(nextFlowStatus(["A", "B"], "Z", [])).toBeNull();
  });
});
