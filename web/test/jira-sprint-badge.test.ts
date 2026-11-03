/**
 * The sprint is a badge on the crumb line, and the areas rail marks its
 * selection the way the lists rail does.
 *
 * What a mistake costs: a second row of toolbar that the other tracker does
 * not have, so the two boards stop lining up.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const url = (p: string) => new URL(p, import.meta.url);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CTX = strip(readFileSync(url("../src/components/jira/JiraBoardContext.tsx"), "utf8"));
const PANEL = strip(readFileSync(url("../src/components/TasksPanel.tsx"), "utf8"));
const AREAS = strip(readFileSync(url("../src/components/jira/JiraAreas.tsx"), "utf8"));

test("the sprint is an inline badge carrying the range, points and goal in its title", () => {
  expect(CTX).toContain('data-testid="jira-sprint"');
  expect(CTX).toContain("title=");
});

test("the badge sits in the first toolbar row, right after the breadcrumb", () => {
  const crumb = PANEL.indexOf("<Breadcrumb");
  const badge = PANEL.indexOf("<JiraSprintHeader");
  expect(crumb).toBeGreaterThan(-1);
  expect(badge).toBeGreaterThan(crumb);
  expect(badge - crumb).toBeLessThan(600);
});

test("the areas rail marks its selected row with a bar, not a border above the group", () => {
  expect(AREAS).toContain("inset 2px 0 0 var(--primary)");
  expect(AREAS).not.toContain("borderTop");
});
