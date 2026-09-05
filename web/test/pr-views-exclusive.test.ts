/*
 * Picking a view picks a view — all seven of them.
 *
 * The pull-request panel shows exactly one of three things, chosen by one row
 * of controls: the inbox, the triage board, or the table under a scope. The
 * render says so plainly — `inboxOn ? <Inbox/> : boardShown ? <TriageBoard/> :
 * <table/>`.
 *
 * The row did not. The inbox's button was a TOGGLE and nothing else on the row
 * ever cleared `inboxOn`, so with the inbox open, pressing Board or any of the
 * five scopes updated the state underneath and left the screen exactly as it
 * was — a dead row, silently. Reported as the question that finds it: "I don't
 * see the point of putting a toggle there for that".
 *
 * Read from the source, because the alternative is mounting a panel that wants
 * a repository, a websocket and GitHub. What is checked is the property the bug
 * broke — every control that chooses a view says which one — and not any
 * particular spelling of it: a lock that fails when a line is reformatted is one
 * somebody deletes.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/**
 * The body of a named function, by COUNTING BRACES.
 *
 * `indexOf("\n}")` from the declaration lands on the close of the PARAMETER
 * type here, not of the function — this file's own props are an inline object
 * type — so the slice ended before a single line of markup and every assertion
 * about the markup passed over nothing. Already paid for once in this
 * repository; not again.
 */
function bodyOf(name: string): string {
  const from = src.indexOf(`function ${name}(`);
  if (from < 0) return "";
  const open = src.indexOf("{", src.indexOf(")", from));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
  }
  return "";
}
const pill = bodyOf("Pill");

/** The body of every `onClick` in the file, as strings. */
const clicks = [...src.matchAll(/onClick=\{(\([^)]*\)\s*=>\s*\{[\s\S]{0,400}?\}|\([^)]*\)\s*=>[^\n}]+)\}/g)]
  .map((m) => m[1]);

/** The click handlers that choose which of the three surfaces is shown. */
const viewPickers = clicks.filter((c) => /setBoard\(|setInboxOn\(/.test(c));

describe("the view row", () => {
  test("the scan found the handlers it is about", () => {
    // The guard on the guard: a regex that stopped matching would leave every
    // assertion below green over an empty list.
    expect(viewPickers.length, "handlers that pick a surface").toBeGreaterThanOrEqual(3);
    // And the board's own "show me the table instead", which is not an onClick.
    expect(src).toContain("onShowTable={() => { setInboxOn(false)");
  });

  test("every control that picks a view says what happens to the inbox", () => {
    /*
     * This is the whole bug. `setBoard(true)` without `setInboxOn(false)` is a
     * press that changes state and not the screen.
     */
    const silent = viewPickers.filter((c) => /setBoard\(/.test(c) && !/setInboxOn\(/.test(c));
    expect(silent, "these change the view underneath an open inbox and draw nothing").toEqual([]);
  });

  test("and the inbox is chosen, not flipped", () => {
    // A toggle among six radio buttons is the thing that read as arbitrary.
    const flips = clicks.filter((c) => /setInboxOn\(\s*\(?\w*\)?\s*=>/.test(c));
    expect(flips, "setInboxOn should be given a value, not a flip").toEqual([]);
    expect(src).toContain("setInboxOn(true)");
    expect(src).toContain("setInboxOn(false)");
  });

  test("the row is one exclusive group, and says so to a screen reader", () => {
    // `aria-selected` rather than `aria-pressed`: these are one choice among
    // several, which is a tab, not seven independent switches.
    expect(pill, "the Pill's body").not.toBe("");
    expect(pill).toContain('role="tab"');
    expect(pill).toContain("aria-selected={on}");
  });

  test("only the selected one is outlined", () => {
    /* Seven outlines competing is why nothing stood out — a border on every
       option is a border on none. The unselected border is `transparent`. */
    const border = pill.match(/border: `1px solid \$\{on \? ([^:]+) : ([^}]+)\}`/);
    expect(border, "the Pill sets its border from `on`").not.toBeNull();
    expect(border![2]).toContain("transparent");
  });

  test("and the selected one is a tint, not an inversion", () => {
    /* Filled `--primary` with `--bg` text is the loudest paint in the app, and
       this row is read at a glance many times an hour. The git panel's own
       segmented control settled this. */
    expect(pill).not.toContain('color: on ? "var(--bg)"');
    expect(pill).toContain("color-mix(in srgb, var(--primary) 18%, transparent)");
  });
});

describe("the labels are drawn, not typed", () => {
  test("no typographic glyph stands in for an icon on the view row", () => {
    /* `◫` and `⌸` at `fontSize: 10` paint about six pixels of mark — a glyph
       fills roughly 60% of the size it is set at — and `⌸` is an APL character
       most fonts do not carry at all, so it fell back to whatever was nearest.
       Same fix as the board's card header and its lane headings. */
    /* Outside comments: the note explaining the fix has to be able to name
       what it replaced. */
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const glyph of ["\u25EB", "\u2338"]) {
      expect(code, `still drawing ${glyph}`).not.toContain(glyph);
    }
  });
});
