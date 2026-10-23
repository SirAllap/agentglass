/*
 * The Jira list draws its groups with the same heading as the ClickUp list,
 * and asks nothing until it has to. The screens have no renderer here, so the
 * rules are asserted against their source.
 *
 * What a mistake costs: a second copy of the group heading that drifts, a
 * search box that asks on every key, a list read before the tab is on screen.
 */
import { describe, expect, test } from "bun:test";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The text of `function name(` up to its own closing brace at column 0. */
function fn(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\(`));
  expect(at).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", at);
  return strip(src.slice(at, end < 0 ? undefined : end + 2));
}

const jira = await Bun.file(new URL("../src/components/JiraTasks.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const add = await Bun.file(new URL("../src/components/jira/AddBar.tsx", import.meta.url)).text();
const rail = await Bun.file(new URL("../src/components/jira/ViewRail.tsx", import.meta.url)).text();
const head = await Bun.file(new URL("../src/components/tasks/GroupHead.tsx", import.meta.url)).text();

describe("the group heading is one component", () => {
  test("Jira's groups use GroupHead", () => {
    expect(fn(jira, "JiraBody")).toMatch(/<GroupHead\s/);
  });

  test("ClickUp's groups use it too, and no longer draw their own chevron", () => {
    expect(fn(panel, "ClickUpBody")).toMatch(/<GroupHead\s/);
    expect(fn(panel, "ClickUpBody")).not.toContain("agx-group-head");
    expect(strip(head)).toContain("agx-group-head");
  });

  test("Jira reuses its own Row, Facts and StatusPill rather than new ones", () => {
    const j = strip(jira);
    expect(j.match(/function Row\(/g)).toHaveLength(1);
    expect(j.match(/function Facts\(/g)).toHaveLength(1);
    expect(j.match(/function StatusPill\(/g)).toHaveLength(1);
  });
});

describe("what it asks, and when", () => {
  test("a saved view is read from disk first, then from Jira, and Refresh forces", () => {
    const f = fn(jira, "JiraBody");
    expect(f).toContain("{ cached: true }");
    expect(f).toContain("{ force: true }");
  });

  test("the timer and the focus rule are the mine list's: boardDue, and only while the tab is active", () => {
    const f = fn(jira, "JiraBody");
    expect(f).toContain("boardDue(");
    expect(f).toContain("if (!active || !ready) return;");
    expect(f).toContain("BOARD_TICK_MS");
  });

  test("the pick lists are read when opened, and a search waits for the typing to pause", () => {
    const f = fn(add, "AddBar");
    expect(f).toContain('if (mode !== "pick") return;');
    expect(f).toContain('if (mode !== "project" || projects) return;');
    expect(f).toContain("SEARCH_WAIT_MS");
    const wait = Number(/export const SEARCH_WAIT_MS = (\d+)/.exec(add)![1]);
    expect(wait).toBeGreaterThanOrEqual(300);
  });

  test("the built-in view has no remove button", () => {
    expect(fn(rail, "ViewRail")).toContain("{!e.builtin && e.level === 0 && (");
  });

  test("a board inside a project folder has no remove button either", () => {
    const f = fn(rail, "ViewRail");
    const at = f.indexOf("e.level === 0 && (");
    expect(at).toBeGreaterThan(0);
    expect(f.slice(at)).toContain("onRemove(e)");
  });

  test("the search waits for every query but the very first open", () => {
    const f = fn(add, "AddBar");
    expect(f).toContain("asked.current ? SEARCH_WAIT_MS : 0");
    expect(f).not.toMatch(/picks \? SEARCH_WAIT_MS/);
  });

  test("a bell jump while a saved view is open goes through pickView", () => {
    const body = fn(jira, "JiraBody");
    const at = body.indexOf("if (saved) {");
    expect(at).toBeGreaterThan(0);
    const line = body.slice(at, body.indexOf("\n", at));
    expect(line).toContain("pickView(ASSIGNED_VIEW_ID)");
    expect(line).not.toContain("setViewId");
  });
});

describe("going back to the built-in list is remembered", () => {
  test("picking Assigned to me asks for a disk-only read, which sets the current view", () => {
    const body = fn(jira, "JiraBody");
    const pick = body.slice(body.indexOf("const pickView"), body.indexOf("const removeEntry"));
    expect(pick).toMatch(/id === ASSIGNED_VIEW_ID\)[^\n]*api\.jiraView\(id, \{ cached: true \}\)/);
  });
});
