/*
 * The terminal's top bar, and what is NOT in it.
 *
 * Written the day it was emptied, because everything removed here is the kind
 * of thing that comes back one convenient press at a time: a control is easy to
 * add to a bar and nobody ever notices the bar filling up again. His words on
 * the old one — "too many things in one place, and you no longer even know
 * what they are for" — and the count: five controls on screen at all times, every one
 * with another way in.
 *
 * A source-level lock rather than a render, on purpose: the panel mounts xterm,
 * a websocket and a tmux client, and none of that can be stood up in a test
 * runner. What it checks is exactly what it claims to — that the markup for
 * those controls is gone.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url).pathname, "utf8");

describe("what the bar no longer carries", () => {
  test("no Find button — the chord opens it and it floats", () => {
    // And it wears the app's own find: same corner, same count, same arrows,
    // same close. Two boxes that look different for one chord is two features
    // to learn.
    expect(src).toContain("<FindArrow");
    expect(src).toContain("agx-menu");
    expect(src).not.toContain("⌕ Find");
    // Still reachable: Ctrl+Shift+F goes through panelFind, and the panel
    // mounts the floating card when it is open.
    expect(src).toContain("panelFind = () => { setFindOpen(true); return true; }");
    expect(src).toContain("{findOpen && (");
  });

  test("no Clear and no Reconnect as standing buttons", () => {
    // Clear is Ctrl+L in every shell ever made; Reconnect under tmux
    // re-attached a client that re-attaches itself.
    expect(src).not.toContain(">Clear</button>");
    expect(src).not.toContain("⟲ {tmuxActive ? \"Reconnect\" : \"Restart\"}");
  });

  test("no worktree menu — the chip already answers for the pane you are in", () => {
    expect(src).not.toContain("↗ Worktree ▾");
    // And its state went with it, rather than being left behind unused.
    expect(src).not.toContain("setWtShowAll");
    expect(src).not.toContain("const [wtOpen");
  });

  test("no shell-status pill in the quiet case", () => {
    // "bash · pty" is a fact nobody reads until it is wrong, so it is drawn
    // only when it IS wrong — and then as the button that fixes it.
    expect(src).not.toContain("statusDot[status].label");
    expect(src).toContain("status === \"unauthorized\" ? \"Token needed\" : \"Reconnect\"");
  });
});

describe("the row itself is gone, and where its survivors went", () => {
  /*
   * "This row has to go, only Commands and Sessions stay." The row
   * carried the worktree chip — branch, Diff, PR, card — and every one of those
   * is a door on the pane's own block now, drawn on the pane it describes. With
   * four panes open the row named exactly one of them, which is what made it a
   * duplicate rather than a summary. Deleting it gives the workspace a row of
   * height back, and that was the point.
   */
  test("no row above the tabs at all", () => {
    expect(src).not.toContain("viewHeaderClass");
    // The chip and its doors went with it, rather than being left rendered
    // somewhere quieter.
    expect(src).not.toContain("<WtCardChip");
    expect(src).not.toContain(">Diff</button>");
    expect(src).not.toContain("PR #{chipPr.pr.number}");
  });

  test("Commands and Sessions survive, in that order, in one group", () => {
    // Still the quiet Commands: the console keeps the full control.
    expect(src).toContain("onClose={focusTerm} quiet />");
    const group = src.slice(src.indexOf("const barRight = ("), src.indexOf("const tabsRowShown"));
    expect(group.indexOf("<CommandBar")).toBeGreaterThan(-1);
    expect(group.indexOf("<ResumeSessions")).toBeGreaterThan(group.indexOf("<CommandBar"));
    // And exactly one of each in the terminal's own chrome — the group is
    // rendered from three places, so a second copy would be two live menus
    // rather than a fallback. (The docked Docker console keeps its own
    // CommandBar: a different shell, and the full control rather than this
    // quiet one.)
    expect(src.split("<ResumeSessions").length - 1).toBe(1);
    expect(src.split("onClose={focusTerm} quiet />").length - 1).toBe(1);
  });

  test("the group rides the tabs row, outside its scroller", () => {
    // A right-hand group INSIDE `overflow-x-auto` scrolls away as soon as there
    // are more tabs than fit — which is exactly when somebody reaches for it.
    for (const row of src.split("{barRight}").slice(0, -1)) {
      const open = row.lastIndexOf("<div");
      expect(row.slice(open)).not.toContain("overflow-x-auto");
    }
    expect(src.split("{barRight}").length - 1).toBe(3);
  });

  test("and it has a row of its own when neither window list is drawn", () => {
    // tmux drawing its own bar, or a repo with no shell yet: without this,
    // Commands and Sessions are unreachable rather than merely tucked away.
    expect(src).toContain("const tabsRowShown =");
    expect(src).toContain("{!tabsRowShown && (");
  });

  test("the one notice the row carried still interrupts", () => {
    // A command that was NOT typed because a full-screen program had the
    // keyboard. It takes a row only while that is true.
    expect(src).toContain("<BlockedNotice cmd={blocked}");
    expect(src).toContain("{blocked && (");
  });
});

/*
 * One search, one set of colours.
 *
 * The board's find and the terminal's find are different machinery — a
 * `::highlight()` over a document against a decoration layer over a canvas —
 * and they were different colours because of it. They read as two features.
 */
describe("the find highlight", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url).pathname, "utf8");

  test("both finds take their colours from the same two variables", () => {
    expect(css).toContain("--find-hit: #ffd23f");
    expect(css).toContain("--find-on: #ff2bd1");
    expect(css).toContain("background: var(--find-hit)");
    expect(css).toContain("background: var(--find-on)");
    // And the terminal reads them rather than picking its own.
    expect(src).toContain('readVar(rootStyle(), "--find-hit"');
    expect(src).toContain('readVar(rootStyle(), "--find-on"');
  });

  test("the terminal no longer finds in the theme's warning colour", () => {
    const find = src.slice(src.indexOf("const opts = {"), src.indexOf("const step = (back"));
    expect(find).not.toContain("--warning");
    expect(find).not.toContain("--primary");
  });
});
