/*
 * The Jira board's four lanes, as a rule rather than a screen.
 *
 * The failure this file exists to prevent is a card going missing: a workflow
 * with seven statuses folds into four, and a fold that drops the odd one out is
 * a card somebody cannot see from the phone — the worst kind, because the board
 * still looks like a board. So every case here counts the cards back.
 *
 * Fixtures are hand-built `ProviderTask` and `ListStatus` shapes with invented
 * names, never the server's own fold output.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import { JIRA_LANES, jiraLaneOf, jiraLanes } from "../../shared/jiraLanes.ts";
import { boardCards, emptyLaneWords, isSubtask, jiraBoard } from "../src/model/jiraBoard.ts";
import {
  activeJiraChips, activeJiraFilters, facetsOf, NO_JIRA_FILTERS, personOn, removeJiraFilter, type JiraFilters,
} from "../src/model/jiraFilters.ts";

const status = (name: string, type: ListStatus["type"], i: number, color?: string): ListStatus =>
  ({ status: name, type, orderindex: i, ...(color ? { color } : null) });

const card = (o: Partial<ProviderTask> & { id: string }): ProviderTask => ({
  title: `Card ${o.id}`, url: "", status: "To do", statusKind: "open", priority: null, due: null,
  updated: 1, tags: [], list: "ORBIT", listId: "ORBIT", assignees: [], ...o,
});

/** A site with more statuses than the phone draws, which is the normal case. */
const seven: ListStatus[] = [
  status("Backlog", "open", 1),
  status("To do", "open", 2),
  status("Doing", "custom", 3, "#d29922"),
  status("Blocked", "custom", 4),
  status("Code review", "custom", 5, "#8b5cf6"),
  status("Ready to ship", "custom", 6),
  status("Done", "done", 7, "#3fb950"),
];

const cards: ProviderTask[] = [
  card({ id: "10", customId: "ORBIT-1010", status: "Backlog" }),
  card({ id: "11", customId: "ORBIT-1011", status: "To do" }),
  card({ id: "12", customId: "ORBIT-1012", status: "Doing", statusKind: "other", mine: true }),
  card({ id: "13", customId: "ORBIT-1013", status: "Blocked", statusKind: "other" }),
  card({ id: "14", customId: "ORBIT-1014", status: "Code review", statusKind: "other" }),
  card({ id: "15", customId: "ORBIT-1015", status: "Ready to ship", statusKind: "other" }),
  card({ id: "16", customId: "ORBIT-1016", status: "Done", statusKind: "done" }),
  card({ id: "17", customId: "ORBIT-1017", status: "Gone", statusKind: "done" }),
  card({ id: "18", customId: "ORBIT-1018", status: "Not on the view", statusKind: "open" }),
];

const ids = (lanes: ReturnType<typeof jiraLanes>): string[] =>
  lanes.flatMap((l) => l.cards.map((c) => c.customId ?? c.id)).sort();

const lane = (lanes: ReturnType<typeof jiraLanes>, id: string) => lanes.find((l) => l.id === id)!;

describe("the fold", () => {
  test("seven statuses become four lanes, and every card is still on one", () => {
    const lanes = jiraLanes(seven, cards);
    expect(lanes.map((l) => l.id)).toEqual(JIRA_LANES.map((l) => l.id));
    expect(lanes.reduce((n, l) => n + l.cards.length, 0)).toBe(cards.length);
    expect(ids(lanes)).toEqual(cards.map((c) => c.customId ?? c.id).sort());
  });

  test("the lane's own statuses are the view's, in the view's order", () => {
    const lanes = jiraLanes(seven, []);
    expect(lane(lanes, "todo").statuses).toEqual(["Backlog", "To do"]);
    expect(lane(lanes, "progress").statuses).toEqual(["Doing", "Blocked", "Ready to ship"]);
    expect(lane(lanes, "review").statuses).toEqual(["Code review"]);
    expect(lane(lanes, "done").statuses).toEqual(["Done"]);
    expect(lane(lanes, "todo").color).toBeUndefined();
    expect(lane(lanes, "progress").color).toBe("#d29922");
    expect(lane(lanes, "review").color).toBe("#8b5cf6");
  });

  test("a site with no review status leaves the column empty, not absent", () => {
    const lanes = jiraLanes([status("To do", "open", 1), status("Doing", "custom", 2), status("Done", "done", 3)], cards.slice(0, 2));
    const review = lane(lanes, "review");
    expect(review).toBeDefined();
    expect(review.cards).toEqual([]);
    expect(review.statuses).toEqual([]);
    expect(emptyLaneWords(NO_JIRA_FILTERS)).toContain("Nothing here");
  });

  test("order follows the view: the status the view lists first is the lane's first", () => {
    const statuses = [status("Coding", "custom", 1), status("Designing", "custom", 2)];
    const rows = [card({ id: "a", status: "Designing", statusKind: "other" }), card({ id: "b", status: "Coding", statusKind: "other" })];
    expect(jiraLanes(statuses, rows).find((l) => l.id === "progress")!.cards.map((c) => c.id)).toEqual(["b", "a"]);
  });

  test("a card whose status the view never listed is filed by its own kind, not dropped", () => {
    const lanes = jiraLanes(seven, [card({ id: "x", status: "Somewhere else", statusKind: "other" }), card({ id: "y", status: "Elsewhere, in Review", statusKind: "other" })]);
    expect(ids(lanes)).toEqual(["x", "y"]);
    expect(lane(lanes, "progress").cards.map((c) => c.id)).toEqual(["x"]);
    expect(lane(lanes, "review").cards.map((c) => c.id)).toEqual(["y"]);
  });

  test("a done status is Done even when its name says review", () => {
    expect(jiraLaneOf("Reviewed", "done")).toBe("done");
    expect(jiraLaneOf("In review", "custom")).toBe("review");
    expect(jiraLaneOf("Review", "open")).toBe("review");
    expect(jiraLaneOf("Doing", "custom")).toBe("progress");
  });

  test("and its cards file under Done, whatever the card's own kind says", () => {
    // The name match is a fallback for a category Jira has no word for; the
    // workflow's own category wins, which is what the desk's groups do too.
    const statuses = [status("To do", "open", 1), status("Reviewed", "done", 2)];
    const rows = [card({ id: "r", status: "Reviewed", statusKind: "other" })];
    const lanes = jiraLanes(statuses, rows);
    expect(lane(lanes, "done").cards.map((c) => c.id)).toEqual(["r"]);
    expect(lane(lanes, "review").cards).toEqual([]);
  });
});

describe("the board on top of the fold", () => {
  test("Mine keeps only your cards, Everyone keeps all, and both file every card they keep", () => {
    const rows = [
      card({ id: "n1", status: "Doing", statusKind: "other" }),
      card({ id: "m1", status: "Doing", statusKind: "other", mine: true }),
      card({ id: "n2", status: "Code review", statusKind: "other" }),
    ];
    const mine = jiraBoard(seven, rows, NO_JIRA_FILTERS, "mine");
    const all = jiraBoard(seven, rows, NO_JIRA_FILTERS, "everyone");
    expect(lane(mine.lanes, "progress").cards.map((c) => c.id)).toEqual(["m1"]);
    expect(mine.shown).toBe(1);
    expect(all.shown).toBe(3);
    expect(all.lanes.flatMap((l) => l.cards).length).toBe(3);
    expect(mine.mine).toBe(1);
    expect(mine.total).toBe(3);
  });

  test("the counts follow the filters, so the strip and the cards are one set", () => {
    const f: JiraFilters = { ...NO_JIRA_FILTERS, statuses: ["Doing", "Code review"] };
    const board = jiraBoard(seven, cards, f, "everyone");
    expect(board.total).toBe(cards.length);
    expect(board.shown).toBe(2);
    expect(board.lanes.reduce((n, l) => n + l.cards.length, 0)).toBe(2);
    for (const l of board.lanes) expect(l.cards.every((c) => f.statuses.includes(c.status))).toBe(true);
  });

  test("text narrows by key, title and label, case aside", () => {
    const rows = [
      card({ id: "1", customId: "ORBIT-1042", title: "Dark mode in Settings", tags: ["phone"] }),
      card({ id: "2", customId: "ORBIT-1044", title: "Source pill remembers", tags: [] }),
    ];
    expect(jiraBoard(seven, rows, { ...NO_JIRA_FILTERS, text: "orbit-1042" }, "everyone").shown).toBe(1);
    expect(jiraBoard(seven, rows, { ...NO_JIRA_FILTERS, text: "dark mode" }, "everyone").shown).toBe(1);
    expect(jiraBoard(seven, rows, { ...NO_JIRA_FILTERS, text: "phone" }, "everyone").shown).toBe(1);
    expect(jiraBoard(seven, rows, { ...NO_JIRA_FILTERS, text: "nothing here" }, "everyone").shown).toBe(0);
  });

  test("a sub-task is a step of its card, not a second card; a Story's epic is not a sub-task", () => {
    const rows = [
      card({ id: "1", issueType: "Story", parent: { key: "ORBIT-1", title: "Epic", type: "Epic" } }),
      card({ id: "2", issueType: "Sub-task", parent: { key: "ORBIT-2", title: "Story", type: "Story" } }),
      card({ id: "3", issueType: "Subtask" }),
    ];
    expect(isSubtask(rows[0]!)).toBe(false);
    expect(boardCards(rows).map((c) => c.id)).toEqual(["1"]);
    expect(jiraBoard(seven, boardCards(rows), NO_JIRA_FILTERS, "everyone").total).toBe(1);
  });

  test("the empty lane says which question emptied it", () => {
    const f: JiraFilters = { ...NO_JIRA_FILTERS, text: "no card says this" };
    expect(emptyLaneWords(f)).toContain("filters");
  });
});

describe("the filter sheet's facets", () => {
  const rows = [
    card({ id: "1", status: "Doing", statusKind: "other", issueType: "Bug", mine: true, people: [{ key: "k1", name: "Ana", initials: "AN", me: true }], assignees: ["Ana"] }),
    card({ id: "2", status: "Doing", statusKind: "other", issueType: "Task", people: [{ key: "k2", name: "Noa", initials: "NO" }], assignees: ["Noa"] }),
    card({ id: "3", status: "Done", statusKind: "done", issueType: "Bug" }),
  ];

  test("each dimension is counted with the other three applied", () => {
    const f: JiraFilters = { ...NO_JIRA_FILTERS, statuses: ["Doing"] };
    const facets = facetsOf(rows, f, ["Doing", "Done"]);
    expect(facets.statuses.map((s) => [s.name, s.count])).toEqual([["Doing", 2], ["Done", 1]]);
    expect(facets.types.map((t) => [t.name, t.count])).toEqual([["Bug", 1], ["Task", 1]]);
    expect(facets.assignees.map((a) => [a.name, a.count])).toEqual([["Ana", 1], ["Noa", 1]]);
  });

  test("the connected account is marked, and unassigned is its own row", () => {
    const facets = facetsOf(rows, NO_JIRA_FILTERS, ["Doing", "Done"]);
    expect(facets.assignees.find((a) => a.name === "Ana")?.me).toBe(true);
    expect(facets.assignees.find((a) => a.name === "")?.count).toBe(1);
    expect(personOn(rows[2]!)).toBeNull();
  });

  test("status facets follow the view's order, then count", () => {
    const facets = facetsOf(rows, NO_JIRA_FILTERS, ["Done", "Doing"]);
    expect(facets.statuses.map((s) => s.name)).toEqual(["Done", "Doing"]);
  });
});

describe("the filters in force, one chip each", () => {
  const all: JiraFilters = {
    text: "lane",
    assignee: { kind: "person", name: "Ana" },
    statuses: ["Doing", "Code review"],
    types: ["Bug"],
  };

  test("every answered question is its own chip, with its own id", () => {
    expect(activeJiraChips(all)).toEqual([
      { id: "text", label: "“lane”" },
      { id: "assignee", label: "Ana" },
      { id: "status:Doing", label: "Doing" },
      { id: "status:Code review", label: "Code review" },
      { id: "type:Bug", label: "Bug" },
    ]);
    expect(activeJiraChips(all)).toHaveLength(activeJiraFilters(all));
  });

  test("removing one leaves the other questions answered", () => {
    const noStatus = removeJiraFilter(all, "status:Doing");
    expect(noStatus.statuses).toEqual(["Code review"]);
    expect(noStatus.text).toBe("lane");
    expect(noStatus.assignee).toEqual({ kind: "person", name: "Ana" });
    expect(noStatus.types).toEqual(["Bug"]);
    expect(activeJiraFilters(noStatus)).toBe(activeJiraFilters(all) - 1);
  });

  test("the last chip cleared is a board with no filters", () => {
    const one: JiraFilters = { ...NO_JIRA_FILTERS, statuses: ["Doing"] };
    expect(removeJiraFilter(one, "status:Doing")).toEqual(NO_JIRA_FILTERS);
    expect(activeJiraChips(NO_JIRA_FILTERS)).toEqual([]);
  });

  test("an unknown id changes nothing", () => {
    expect(removeJiraFilter(all, "nonsense")).toBe(all);
  });

  test("the board draws those chips and each one removes only itself", () => {
    const board = readFileSync(join(import.meta.dir, "..", "src", "jira", "Board.tsx"), "utf8");
    // The chips share the row with "Mine first" (the mock's strip over the
    // board), and each is wired to remove exactly its own answer.
    expect(board).toContain("activeJiraChips(filters).map((chip) => (");
    expect(board).toContain("onPress={() => setFilters(removeJiraFilter(filters, chip.id))}");
    expect(board).toContain('label="Filter"');
    const filters = readFileSync(join(import.meta.dir, "..", "src", "jira", "Filters.tsx"), "utf8");
    expect(filters).toContain("Clear all");
  });
});
