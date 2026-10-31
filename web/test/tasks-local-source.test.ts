/*
 * The Local source of the Tasks view, read as source: the chrome that stays while
 * a state shows, the states' words, the drops, the menus, the dialogs and the pane.
 * The compiled app was measured against the mockup; these pin what that look
 * rests on so a later edit cannot quietly undo it.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const from = (needle: string, to?: string) => {
  const i = src.indexOf(needle);
  expect(i, needle).not.toBe(-1);
  return src.slice(i, to ? src.indexOf(to, i + needle.length) : undefined);
};
const state = from("function LocalState(", "\nfunction LocalBody");
const body = from("function LocalBody(", "\nfunction TaskRow");

describe("Local states", () => {
  it("says what happened in each of its five words", () => {
    for (const s of ["Could not read your tasks file", "Try now", "No tasks yet", "Type one in the bar above and press Enter.", "No task matches", "Clear filters", "Nothing open"]) {
      expect(state).toContain(s);
    }
  });
  it("shows the skeleton while the first read is out, and the counts only once it has landed", () => {
    expect(body).toContain('{!data && <BoardSkeleton label="Reading your tasks…"');
    expect(body).toContain("data ?");
  });
  it("draws the bar, the buckets and the drops before any state, so no state replaces them", () => {
    const bar = body.indexOf("placeholder={editing");
    for (const s of ['<ChipMenu label="Priority"', '<ChipMenu label="Project"', '<ChipMenu label="Tag"', '<ChipMenu label="Sort"', "<LocalState view={view}"]) {
      expect(body.indexOf(s), s).toBeGreaterThan(bar);
    }
  });
  it("keeps the pane on a no-match, because the picked task is looked up in the whole list", () => {
    expect(body).toContain("const picked = data?.tasks.find((t) => t.uuid === sel) ?? null;");
  });
  it("draws the pane and its grip only when a task is picked", () => {
    expect(body).toContain("{picked && <PaneGrip pane={pane} />}");
    expect(body).toContain('usePaneWidth("agentglass.tasks.local.paneWidth")');
  });
});

describe("Local bar", () => {
  it("adds from the same function on Enter and on the Add button", () => {
    expect(body).toContain("const submitBar = async () =>");
    expect(body.split("void submitBar()").length - 1).toBe(2);
  });
  it("draws the marked-tasks bar under the filter row, not above the bar", () => {
    expect(body.indexOf("<BulkBar")).toBeGreaterThan(body.indexOf('<ChipMenu label="Sort"'));
    expect(body.indexOf("<BulkBar")).toBeLessThan(body.indexOf("{!data && <BoardSkeleton"));
  });
  it("sorts by reminder, due, priority or added, and says which is on", () => {
    expect(body).toContain('reminder: "reminder", due: "due", priority: "priority", created: "added"');
  });
});

describe("Local dialogs and menus", () => {
  it("opens New task and the keys in the shared dialog shell", () => {
    expect(src).toContain('<TaskDialog title="New task"');
    expect(body).toContain('<TaskDialog title="Local keys"');
  });
  it("keeps the keys behind a quiet Shortcuts button in the footer", () => {
    expect(body).toContain("Shortcuts");
    expect(body).toContain("<StatusFooter");
  });
  it("gives a row its own menu with the keys it has", () => {
    for (const s of ['label="Copy tags" kbd="t"', 'label="Paste tags" kbd="v"', 'label="Remind me" kbd="r"', 'danger label="Delete" kbd="d"']) expect(body).toContain(s);
    expect(from("function TaskRow(", "\nconst GRID")).toContain("onContextMenu");
  });
  it("opens the terminal menu from the pane with Shell here and Send to terminal", () => {
    expect(src).toContain('label="Shell here" kbd="w"');
    expect(src).toContain('label="Send to terminal" kbd="c"');
  });
  it("draws the reminder band with Ack and the two snoozes", () => {
    const band = from("function NowBand(", "\nfunction ");
    for (const s of ["Reminder due now", ">Ack<", ">Snooze 15<", ">Snooze 60<"]) expect(band).toContain(s);
  });
});

describe("Local row", () => {
  it("keeps one grid, with a priority slot that is always there so titles line up", () => {
    expect(src).toContain('const GRID = "22px minmax(0, 1fr) 110px 100px 112px"');
    expect(from("function TaskRow(", "\nconst GRID")).toContain("width: 14");
  });
});
