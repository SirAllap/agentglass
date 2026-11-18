import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Measured headless at 2540x900: Settings > Tasks was the only page whose "On this page" rail moved
// (83 positions; every other page 1-6), and a click on Card tracker did not leave Card tracker lit.
// Tasks drew three pages stacked in one scroller: its own, Tools & services and the old Card tracker
// page. Each page's sticky rail only sticks inside its own page, so the Tasks rail scrolled away under
// the Tools one, and "Card tracker" was a section of two pages (card-tracker and tracker).
const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const tasks = readFileSync(new URL("../src/components/settings/pages/TasksPage.tsx", import.meta.url), "utf8");

test("off a search, Tasks is one page: Tools & services' sections are drawn inside it, not as a second page", () => {
  expect(modal).toContain('{show("tasks") && <TasksPage c={pageCtx} folded={tasksFold} />}');
  expect(modal).toContain("const tasksFold = ql ? undefined : <ToolsSections open={open} />;");
  expect(tasks).toMatch(/\.\.\.\(folded \? \[\{ id: "services"[^\]]*body: folded \}\] : \[\]\)/);
});

test("the folded pages are drawn as their own page only as a search hit or off Tasks", () => {
  expect(modal).toContain('{show("connections") && (ql || pane !== "tasks") && <ToolsPane open={open} />}');
  expect(modal).toContain('{show("tracker") && (ql || pane !== "tasks") && <TrackerSettingsPage />}');
});

test("the Tools filter and Recheck stay with the tools: on that section's heading inside Tasks", () => {
  expect(modal).toContain('<Section id="tools" title="Tools on this machine" action={barOnHeading ? bar : undefined}>');
  expect(modal).toContain("useToolsSections(open, true)");
});
