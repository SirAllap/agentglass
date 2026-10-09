import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/components/${p}`, import.meta.url)).text();
const files = {
  terminal: await read("TerminalPanel.tsx"),
  diff: await read("diff/DiffControls.tsx"),
  bell: await read("TopBarNotes.tsx"),
  usage: await read("TopBar.tsx"),
  lantern: await read("LanternView.tsx"),
  modal: await read("SettingsModal.tsx"),
  preset: await read("diff/PresetDiff.tsx"),
  git: await read("GitPanel.tsx"),
};
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

describe("panels link to their settings", () => {
  test.each([
    ["terminal", "terminal"],
    ["bell", "notifications"],
    ["usage", "budgets"],
    ["lantern", "lantern"],
    ["diff", "diff"],
  ] as const)("%s opens the %s page from a gear", (k, pane) => {
    const s = code(files[k]);
    expect(s).toContain(`openSettings("${pane}")`);
    expect(s).toMatch(/<GearIcon size=\{ICON\.(xs|md)\} \/>/);
  });

  test("the diff gear sits in both diff toolbars, beside the theme picker", () => {
    expect(code(files.preset)).toMatch(/<ThemePicker[^>]*\/>\s*<DiffSettingsLink \/>/);
    expect(code(files.git)).toMatch(/<ThemePicker[^>]*\/><DiffSettingsLink \/>/);
  });

  test("popover gears close the popover first", () => {
    expect(files.bell).toContain('setOpen(false); openSettings("notifications")');
    expect(files.usage).toContain('onClose(); openSettings("budgets")');
  });

  test("a Sidebar chord chip lands on that view's Shortcuts row", () => {
    expect(code(files.modal)).toContain('openSettings("keys", rowId(LABELS[`view.${v.id}`].label))');
  });
});
