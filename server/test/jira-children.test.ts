/*
 * A card's sub-tasks as the board's own search already sends them (the `subtasks` field, each with a key and a status): the
 * umbrella tile reads done/total, one square per child, and the first blocked child. No extra request is made for any of it.
 */
import { describe, expect, test } from "bun:test";
import { cardExtras, childKind } from "../src/jirafields.ts";

const child = (key: string, name: string, cat: string) => ({ id: key, key, fields: { summary: `Title ${key}`, status: { name, statusCategory: { key: cat } } } });

describe("childKind: the colour a child's square wears", () => {
  test("by status category", () => {
    expect(childKind("Done", "done")).toBe("done");
    expect(childKind("In development", "indeterminate")).toBe("progress");
    expect(childKind("To do", "new")).toBe("todo");
  });
  test("a blocked-like status wins over its category", () => {
    expect(childKind("Blocked", "indeterminate")).toBe("blocked");
    expect(childKind("On hold", "new")).toBe("blocked");
    expect(childKind("Impediment", "indeterminate")).toBe("blocked");
  });
  test("a done card is never blocked", () => { expect(childKind("Blocked (resolved)", "done")).toBe("done"); });
});

describe("cardExtras carries the children from the same search", () => {
  test("key, status and kind per child, in order", () => {
    const r = cardExtras({ subtasks: [child("ORBIT-1", "Done", "done"), child("ORBIT-2", "Blocked", "indeterminate"), child("ORBIT-3", "To do", "new")] });
    expect(r.subtasks).toBe(3);
    expect(r.children).toEqual([
      { key: "ORBIT-1", title: "Title ORBIT-1", status: "Done", kind: "done" },
      { key: "ORBIT-2", title: "Title ORBIT-2", status: "Blocked", kind: "blocked" },
      { key: "ORBIT-3", title: "Title ORBIT-3", status: "To do", kind: "todo" },
    ]);
  });
  test("no subtasks: no children key at all", () => { expect("children" in cardExtras({ subtasks: [] })).toBe(false); });
  test("a child without a key is skipped, never shown as empty", () => {
    expect(cardExtras({ subtasks: [{ fields: {} }, child("ORBIT-9", "Done", "done")] }).children).toHaveLength(1);
  });
});
