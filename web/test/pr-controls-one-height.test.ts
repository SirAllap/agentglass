/**
 * Every control in a bar of the pull-request view takes its height from the shared token.
 *
 * Measured in the detail header: the state badge was 22px, the Review menu and the overflow menu 22px,
 * the GitHub, bell and link buttons 26px, the expand and close chips 26px at another icon size, and a
 * merge button 30px beside 26px neighbours. Each was a hand-written `h-[22px]`, `py-0.5`, or a number in a
 * style prop, and the kit's `CTRL_H` rung was nowhere in them. A control now gets its height from the kit
 * `Button` / `Menu` (a `size`), from `CTRL_H.<rung>` in its own style, never from padding or a literal.
 *
 * Asserted on source, since there is no renderer: the open tag of every `<button>`, `<a>` and `<select>`
 * in the bar regions below must not set a height by `py-N`, `h-N`, `h-[Npx]`, `min-h-` or a numeric
 * `height`. Exempt are what is not a control in a bar: a full-width row (`w-full`, `flex-1`), a list or menu option,
 * a round chip's remove mark (`rounded-full`), a dashed empty-slot block and a 1px rule. The rest of PrPanel.tsx is counted, and the
 * count may only go down. The card follows its own design page and is not here.
 */
import { describe, expect, it } from "bun:test";

const read = (f: string) => Bun.file(new URL(`../src/components/${f}`, import.meta.url)).text();
const [panel, rail, picker, board] = await Promise.all([read("PrPanel.tsx"), read("FileRail.tsx"), read("PrAskPicker.tsx"), read("TriageBoard.tsx")]);

/** The open tags of hand-made controls in `src`: from `<button` to its `>` (not `=>`) outside braces. */
export function handSized(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<(button|a|select)\b/g)) {
    let j = m.index! + m[0].length, depth = 0;
    for (; j < src.length; j++) {
      const c = src[j]!;
      if (c === "{") depth++; else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && src[j - 1] !== "=") break;
    }
    const tag = src.slice(m.index!, j + 1).replace(/\s+/g, " ");
    const sizes = /(\s|")(min-)?(py-\d|h-\[\d|h-\d)|height:\s*\d|minHeight:\s*\d/.test(tag);
    const exempt = /\bw-full\b|\bflex-1\b|role="(option|menuitem|menuitemcheckbox)"|rounded-full|\bh-px\b|dashed/.test(tag);
    if (sizes && !exempt) out.push(tag.slice(0, 120));
  }
  return out;
}

/** From `start` to the first `end` after it, comment lines out. */
function region(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  expect(at).toBeGreaterThan(-1);
  const to = src.indexOf(end, at + start.length);
  expect(to).toBeGreaterThan(at);
  return src.slice(at, to);
}

describe("controls in the pull-request bars take the shared height", () => {
  const bars: Record<string, string> = {
    "the detail header and its identity row": region(panel, "function Masthead(", "\n/**\n * Why Update branch will only sync"),
    "the dock's own controls (expand, close)": region(panel, "const dockControls = ", "  return (\n    <RepoCtx.Provider"),
    "the tab strip": region(panel, "<Tabs", "Add your review"),
    "the merge dock": region(panel, "function PrDock(", "function OverviewSlot("),
    "the sidebar": region(panel, "function SidebarSection(", "function Masthead("),
    "the Files rail": rail,
    "the people picker": picker,
    "the board": board,
  };
  for (const [name, src] of Object.entries(bars)) {
    it(`${name} sets no height of its own`, () => {
      expect(handSized(src)).toEqual([]);
    });
  }

  it("the state badge, the menus and the dock buttons name a CTRL_H rung", () => {
    const head = bars["the detail header and its identity row"];
    expect(head).toContain("height: CTRL_H.hit, color: tint");
    expect(head).toContain('size="hit" square>');
    expect(head).toContain('primary={false} size="hit"');
    const dock = region(panel, "function PrDock(", "function OverviewSlot(");
    expect(panel).toContain("style={{ height: CTRL_H.hit, ...(canMerge");
    expect(panel).toContain("width: CTRL_H.hit, height: CTRL_H.hit, border: EDGE");
    expect(dock).toContain('size="hit" square>');
  });

  it("the dock has air round its rows: padding above and below, and a gap between wrapped rows", () => {
    // Wrapped into two rows at the docked width, the dock had a minimum height and no padding, so the rows
    // touched each other and the dock's edge. The mockup's dock is 54px with 14px sides and 8px between.
    const dock = region(panel, "function PrDock(", "function OverviewSlot(");
    expect(dock).toContain("flex items-center gap-2 px-3.5 py-3 min-h-[54px] flex-wrap");
  });

  it("the dock keeps its buttons out from under the floating bench button", () => {
    // The bench button (data-floating-furniture) floats at the window's bottom right: in a docked
    // detail it sat on the end of the dock's last row, over the Merge text once the rows wrapped.
    const dock = region(panel, "function PrDock(", "function OverviewSlot(");
    expect(dock).toContain("useFurnitureClear<HTMLDivElement>(");
    expect(dock).toContain("ref={bar}");
    expect(dock).toContain("paddingRight: 14 + clear");
  });

  it("the rest of PrPanel.tsx does not grow its hand-sized controls", () => {
    // Lower this when one is converted; raise it never. What is left is the pull-request mention chip inside a sentence of the activity feed.
    const CEILING = 1;
    const n = handSized(panel).length;
    expect(n, `${n} hand-sized controls, below the ceiling of ${CEILING}: lower CEILING to ${n}`).toBeLessThanOrEqual(CEILING);
    expect(n).toBeGreaterThanOrEqual(CEILING);
  });
});
