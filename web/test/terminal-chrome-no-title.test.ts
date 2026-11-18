// Terminal chrome: every hint goes through the house tooltip (data-tip, drawn by
// TipHost), never the browser's own `title` on a DOM element. A component's own
// `title` prop (CloseButton, Badge…) is not the native attribute and is allowed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src/components");
const FILES = [
  "CommandBar.tsx",
  "CommandLog.tsx",
  "FindBar.tsx",
  "ShellConsole.tsx",
  "TerminalPanel.tsx",
  "terminal/CommandsPopover.tsx",
  "terminal/GoList.tsx",
  "terminal/ManageSessions.tsx",
  "terminal/PaneBar.tsx",
  "terminal/PaneChipStatus.tsx",
  "terminal/PluckPalette.tsx",
  "terminal/ProjectChip.tsx",
  "terminal/SessionSwitcher.tsx",
  "terminal/SidePane.tsx",
  "terminal/TermStrip.tsx",
  "terminal/WindowSwitcher.tsx",
  "terminal/WindowTab.tsx",
];

/** `title=` whose enclosing tag starts lowercase, i.e. a DOM element. */
function nativeTitles(src: string): number[] {
  const out: number[] = [];
  for (const m of src.matchAll(/\btitle=(?=[{"'])/g)) {
    const at = m.index ?? 0;
    const open = src.lastIndexOf("<", at);
    const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(open, open + 40));
    if (tag && /^[a-z]/.test(tag[1])) out.push(src.slice(0, at).split("\n").length);
  }
  return out;
}

describe("terminal chrome: no native title", () => {
  for (const f of FILES) {
    test(f, () => {
      expect(nativeTitles(readFileSync(join(SRC, f), "utf8"))).toEqual([]);
    });
  }
  test("the detector sees a native title and skips a component prop", () => {
    expect(nativeTitles('<span title="x">a</span>\n<CloseButton title="y" />')).toEqual([1]);
  });
});
