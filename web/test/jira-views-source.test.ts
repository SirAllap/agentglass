/*
 * The Jira tab draws its groups with the Tasks board's own heading and asks
 * nothing until it has to. The screens have no renderer here, so the rules are
 * asserted against their source.
 *
 * What a mistake costs: a second copy of the list that drifts from ClickUp's,
 * a search box that asks on every key.
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
const facts = await Bun.file(new URL("../src/components/jira/JiraFacts.tsx", import.meta.url)).text();
const railFile = new URL("../src/components/jira/ViewRail.tsx", import.meta.url);
const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const add = await Bun.file(new URL("../src/components/jira/AddBar.tsx", import.meta.url)).text();
const head = await Bun.file(new URL("../src/components/tasks/GroupHead.tsx", import.meta.url)).text();

describe("the group heading is one component", () => {
  test("ClickUp's groups use it, and no longer draw their own chevron", () => {
    expect(fn(panel, "ClickUpBody")).toMatch(/<GroupHead\s/);
    expect(fn(panel, "ClickUpBody")).not.toContain("agx-group-head");
    expect(strip(head)).toContain("agx-group-head");
  });

  test("Jira has no list of its own: no row, no pill, no face, no group, and no second rail", async () => {
    const j = strip(jira);
    for (const name of ["Row", "StatusPill", "Face", "JiraBody"]) expect(j, name).not.toMatch(new RegExp(`function ${name}\\(`));
    expect(j).not.toContain("<GroupHead");
    expect(await Bun.file(railFile).exists()).toBe(false);
  });

  test("the tab mounts the board's body, and what it draws for a card is Jira's own pane", () => {
    const j = strip(jira);
    expect(strip(facts).match(/function JiraFacts\(/g)).toHaveLength(1);
    expect(j).not.toContain("function Facts(");
    expect(j).toContain("<JiraCard ");
    expect(strip(panel)).toContain("source={JIRA_BOARD} />");
  });
});

describe("what it asks, and when", () => {
  test("the pick lists are read when opened, and a search waits for the typing to pause", () => {
    const f = fn(add, "AddBar");
    expect(f).toContain('if (mode !== "pick") return;');
    expect(f).toContain('if (mode !== "project" || projects) return;');
    expect(f).toContain("SEARCH_WAIT_MS");
    const wait = Number(/export const SEARCH_WAIT_MS = (\d+)/.exec(add)![1]);
    expect(wait).toBeGreaterThanOrEqual(300);
  });

  test("the search waits for every query but the very first open", () => {
    const f = fn(add, "AddBar");
    expect(f).toContain("asked.current ? SEARCH_WAIT_MS : 0");
    expect(f).not.toMatch(/picks \? SEARCH_WAIT_MS/);
  });
});
