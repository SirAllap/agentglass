import { describe, expect, test } from "bun:test";
import { restoreAtReview, rereviewLine } from "../src/lib/rereviewCard.ts";
import type { CardEvent } from "../../shared/providers.ts";

const ev = (at: number, field: "assignee" | "status", from: string, fromString: string, to: string, toString: string): CardEvent =>
  ({ at, kind: "change", edit: { field, from, to, fromString, toString } });
// Author hands to Jonas at Code review (t=100); review asks for changes; Jonas hands back, card goes back to development (t=300).
const log = [
  ev(100, "assignee", "acc-ana", "Ana R.", "acc-jonas", "Jonas K."),
  ev(100, "status", "", "In development", "", "Code review"),
  ev(300, "assignee", "acc-jonas", "Jonas K.", "acc-ana", "Ana R."),
  ev(300, "status", "", "Code review", "", "In development"),
];
describe("restoreAtReview", () => {
  test("restores reviewer and Code review", () => {
    expect(restoreAtReview(log, 200, { assignee: "Ana R.", status: "In development" }))
      .toEqual({ assignee: { key: "acc-jonas", name: "Jonas K." }, status: "Code review" });
  });
  test("nothing changed since: nothing to restore", () => {
    expect(restoreAtReview(log, 400, { assignee: "Ana R.", status: "In development" })).toEqual({});
  });
  test("only status changed", () => {
    expect(restoreAtReview(log.slice(0, 2), 200, { assignee: "Jonas K.", status: "In development" })).toEqual({ status: "Code review" });
  });
  test("review before any edit uses the first from", () => {
    expect(restoreAtReview(log, 50, { assignee: "Jonas K.", status: "Code review" })).toEqual({ assignee: { key: "acc-ana", name: "Ana R." }, status: "In development" });
  });
  test("empty log", () => { expect(restoreAtReview([], 1, { assignee: "x", status: "y" })).toEqual({}); });
});
describe("rereviewLine", () => {
  test("full", () => expect(rereviewLine(["jonas-k"], "ORBIT-1042", { assignee: { key: "k", name: "Jonas K." }, status: "Code review" })).toBe("Ask jonas-k again · assign ORBIT-1042 to Jonas K. · move it to Code review"));
  test("skipped", () => expect(rereviewLine(["jonas-k"], null, null, "no linked card")).toBe("Ask jonas-k again · no linked card"));
});
