import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Every control in the pull-request bar is one size. There is no renderer here,
 * so the rule is asserted against source: a button in the bar takes `BAR_CTRL`
 * (or `BAR_SQUARE` when it holds only an icon) and does not set a height or a
 * padding of its own. The bar used to hold five heights (22, 24, 27.3, 28, 32)
 * because each control was written beside the code it belongs to.
 */
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const code = (x: string) => x.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
const chrome = code(read("../src/components/workspace/Chrome.tsx"));
const filterBar = code(read("../src/components/PrFilterBar.tsx"));
const panel = code(read("../src/components/PrPanel.tsx"));
const triage = code(read("../src/components/TriageBoard.tsx"));
const freshness = code(read("../src/components/prs/PrFreshness.tsx"));
const css = read("../src/index.css");

/** The opening tag of every <button …>: its props, not the children that follow. */
const buttons = (src: string) => src.split(/<button\b/).slice(1).map((c) => c.split(/>\s*\n\s*(?=[<{A-Za-z])/)[0]!);
const OWN_SIZE = /\b(?:min-h|h|py|px|w)-\[?\d|\bp[xy]-\d|minHeight|height:|width:/;

const bar = filterBar.replace(/<div id="pr-at-people"[\s\S]*?<\/div>\s*\)}\s*<\/div>/, "");

describe("the pull-request bar's one control", () => {
  it("is the CHIP's shape at the 28 rung, with a height and not a minimum", () => {
    expect(chrome).toContain("export const BAR_H = CTRL_H.regular;");
    expect(chrome).toMatch(/export const BAR_CTRL = "[^"]*\bh-\[28px\][^"]*"/);
    expect(chrome).toMatch(/export const BAR_SQUARE = "[^"]*\bw-\[28px\] h-\[28px\][^"]*"/);
    expect(chrome).toMatch(/export const BAR_INPUT =\s*"[^"]*\bh-\[28px\]/);
  });

  it("no button of the filter bar sets its own height or padding", () => {
    /* The clear x sits INSIDE the search box (the mockup's 20px ghost square), so it is the box's own and not a bar control. */
    const bs = buttons(bar).filter((b) => !b.includes('role="option"') && !b.includes('aria-label="Clear all filters"') && !b.includes("aria-label={`Remove "));
    expect(bs.length).toBeGreaterThanOrEqual(4);
    for (const b of bs) {
      expect(b).toMatch(/BAR_CTRL|BAR_SQUARE/);
      expect(b.replace(/\$\{BAR_(?:CTRL|SQUARE)\}/g, "")).not.toMatch(OWN_SIZE);
    }
  });

  it("the search box is the bar's input, not the 32px one", () => {
    expect(bar).toContain("${BAR_INPUT}");
    expect(bar).not.toMatch(/\$\{INPUT\}/);
  });

  it("the view switcher's pill is that control too", () => {
    // viewTab draws a tab of the kit's Segmented track: 24 inside a 2px track is the bar's 28 rung, and it brings no size of its own.
    const from = panel.indexOf("function viewTab(");
    const tab = panel.slice(from, panel.indexOf("\n}\n", from));
    expect(tab).toContain('className="agx-seg-b ');
    expect(tab).not.toMatch(OWN_SIZE);
    expect(panel).toContain('className="agx-seg shrink-0"');
    expect(css).toMatch(/\.agx-seg-b \{[^}]*height: 24px/);
    expect(css).toMatch(/\.agx-seg \{[^}]*padding: 2px/);
  });

  it("the refresh, the age and the banner buttons take the bar's height and icon", () => {
    expect(panel).toContain("iconSize={BAR_ICON}");
    expect(freshness).toMatch(/inline-flex items-center h-\[28px\] text-\[11px\] tabular-nums/);
    expect(panel).toContain("<PrFreshness ");
    /* The "Back to the board" button of the search banner is the kit's kit Button (compact, as the mockup draws it), not a hand-sized one. */
    expect(triage).toMatch(/<Button size="compact"[^>]*onClick=\{closedView\.onBack\}/);
    /* The person banner's Follow and Back are the kit's too (it used to hand-size a bar control). */
    expect(triage).toContain('<Button size="compact" onClick={onBack}>Back</Button>');
  });

  it("no bar control draws its glyph at a size of its own", () => {
    /* The clear x inside the box is the one glyph with a rung of its own (ICON.xs, the mockup's 12px x). */
    expect(bar.replace(/<CloseIcon size=\{ICON\.xs\}/g, "")).not.toMatch(/Icon size=\{ICON\.(?:xs|md)\}/);
  });
});

describe("the views segment and the deck at rest sit on the bar's rung", () => {
  // Measured: the segment was 32 (28 buttons inside 2px of padding) and the quiet
  // deck 40, so both stood taller than the 28 search box beside them.
  const views = code(read("../src/components/PrViewsBar.tsx"));
  const deck = code(read("../src/components/PrFilterDeck.tsx"));

  it("the views sit under the bar in the deck's row: their chips are the 26 rung, the row 38 tall, none of it in the 28 bar", () => {
    expect(views).toContain('className="agx-vchip"');
    expect(css).toMatch(/\.agx-vchip \{[^}]*height: 26px/);
    expect(panel).not.toMatch(/minHeight: 38, borderBottom/);
    expect(views).not.toMatch(/relative h-7 px-2\.5/);
  });

  it("the deck's row is the views row's height: 38 tall, chips on the 24 rung", () => {
    expect(css).toMatch(/\.agx-drow \{[^}]*min-height: 38px/);
    expect(css).toMatch(/\.agx-rchip \{[^}]*height: 24px/);
    expect(deck).toContain('className="agx-drow"');
  });
});

describe("the deck is a block under the bar, and the bar can clear it", () => {
  // Drawn inside the wrapping toolbar row, the open deck stretched the row to
  // ~200 px with every other control floating in the middle of it.
  const views = code(read("../src/components/PrViewsBar.tsx"));
  const deck = code(read("../src/components/PrFilterDeck.tsx"));

  it("PrFilterDeck renders after the header has closed, not inside it", () => {
    const head = panel.indexOf("agx-prbar flex-wrap");
    const refresh = panel.indexOf("Refresh the list", head);
    const deckAt = panel.indexOf("<PrFilterDeck", head);
    expect(head).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(-1);
    expect(deckAt).toBeGreaterThan(refresh);
  });

  it("the views and the rules are ONE row of the sub-bar (the owner's two-row header), under the bar", () => {
    const at = panel.indexOf("<PrFilterDeck filter={laneFilter}");
    expect(at).toBeGreaterThan(-1);
    expect(panel.slice(at, at + 900)).toContain("viewsRow={<PrViewsBar api={viewsApi}");
    expect(deck).toContain("{viewsRow}");
    expect(views).not.toContain('<span className="flex-1" />\n\n      {/* As drawn');
    expect(panel).toContain('className="agx-subbar"');
    expect(panel.indexOf('className="agx-subbar"')).toBeGreaterThan(panel.indexOf("Refresh the list"));
    expect(css).toMatch(/\.agx-subbar \{[^}]*border-bottom/);
  });

  it("Clear rules is a deck control that holds its place, and Undo brings the rules back", () => {
    expect(deck).toContain('disabled={total === 0} title="Remove every rule">Clear rules</Button>');
    expect(deck).toContain("disabled={!canUndo || !onUndo}");
    expect(deck).toContain("onChange(emptyLanes())");
    /* The views row no longer carries a second Clear: one home for it. */
    expect(views).not.toContain("Clear filters");
    expect(views).not.toContain("undoClear");
  });
});
