/*
 * The Jira sidebar's screen rules, asserted against source because there is no
 * renderer here. What a mistake costs: rows that stop lining up with the board
 * next to them, a second colour language, and a pane that reads a selection
 * the sidebar wrote some other way.
 */
import { describe, expect, test } from "bun:test";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const tree = strip(await Bun.file(new URL("../src/components/jira/JiraTree.tsx", import.meta.url)).text());
const hook = strip(await Bun.file(new URL("../src/lib/useJiraTree.ts", import.meta.url)).text());
const panel = strip(await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text());
const model = strip(await Bun.file(new URL("../src/lib/jiraTree.ts", import.meta.url)).text());

describe("measures", () => {
  test("a rail row is 28 and an epic row 44, from the one place that says so", () => {
    expect(model).toContain("export const ROW_H = 28;");
    expect(model).toContain("export const EPIC_H = 44;");
    expect(tree).toContain("height: o.h ?? ROW_H");
    expect(tree).toContain("{ h: EPIC_H");
  });

  test("the indent is 8 plus 16 a level and the guides sit on the same grid", () => {
    expect(tree).toContain("paddingLeft: 8 + 16 * lv");
    expect(tree).toContain("left: 16 + 16 * k");
  });

  test("the Jira rail opens at 288 and the others keep their own width", () => {
    expect(model).toContain("export const RAIL_W_JIRA = 288;");
    expect(panel).toContain('const railDefault = source.id === "jira" ? RAIL_W_JIRA : RAIL_W_DEFAULT;');
  });
});

describe("no new colour language", () => {
  test("the tree draws with the house tokens, never a literal colour", () => {
    expect(tree).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(tree).not.toMatch(/\brgba?\(/);
    expect(tree).not.toMatch(/\bhsla?\(/);
  });
  test("an epic's tone comes from the graph palette by its key", () => {
    expect(model).toMatch(/var\(--graph-\$\{/);
  });
});

describe("the seam", () => {
  test("the selection is written through select() only, in the hook", () => {
    expect(hook).toContain("const select = useCallback(");
    expect(hook).toMatch(/last: space, sel: \{ \.\.\.p\.sel, \[space\]: target/);
    expect(tree).not.toMatch(/\bsel:\s*\{/);
    expect(tree).not.toContain("localStorage");
  });
  test("one store feeds the sidebar, the plus menu and the dialog", () => {
    expect(hook).toContain("useSyncExternalStore");
    expect(hook).toContain("export function useJiraTree(");
    expect(panel).toContain("const jt = useJiraTree(isJira && active);");
  });
});

describe("shared panel", () => {
  test("the tree and its plus menu are Jira-only", () => {
    expect(panel).toContain('const isJira = source.id === "jira";');
    expect(panel).toMatch(/\{plusOpen && isJira && <AddSpacePopover/);
    expect(panel).toMatch(/isJira \? "" : " py-1\.5"/);
  });
  test("every right-click menu is the one card-menu component", () => {
    expect(tree).toContain("<PrCardMenu<TreeMenuId>");
  });
});
