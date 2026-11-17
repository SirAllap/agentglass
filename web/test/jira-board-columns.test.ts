/*
 * The Jira board's rules (jira/list/boardModel.ts) and the two places that must keep to them: the column's CSS and the
 * board's one width variable. A column that changed width when the card panel opened was the defect this guards.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { matchesQuery } from "../src/lib/boardSearch.ts";
import { BOARD_GAP, BOARD_PAD, CARD_W, boardKey, columnsThatFit, hiddenRight, matchesJql, nextColumnLeft, parseJql, railFolds, trackWidth } from "../src/components/jira/list/boardModel.ts";
import { NO_FILTERS, filterCards } from "../src/components/jira/list/model.ts";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/jira/list/JiraBoard.tsx", import.meta.url)).text();
const rule = (sel: string): string => { const at = css.indexOf(`${sel} {`); return at < 0 ? "" : css.slice(at, css.indexOf("}", at)); };

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORBIT-${id}`, title: `Card ${id}`, status: "To do", statusKind: "open", assignees: [], tags: [], priority: null, ...o } as ProviderTask);

describe("one column width in every state", () => {
  test("280 comfortable, 232 compact", () => {
    expect(CARD_W).toEqual({ comfortable: 280, compact: 232 });
  });

  test("the column's CSS fixes its width to the variable, with no grow and no shrink", () => {
    const col = rule(".agx-jb-col");
    expect(col).toContain("flex: 0 0 var(--jb-w)");
    expect(col).toContain("min-width: var(--jb-w)");
    expect(col).toContain("max-width: var(--jb-w)");
  });

  test("the variable comes from the density alone, never from the room or the panel", () => {
    const sets = board.split('"--jb-w" as string]: ').slice(1).map((rest) => rest.slice(0, rest.indexOf(" }")));
    expect(sets).toEqual(["`${CARD_W[density]}px`"]);
  });

  // The board's room with the card panel closed, open (470) and at its widest (70%), at three screen widths.
  for (const screen of [1280, 1600, 2576]) {
    for (const panel of [0, 470, Math.round(screen * 0.7)]) {
      test(`${screen}px, panel ${panel}: whole columns only, the rest scrolls`, () => {
        const room = screen - 280 - panel;
        for (const d of ["comfortable", "compact"] as const) {
          const n = columnsThatFit(room, d);
          expect(trackWidth(n, d) + BOARD_PAD / 2).toBeLessThanOrEqual(Math.max(room, 0));
          expect(trackWidth(n + 1, d) + BOARD_PAD / 2).toBeGreaterThan(room);
          expect(hiddenRight({ scrollLeft: 0, clientWidth: room, columns: 6, density: d })).toBe(Math.max(0, 6 - n));
        }
      });
    }
  }

  test("the pill scrolls so the first hidden column starts at the edge", () => {
    const o = { scrollLeft: 0, clientWidth: 700, columns: 5, density: "comfortable" as const };
    expect(hiddenRight(o)).toBe(3);
    expect(nextColumnLeft(o)).toBe(2 * (280 + BOARD_GAP));
    expect(hiddenRight({ ...o, scrollLeft: 10_000 })).toBe(0);
  });
});

describe("keys", () => {
  test("b, d and [ do their one thing", () => {
    expect(boardKey({ key: "b" }, false)).toBe("mode");
    expect(boardKey({ key: "d" }, false)).toBe("density");
    expect(boardKey({ key: "[" }, false)).toBe("rail");
    expect(boardKey({ key: "x" }, false)).toBeNull();
  });

  test("nothing while typing or with a modifier", () => {
    expect(boardKey({ key: "b" }, true)).toBeNull();
    expect(boardKey({ key: "b", ctrlKey: true }, false)).toBeNull();
    expect(boardKey({ key: "d", metaKey: true }, false)).toBeNull();
    expect(boardKey({ key: "[", altKey: true }, false)).toBeNull();
  });
});

describe("the sidebar folds to its rail only under two columns", () => {
  const need = trackWidth(2, "comfortable") + BOARD_PAD;
  test("docked with room for two: stays", () => {
    expect(railFolds({ boardWidth: need, sidebarWidth: 280, railFolded: false, density: "comfortable", pinned: false })).toBe(false);
  });
  test("docked with room for one: folds", () => {
    expect(railFolds({ boardWidth: need - 1, sidebarWidth: 280, railFolded: false, density: "comfortable", pinned: false })).toBe(true);
  });
  test("once folded the room it freed does not unfold it (no flicker)", () => {
    // Folding gave the board 280 - 34 more: the rule still asks about the docked width.
    expect(railFolds({ boardWidth: need - 1 + 246, sidebarWidth: 280, railFolded: true, density: "comfortable", pinned: false })).toBe(true);
    expect(railFolds({ boardWidth: need + 246, sidebarWidth: 280, railFolded: true, density: "comfortable", pinned: false })).toBe(false);
  });
  test("compact needs less room", () => {
    expect(railFolds({ boardWidth: need - 1, sidebarWidth: 280, railFolded: false, density: "compact", pinned: false })).toBe(false);
  });
  test("pinned never folds", () => {
    expect(railFolds({ boardWidth: 100, sidebarWidth: 280, railFolded: false, density: "comfortable", pinned: true })).toBe(false);
  });
});

describe("the search box", () => {
  const cards = [
    card("1042", { title: "Session tokens are not rotated", status: "In progress", parent: { key: "ORBIT-250", title: "Auth hardening" }, tags: ["security"], assignees: ["Mira R."] }),
    card("1050", { title: "Invoice totals drift", status: "Blocked", parent: { key: "ORBIT-300", title: "Billing sync" } }),
    card("1061", { title: "Skip the workspace name step", status: "Ready" }),
  ];
  const q = (query: string) => filterCards(cards, { ...NO_FILTERS, query }).map((t) => t.id);

  test("a key, a bare number, a title word and an epic name", () => {
    expect(q("ORBIT-1042")).toEqual(["1042"]);
    expect(q("1050")).toEqual(["1050"]);
    expect(q("workspace")).toEqual(["1061"]);
    expect(q("auth hardening")).toEqual(["1042"]);
    expect(matchesQuery(cards[1]!, "orbit-300")).toBe(true);
  });

  test("JQL narrows by its clauses", () => {
    expect(q('status = "In progress"')).toEqual(["1042"]);
    expect(q("status in (Blocked, Ready)")).toEqual(["1050", "1061"]);
    expect(q("labels = security AND assignee = \"Mira R.\"")).toEqual(["1042"]);
    expect(q("epic = ORBIT-300")).toEqual(["1050"]);
    expect(q("summary ~ invoice")).toEqual(["1050"]);
    expect(q("status != Blocked ORDER BY rank")).toEqual(["1042", "1061"]);
  });

  test("text that is not JQL stays a word search", () => {
    expect(parseJql("tokens rotated")).toBeNull();
    expect(parseJql("nosuchfield = 3")).toBeNull();
    expect(matchesJql(cards[0]!, parseJql("key = orbit-1042")!)).toBe(true);
  });
});
