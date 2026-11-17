/*
 * A sub-task must read as a child of another card: the board chip says "↳ KEY" (not the epic's filled name chip), the open
 * card's parent and sub-tasks get a left bar, and the panel header names the parent as a parent. Fixtures are invented.
 */
import { describe, expect, test } from "bun:test";
import { familyOf, parentChipOf } from "../src/components/jira/list/familyModel.ts";

const epic = { key: "ORBIT-100", title: "Security RBAC", type: "Epic" };
const story = { id: "ORBIT-123", customId: "ORBIT-123", issueType: "Story", parent: epic };
const sub1 = { id: "ORBIT-135", customId: "ORBIT-135", issueType: "Sub-task", parent: { key: "ORBIT-123", title: "RBAC reporting" } };
const sub2 = { id: "ORBIT-136", customId: "ORBIT-136", issueType: "Subtask", parent: { key: "ORBIT-123", title: "RBAC reporting" } };
const other = { id: "ORBIT-200", customId: "ORBIT-200", issueType: "Story", parent: epic };
const cards = [story, sub1, sub2, other];

describe("familyOf", () => {
  test("opening the parent marks its sub-tasks, not itself or strangers", () => {
    expect([...familyOf(cards, "ORBIT-123")]).toEqual([["ORBIT-135", "child"], ["ORBIT-136", "child"]]);
  });
  test("opening a sub-task marks its parent only", () => {
    expect([...familyOf(cards, "ORBIT-135")]).toEqual([["ORBIT-123", "parent"]]);
  });
  test("an epic's stories are not family; nothing open marks nothing", () => {
    expect(familyOf([story, other, { id: "ORBIT-100", customId: "ORBIT-100", issueType: "Epic" }], "ORBIT-100").size).toBe(0);
    expect(familyOf(cards, null).size).toBe(0);
  });
  test("keys match without case", () => {
    expect(familyOf(cards, "orbit-123").get("ORBIT-135")).toBe("child");
  });
});

describe("parentChipOf", () => {
  test("a sub-task shows the parent chip, a story the epic chip, no parent none", () => {
    expect(parentChipOf(sub1)).toBe("parent");
    expect(parentChipOf(story)).toBe("epic");
    expect(parentChipOf({ issueType: "Story" })).toBeNull();
  });
});

describe("the skin and the sources", () => {
  const src = (p: string) => Bun.file(import.meta.dir + "/../src/" + p).text();
  test("the skin sets no rule on the parent chip or the family bar, so index.css wins", async () => {
    const skin = await src("jiraMock.css");
    expect(skin).not.toMatch(/agx-jb-parent/);
    expect(skin).not.toMatch(/agx-jb-card[^{]*::before/);
    expect(skin).not.toMatch(/agx-jb-card[^{]*data-jb-family/);
  });
  test("the parent chip is an outline, the epic chip is filled", async () => {
    const css = await src("index.css");
    const parent = css.match(/\.agx-jb-parent\s*\{[^}]*\}/)?.[0] ?? "";
    expect(parent).toContain("background: transparent");
    expect(css.match(/\.agx-jb-epic\s*\{[^}]*\}/)?.[0]).toContain("background: color-mix");
    expect(css).toMatch(/\.agx-jb-card\[data-jb-family\]::before/);
  });
  test("the chip names the parent by title (key in the tooltip), uses the house tooltip, and the header labels the parent", async () => {
    const board = await src("components/jira/list/JiraBoard.tsx");
    const chip = board.match(/<button[^>]*agx-jb-parent[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(chip).toContain("data-tip=");
    expect(chip).not.toContain("title=");
    expect(chip).toContain("↳ {t.parent.title || t.parent.key}");
    expect(await src("components/jira/detail/DetailHeader.tsx")).toContain("Sub-task of");
  });
});
