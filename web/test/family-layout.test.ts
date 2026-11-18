import { describe, expect, test } from "bun:test";
import { KID_STATUS_TEXT_MIN, kidLayout } from "../src/components/jira/list/familyLayout.ts";

describe("kidLayout: lane width to what a sub-task row shows", () => {
  test("a wide row shows the status text", () => {
    expect(kidLayout(400).statusText).toBe(true);
    expect(kidLayout(KID_STATUS_TEXT_MIN).statusText).toBe(true);
  });
  test("a narrow row drops the status text and keeps the dot", () => {
    expect(kidLayout(KID_STATUS_TEXT_MIN - 1).statusText).toBe(false);
    expect(kidLayout(120).statusText).toBe(false);
  });
  test("an unmeasured row (0) shows the text until it is measured", () => {
    expect(kidLayout(0).statusText).toBe(true);
  });
});
