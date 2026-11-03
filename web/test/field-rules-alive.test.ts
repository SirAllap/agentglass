// A session waiting on a subagent or a background shell is working, not
// forgotten: its own turn is idle, its claim is old, and it is alive.
import { test, expect } from "bun:test";
import { attention, isForgotten, type FieldRow } from "../../shared/fieldRules.ts";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const quiet = (over: Partial<FieldRow> = {}): FieldRow =>
  ({ paneId: "%1", state: "idle", doing: "orbit-migrate", saidAt: NOW - 2 * HOUR, ...over });

test("claimed work quiet for two hours with nothing alive is forgotten", () => {
  expect(attention(quiet(), NOW)).toBe("forgotten");
});

test("the same row with a live subagent or shell is not forgotten", () => {
  expect(isForgotten(quiet({ alive: true }), NOW)).toBe(false);
  expect(attention(quiet({ alive: true }), NOW)).toBeNull();
});

test("a live row that also waits on a permission is still blocked", () => {
  expect(attention(quiet({ alive: true, needsYou: { kind: "permission", since: NOW } }), NOW)).toBe("blocked");
});
