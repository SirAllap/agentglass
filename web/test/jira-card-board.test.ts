/* The card's board in a view that is no board's: the Sprint row still lists that board's sprints. Fakes only. */
import { describe, expect, test } from "bun:test";
import type { JiraBoardContext } from "../../shared/providers.ts";
import { resolveCardBoard, type CardBoardReads } from "../src/components/jira/list/menus/cardBoard.ts";

const ctx = (o: Partial<JiraBoardContext>): JiraBoardContext => ({ ok: true, filters: [], epics: [], ...o });
const S = (id: string, name: string) => ({ id, name, start: 0, end: 0 });
const reads = (boards: Record<string, JiraBoardContext>): CardBoardReads & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    projectBoards: async () => ({ ok: true, boards: Object.keys(boards).map((id) => ({ id, name: `Board ${id}` })) }),
    boardContext: async (v) => { asked.push(v); return boards[v.replace("board:", "")]!; },
  };
};
const card = (sprintId?: string) => ({ id: "10", customId: "ORBIT-1042", ...(sprintId ? { sprintId } : {}) });

describe("the card's board, with no board context", () => {
  test("a list view still lists the board's sprints: the kanban board is passed over", async () => {
    const r = reads({ 1: ctx({ boardType: "kanban" }), 6: ctx({ sprint: { id: "2", name: "S2", state: "active", start: 0, end: 0 }, futures: [S("3", "S3"), S("4", "S4"), S("5", "S5")] }) });
    const c = await resolveCardBoard(card("2"), r);
    expect(c?.futures?.map((x) => x.name)).toEqual(["S3", "S4", "S5"]);
    expect(r.asked).toEqual(["board:1", "board:6"]);
  });
  test("two scrum boards: the one holding the card's sprint", async () => {
    const r = reads({ 6: ctx({ futures: [S("3", "S3")] }), 7: ctx({ futures: [S("9", "T9")] }) });
    expect((await resolveCardBoard(card("9"), r))?.futures?.[0]?.name).toBe("T9");
  });
  test("two scrum boards and a backlog card: no guess, so no click lands in another team's sprint", async () => {
    const r = reads({ 6: ctx({ futures: [S("3", "S3")] }), 7: ctx({ futures: [S("9", "T9")] }) });
    expect(await resolveCardBoard(card(), r)).toBeNull();
  });
  test("one scrum board and a backlog card: that board", async () => {
    const r = reads({ 6: ctx({ futures: [S("3", "S3")] }) });
    expect((await resolveCardBoard(card(), r))?.futures?.[0]?.id).toBe("3");
  });
  test("the card's sprint is on no board read: none, never the one other board", async () => {
    const r = reads({ 6: ctx({ futures: [S("3", "S3")] }) });
    expect(await resolveCardBoard(card("9"), r)).toBeNull();
  });
  test("a card left in a closed sprint on a one-board project: that board, so it can go into the next sprint", async () => {
    const r = reads({ 6: ctx({ sprint: { id: "4", name: "S4", state: "active", start: 0, end: 0 }, futures: [S("5", "S5")] }) });
    const c = await resolveCardBoard({ ...card("2"), sprintState: "closed" }, r);
    expect(c?.sprint?.id).toBe("4");
    expect(c?.futures?.map((x) => x.id)).toEqual(["5"]);
  });
  test("a closed-sprint card and two scrum boards: still no guess", async () => {
    const r = reads({ 6: ctx({ futures: [S("3", "S3")] }), 7: ctx({ futures: [S("9", "T9")] }) });
    expect(await resolveCardBoard({ ...card("2"), sprintState: "closed" }, r)).toBeNull();
  });
  test("a board read fails: unsure, so none, even when one board with sprints is left", async () => {
    const r = reads({ 6: ctx({ futures: [S("3", "S3")] }) });
    const failing: CardBoardReads = { projectBoards: async () => ({ ok: true, boards: [{ id: "6", name: "A" }, { id: "7", name: "B" }] }), boardContext: async (v) => { if (v === "board:7") throw new Error("429"); return r.boardContext(v); } };
    expect(await resolveCardBoard(card(), failing)).toBeNull();
    const refused: CardBoardReads = { ...failing, boardContext: async (v) => (v === "board:7" ? ctx({ ok: false }) : r.boardContext(v)) };
    expect(await resolveCardBoard(card(), refused)).toBeNull();
    expect(await resolveCardBoard({ ...card("2"), sprintState: "closed" }, failing)).toBeNull();
  });
  test("no boards, or a refused read: none", async () => {
    expect(await resolveCardBoard(card(), { projectBoards: async () => ({ ok: false }), boardContext: async () => ctx({}) })).toBeNull();
  });
});
