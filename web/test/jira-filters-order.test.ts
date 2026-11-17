import { expect, test } from "bun:test";
import { GROUPS } from "../src/components/jira/list/filtersV2Model.ts";

// The rail lists the short lists first and the toggles last, below a divider: the long People list is not before Status.
test("the rail reads Status first and the switch groups last", () => {
  const ids = GROUPS.map((g) => g.id);
  expect(ids[0]).toBe("status");
  expect(ids.indexOf("label")).toBeGreaterThan(ids.indexOf("status"));
  expect(ids.slice(-2)).toEqual(["dates", "signals"]);
});
