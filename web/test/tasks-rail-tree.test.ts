/*
 * The ClickUp lists rail is a tree, and behaves like one.
 *
 * It was twenty buttons: Tab crossed every one, the arrow keys did nothing, a
 * name cut at sixteen characters could not be read anywhere, and a folded
 * folder hid the very list a filter had just found. The keyboard model is a
 * pure function of the visible rows (railTree.ts) and is tested by calling it;
 * what the screen has to say about it is asserted against the source, because
 * there is no renderer in this project.
 */
import { describe, expect, it } from "bun:test";
import { RAIL_W_DEFAULT, RAIL_W_MAX, RAIL_W_MIN, clampRailW, railKey, railSplit, type RailNode } from "../src/lib/railTree.ts";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

/** The rail's model and its row renderer, up to the next unrelated block. */
function railBlock(): string {
  const from = src.indexOf("const railFiltering =");
  const to = src.indexOf("/* Sidebar or modal.", from);
  expect(from, "the rail's model is gone").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

// space > folder (open) > two lists, the first with two views open, then a folder that is shut.
const ROWS: RailNode[] = [
  { level: 1, expanded: true },   // 0 space
  { level: 2, expanded: true },   // 1 folder
  { level: 3, expanded: true },   // 2 list with views
  { level: 4 },                   // 3 view
  { level: 4 },                   // 4 view
  { level: 3 },                   // 5 list, no views
  { level: 2, expanded: false },  // 6 folder, shut
];

describe("railKey, the keyboard model", () => {
  it("moves down and up, and stops at the ends instead of wrapping", () => {
    expect(railKey(ROWS, 0, "ArrowDown")).toEqual({ kind: "focus", index: 1 });
    expect(railKey(ROWS, 3, "ArrowUp")).toEqual({ kind: "focus", index: 2 });
    expect(railKey(ROWS, 6, "ArrowDown")).toBeNull();
    expect(railKey(ROWS, 0, "ArrowUp")).toBeNull();
  });

  it("Home and End jump to the first and last row", () => {
    expect(railKey(ROWS, 4, "Home")).toEqual({ kind: "focus", index: 0 });
    expect(railKey(ROWS, 2, "End")).toEqual({ kind: "focus", index: 6 });
  });

  it("Right opens a closed row, and steps into an open one", () => {
    expect(railKey(ROWS, 6, "ArrowRight")).toEqual({ kind: "toggle", index: 6 });
    expect(railKey(ROWS, 1, "ArrowRight")).toEqual({ kind: "focus", index: 2 });
    // A leaf has nowhere to go.
    expect(railKey(ROWS, 5, "ArrowRight")).toBeNull();
  });

  it("Left closes an open row, and otherwise steps out to the parent", () => {
    expect(railKey(ROWS, 2, "ArrowLeft")).toEqual({ kind: "toggle", index: 2 });
    expect(railKey(ROWS, 4, "ArrowLeft")).toEqual({ kind: "focus", index: 2 });
    // The parent of a list is the folder above it, not the row just above.
    expect(railKey(ROWS, 5, "ArrowLeft")).toEqual({ kind: "focus", index: 1 });
    expect(railKey(ROWS, 6, "ArrowLeft")).toEqual({ kind: "focus", index: 0 });
    // A top-level closed row has no parent.
    expect(railKey([{ level: 1 }], 0, "ArrowLeft")).toBeNull();
  });

  it("Enter and Space use the row; anything else is left alone", () => {
    expect(railKey(ROWS, 3, "Enter")).toEqual({ kind: "activate", index: 3 });
    expect(railKey(ROWS, 3, " ")).toEqual({ kind: "activate", index: 3 });
    expect(railKey(ROWS, 3, "a")).toBeNull();
    expect(railKey(ROWS, 99, "ArrowDown")).toBeNull();
  });
});

describe("the filter's match", () => {
  it("cuts a name around the match, case-insensitively", () => {
    expect(railSplit("Voice and Transcript", "TRANS")).toEqual(["Voice and ", "Trans", "cript"]);
    expect(railSplit("Billing Rules", "")).toEqual(["Billing Rules", "", ""]);
    // Matched on a name that is not drawn (the tooltip's list name): nothing to underline.
    expect(railSplit("Caller Identity", "regional")).toEqual(["Caller Identity", "", ""]);
  });
});

describe("the rail's width", () => {
  it("is the person's to change, within reason", () => {
    expect(clampRailW(10)).toBe(RAIL_W_MIN);
    expect(clampRailW(9999)).toBe(RAIL_W_MAX);
    expect(clampRailW(RAIL_W_DEFAULT)).toBe(RAIL_W_DEFAULT);
    // It was 214 and cut names at sixteen characters.
    expect(RAIL_W_DEFAULT).toBeGreaterThan(214);
  });

  it("is kept, and has a keyboard handle as well as a mouse one", () => {
    expect(src).toContain('const RAIL_W_KEY = "agentglass.clickup.listRail.width";');
    expect(src).toContain('aria-label="Resize the list menu"');
    expect(src).toContain('e.key === "ArrowRight") { e.preventDefault(); setRailW(');
    expect(src, "no easing while the pointer is dragging it").toContain('transition: railDrag ? "none"');
  });
});

describe("the rail on screen", () => {
  it("is a tree of tree items, with the state a screen reader reads", () => {
    const b = railBlock();
    expect(src).toContain('role="tree" aria-label="ClickUp lists"');
    expect(b).toContain('<div role="treeitem" data-rail-key={r.key}');
    for (const attr of ["aria-level={r.level}", "aria-expanded={r.expanded}", "aria-selected={"]) expect(b).toContain(attr);
    expect(b, "a leaf has no aria-expanded at all").toContain("expanded: more ? open : undefined");
  });

  it("is one Tab stop: a roving tabindex, not a tab stop per row", () => {
    const b = railBlock();
    expect(b).toContain("tabIndex={railStop === r.key ? 0 : -1}");
    // The stop is the last row focused, else the open board, else the first.
    expect(b).toContain("railRows.find(railSelected) ?? railRows[0]");
    expect(b).toContain("onFocus={() => setRailFocus(r.key)}");
  });

  it("reads the open board without touching `lit`, which is declared far below", () => {
    // Reading it here is a temporal-dead-zone crash the first render a row exists.
    const b = railBlock();
    const code = b.split("\n").filter((l) => !l.trim().startsWith("/*") && !l.trim().startsWith("*")).join("\n");
    expect(code).toContain("const railLit = wanted ?? data?.view?.id;");
    expect(code).not.toMatch(/[^A-Za-z.]lit ===/);
  });

  it("puts the arrow keys through railKey", () => {
    const b = railBlock();
    expect(b).toContain("railKey(railRows, at, e.key)");
    expect(src).toContain("onKeyDown={onRailKey}");
  });

  it("gives every row the full name as a tooltip, so a cut name can be read", () => {
    const b = railBlock();
    expect(b).toContain("title={r.title}");
    // The row's title is built from the whole name and its place, not from the drawn label.
    expect(b).toContain("`${crumb}${v.listName && v.name !== v.listName ? `${v.listName} · ${v.name}` : v.name}`");
    expect(b).toContain('className="truncate min-w-0 flex-1"');
  });

  it("opens a folded folder while a filter is typed, or the match hides behind it", () => {
    expect(railBlock()).toContain("const shutNow = (k: string) => !railFiltering && railShut[k] === true;");
  });

  it("asks ClickUp for nothing: every count is one the panel already had", () => {
    const b = railBlock();
    expect(b).not.toMatch(/api\./);
    expect(b).not.toContain("fetch(");
    expect(b).not.toContain("ensureListViews(");
  });

  it("clears the filter with a button, with Escape, and says what to do when nothing matches", () => {
    expect(src).toContain('aria-label="Clear the filter"');
    expect(src).toContain('e.key === "Escape" && railQ');
    expect(src).toContain("No list matches");
    expect(src).toContain("Clear filter");
    // The button is only there when there is something to clear.
    expect(src).toContain("{railQ && (");
  });

  it("goes from the filter into the tree with the down arrow", () => {
    expect(src).toContain('e.key === "ArrowDown" && railStop');
  });

  it("targets a twisty at the house minimum and a row at the house hit size", () => {
    const b = railBlock();
    expect(b).toContain("height: HIT");
    expect(b).toContain("width: MIN_BOX, height: HIT");
  });
});

describe("the rail's motion", () => {
  it("animates only the twisty, briefly, and not at all under reduced motion", () => {
    expect(css).toMatch(/\.agx-rail-chev \{ transition: transform 120ms /);
    const reduced = css.slice(css.indexOf(".agx-rail-chev {"));
    expect(reduced).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.agx-rail-row, \.agx-rail-chev \{ transition: none; \}/);
    // Nothing on the rail lasts longer than the house's 150ms.
    for (const m of css.slice(css.indexOf(".agx-rail-row")).split("\n\n")[0]!.matchAll(/(\d+)ms/g)) expect(Number(m[1])).toBeLessThanOrEqual(150);
  });

  it("hovers only for a real pointer, so a tap does not leave a row lit", () => {
    expect(css).toContain("@media (hover: hover) and (pointer: fine) {\n  .agx-rail-row:hover");
  });
});
