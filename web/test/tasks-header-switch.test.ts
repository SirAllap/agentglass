/**
 * The Tasks header carries the write switch; the board toolbar carries no poll text.
 *
 * Read from source: there is no renderer here. What has to hold is where each
 * control lives, so the slices are cut at the component's own boundaries.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const url = (p: string) => new URL(p, import.meta.url);
const PANEL = readFileSync(url("../src/components/TasksPanel.tsx"), "utf8");
const SWITCH = (() => {
  try { return readFileSync(url("../src/components/tasks/WritesSwitch.tsx"), "utf8"); } catch { return ""; }
})();

/** The header of the view: from its opening tag to its closing one. */
function header(): string {
  const from = PANEL.indexOf("<ViewHeader label=\"Tasks\"");
  expect(from, "the Tasks header is gone").toBeGreaterThan(-1);
  const to = PANEL.indexOf("</ViewHeader>", from);
  return PANEL.slice(from, to);
}

test("the write switch is its own component with role=switch and a fixed width", () => {
  expect(SWITCH).toContain('role="switch"');
  expect(SWITCH).toMatch(/aria-checked=\{/);
  expect(SWITCH).toContain("Read-only");
  expect(SWITCH).toContain("Changes on");
  expect(SWITCH).toMatch(/w-\[140px\]/);
});

test("the switch sits in the header's actions slot and is disabled off the boards", () => {
  expect(header()).toContain("<WritesSwitch");
  expect(header()).toContain("actions={");
  expect(SWITCH).toContain("Open a board to change this");
  expect(SWITCH).not.toContain("Applies to ClickUp and Jira boards");
});

test("the old read-only chip is gone from the board toolbar", () => {
  expect(PANEL).not.toMatch(/>\s*read-only\s*<\/button>/);
});

test("the board stamp no longer says it polls", () => {
  expect(PANEL).not.toContain("· auto ");
  expect(PANEL).not.toContain("Re-reads itself every");
});

test("an idle board sets no timer: coming back to the window is the only event", () => {
  expect(PANEL).not.toContain("setInterval(tick");
  expect(PANEL).not.toContain("BOARD_TICK_MS");
});
