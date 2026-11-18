/* Variant D of the family view, pinned at the source: invented cards only. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { familyKeyOf } from "../src/components/jira/list/familyModel.ts";
import { kidsWord } from "../src/components/jira/list/FamilyRows.tsx";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const board = src("../src/components/jira/list/JiraBoard.tsx");
const rows = src("../src/components/jira/list/FamilyRows.tsx");
const css = src("../src/index.css");

describe("family on the board", () => {
  test("a parent and its sub-tasks share one family key; a lone card has none", () => {
    expect(familyKeyOf({ id: "1", customId: "ORBIT-123", issueType: "Story", subtasks: 5 })).toBe("ORBIT-123");
    expect(familyKeyOf({ id: "2", customId: "ORBIT-131", issueType: "Sub-task", parent: { key: "ORBIT-123", title: "x" } })).toBe("ORBIT-123");
    expect(familyKeyOf({ id: "3", customId: "ORBIT-140", issueType: "Story" })).toBeUndefined();
  });
  test("progress is said once, as N of M done", () => {
    expect(kidsWord([{ key: "a", status: "Done", kind: "done" }, { key: "b", status: "To Do", kind: "todo" }])).toBe("1 of 2 done");
  });
  test("the child chip names its parent by title; the key stays in the tooltip", () => {
    expect(board).toContain("↳ {t.parent.title || t.parent.key}");
    expect(board).toContain("name: t.parent.key");
  });
  test("a parent drops the old bar and the subtasks pill for the one family row", () => {
    expect(board).toContain("hideKids");
    expect(board).toContain("!t.children?.length &&");
  });
  test("the child list shows each status, and a row opens its card", () => {
    expect(rows).toContain("{k.status}");
    expect(rows).toContain("onOpenKey?.(k.key)");
    expect(rows).toContain("aria-expanded");
  });
  test("hover and focus light the family; a child row lights its card stronger; reduced motion keeps it still", () => {
    expect(board).toContain("onPointerOver={lit.over}");
    expect(board).toContain("onFocus={lit.over}");
    expect(css).toContain(".agx-jb[data-jb-lit] .agx-jb-card[data-jb-in]");
    expect(css).toContain(".agx-jb .agx-jb-card[data-jb-child]");
    expect(css).toMatch(/prefers-reduced-motion: no-preference\) \{ \.agx-jb-card \{ transition: opacity/);
  });
  test("a sub-task shows its epic chip beside the parent chip, and the epic truncates first", () => {
    expect(board).toContain("c.parent && c.epic && t.epic");
    expect(css).toContain(".agx-jb-head > .agx-jb-parent ~ .agx-jb-epic { flex-shrink: 8; }");
  });
});
