import { describe, expect, test } from "bun:test";

/*
 * A merge put the ClickUp board pane (`{!Main && <div …>`) around three things
 * that belong to the rail: the folder's right-click menu, the "+" list and the
 * Add bar. A source with a `Main` (Jira) never draws that pane, so on Jira the
 * "+" did nothing and a right-click on a folder showed nothing, with no error.
 * A rule about source is asserted against source: there is no renderer here.
 */
const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const tree = await Bun.file(new URL("../src/components/jira/JiraTree.tsx", import.meta.url)).text();

const open = panel.indexOf("{!Main && <div");
const close = panel.indexOf("\n      </div>}", open);

describe("the rail's own layers are not inside the ClickUp board pane", () => {
  test("the pane's bounds are found", () => {
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
  });
  for (const [name, needle] of [["folder menu", "{folderMenu && ("], ['"+" list', "<AddSpacePopover"], ["Add bar", "<source.AddView"]] as const) {
    test(`${name} is drawn after the pane closes`, () => {
      const at = panel.indexOf(needle);
      expect(at).not.toBe(-1);
      expect(at).toBeGreaterThan(close);
    });
  }
});

describe("a folder, a space and a board can leave the sidebar without a right-click", () => {
  const railItem = panel.slice(panel.indexOf("const railItem = ("), panel.indexOf("const railItem = (") + 9000);
  test("the folder row carries a More button, visible on hover and on focus, that opens the folder menu", () => {
    expect(railItem).toContain("`More for ${r.label}`");
    expect(railItem).toContain("group-hover:opacity-100");
    expect(railItem).toContain("group-focus-within:opacity-100");
    expect(railItem).toContain("setFolderMenu({ f: r.folder!");
  });
  test("the keyboard has the menu key for it too", () => {
    expect(panel).toContain('e.key === "ContextMenu"');
  });
  test("the Jira tree's space and view rows carry the same button", () => {
    expect(tree).toContain('(r.kind === "space" || r.kind === "view")');
    expect(tree).toContain("`More for ${o.label}`");
    expect(tree).toContain("group-focus-within:opacity-100");
  });
});

describe("the Jira rail's header has air", () => {
  test("it is 48 tall (8 above and below the 32px filter) and its controls are 8 apart", () => {
    expect(panel).toContain("const JIRA_RAIL_HEAD_H = 48;");
    expect(panel).toContain('isJira ? "gap-2 px-2" : "gap-1 px-1.5"');
    expect(panel).toContain("height: isJira ? JIRA_RAIL_HEAD_H : HEAD_H");
  });
});
