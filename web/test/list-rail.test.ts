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
    // The rows come off `railViews` — through the grouping, which is the only
    // thing between the filter and the column.
    expect(src).toContain("const railGroups = useMemo(");
    expect(src).toContain("for (const v of railViews)");
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
    expect(src).toContain("No list matches");
  });

  it("folds, and is remembered folded", () => {
    expect(src).toContain('const RAIL_KEY = "agentglass.clickup.listRail";');
    expect(src).toContain("width: railOpen ? railW : 34");
  });

  it("opens by default, including for somebody who has never set it", () => {
    /* `!== "0"` and not `=== "1"`: with twenty boards the rail is how you move,
       and a first run that hides the navigation teaches people it is not there. */
    expect(src).toContain('localStorage.getItem(RAIL_KEY) !== "0"');
  });

  it("keeps the built-in board marked", () => {
    /* Beside four board names it reads as a fifth board somebody added, and it
       is the one that behaves differently — no address, ten seconds not one.
       One renderer (`railItem`) draws every row, so the halves cannot drift. */
    const from = src.indexOf("const railItem = (r: RailRow, i: number)");
    const row = src.slice(from, src.indexOf("\n  };\n", from));
    expect(from).toBeGreaterThan(-1);
    expect(row).toContain('r.kind === "builtin"');
    expect(row).toContain("busy &&");
  });

  it("draws ClickUp's own shape: folder, then the lists in it", () => {
    /* The rail was flat, and said in a comment that it had to be — a board's
       folder was only known once it had been opened. A folder can be added
       whole now, so its lists arrive knowing where they live. */
    expect(src).not.toContain("Deliberately FLAT.");
    const from = src.indexOf("const railRows = useMemo");
    const rows = src.slice(from, src.indexOf("}, [boards, railGroups", from));
    expect(rows).toContain("railGroups.loose");
    expect(rows).toContain("railGroups.groups");
    // Folded shut is remembered, or a sidebar of twelve open folders is the
    // flat list again.
    expect(src).toContain('const RAIL_SHUT_KEY = "agentglass.clickup.listRail.shut";');
  });

  it("only offers to remove the folders somebody actually added", () => {
    /* A heading inferred from a pasted list's breadcrumb is not a saved folder:
       there is nothing to take off, and offering it would be a menu item that
       cannot work. */
    const from = src.indexOf("const railItem = (r: RailRow, i: number)");
    const row = src.slice(from, src.indexOf("\n  };\n", from));
    expect(row).toContain("if (r.folder) {");
  });

  it("keeps Looked up beside the lists, not inside one", () => {
    // A card from another list sitting in somebody's sprint reads as being IN
    // it.
    const from = src.indexOf("const railRows = useMemo");
    const rows = src.slice(from, src.indexOf("}, [boards, railGroups", from));
    // The last row of the tree, at the top level, after every space and folder.
    expect(rows).toContain('kind: "looked"');
    expect(rows.indexOf('kind: "looked"')).toBeGreaterThan(rows.indexOf('kind: "space"'));
  });


});

describe("the list's own blurb", () => {
  it("is offered only when the list has one", () => {
    /* Most lists have none, and a control over nothing is worse than no
       control. Asserted because this went missing once between an edit and an
       install and nothing failed — the panel simply had no such section. */
    expect(src).toContain("!!data?.description?.trim()");
    expect(src).toContain("function AboutList(");
  });

  it("opens over the board rather than above it", () => {
    /* As a fold it pushed the rows down by two hundred pixels: the reference
       material shoving aside the thing you came to read. */
    expect(src).toContain("<Portal find z={LAYER.viewer}>");
    expect(src).not.toContain('const DESC_KEY = "agentglass.clickup.listDescription";');
  });

  it("turns what it can into somewhere to go", () => {
    // A pull request opens in this app's own view, a card id opens the card.
    expect(src).toContain("openPr(pr.repo, pr.number)");
    expect(src).toContain("openCard(id, id)");
  });
});
