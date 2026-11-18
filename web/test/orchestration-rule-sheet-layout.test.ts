import { describe, expect, test } from "bun:test";
import { SHEET_SECTIONS, addStepState, conditionFields } from "../src/components/orchestration/ruleSheetLayout.ts";

describe("rule sheet layout helper", () => {
  test("sections keep one order", () => expect([...SHEET_SECTIONS]).toEqual(["when", "then", "preview", "test"]));
  test("condition value controls per kind", () => {
    expect(conditionFields("usage")).toEqual(["plan", "window", "pct"]);
    expect(conditionFields("limit")).toEqual(["plan"]);
    expect(conditionFields("always")).toEqual([]);
  });
  test("add a step is always shown once, disabled only when full", () => {
    expect(addStepState(1, 4)).toEqual({ shown: true, disabled: false });
    expect(addStepState(4, 4)).toEqual({ shown: true, disabled: true });
  });
});
