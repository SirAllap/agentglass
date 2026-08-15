/*
 * The lists, down the side instead of across the top.
 *
 * A row of chips works at four boards and stops working well before twenty:
 * they wrap onto a second and third line, push the table down, and there is no
 * way to search them. He asked what happens at twenty, chose a rail from a
 * mockup, and the part that actually scales is the filter box — not the shape.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

/** The rail's own markup. Sliced from its opening tag to ITS closing one — the
 *  first `</nav>` in the file belongs to something else entirely. */
function railSource(): string {
  const from = src.indexOf('<nav aria-label="Lists"');
  return src.slice(from, src.indexOf("</nav>", from));
}

describe("the list rail", () => {
  it("replaces the row of chips rather than sitting beside it", () => {
    // Two navigations for one choice is two places to disagree about which
    // board you are on.
    expect(src).not.toContain("{boards.views.map((v) => (");
    expect(src).toContain("{railViews.map((v) => (");
  });

  it("filters on both names a board has", () => {
    /* The rail draws `listName || name`. Matching only the drawn one leaves a
       board findable by a word that is not on screen and unfindable by the one
       that is. */
    expect(src).toContain("`${v.listName ?? \"\"} ${v.name}`.toLowerCase().includes(needle)");
  });

  it("survives having no boards at all yet", () => {
    // `boards` is null until the first answer lands, and this runs on the first
    // frame.
    expect(src).toContain("const all = boards?.views ?? [];");
  });

  it("says so when the filter matches nothing", () => {
    // An empty column with a full filter box reads as a broken list.
    expect(src).toContain("No list by that name.");
  });

  it("folds, and is remembered folded", () => {
    expect(src).toContain('const RAIL_KEY = "agentglass.clickup.listRail";');
    expect(src).toContain("width: railOpen ? 214 : 34");
  });

  it("opens by default, including for somebody who has never set it", () => {
    /* `!== "0"` and not `=== "1"`: with twenty boards the rail is how you move,
       and a first run that hides the navigation teaches people it is not there. */
    expect(src).toContain('localStorage.getItem(RAIL_KEY) !== "0"');
  });

  it("keeps the built-in board marked", () => {
    // Beside four board names it reads as a fifth board somebody added, and it
    // is the one that behaves differently — no address, ten seconds not one.
    const rail = railSource();
    expect(rail).toContain("v.builtin && (");
    expect(rail).toContain("wanted === v.id && <span");
  });

  it("keeps Looked up beside the lists, not inside one", () => {
    // A card from another list sitting in somebody's sprint reads as being IN
    // it.
    const rail = railSource();
    expect(rail).toContain("Looked up");
    // Separated from the boards above it rather than filed among them.
    expect(rail).toContain("1px dashed");
  });

  it("is flat, and says why in the source rather than pretending", () => {
    /* ClickUp nests these under spaces and folders and the approved mockup drew
       that. agentglass only learns a board's folder when the board is opened,
       so the tree would cost one call per board every time the rail opened.
       The deviation was told, not decided. */
    expect(src).toContain("Deliberately FLAT.");
  });
});
