import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { cardActions } from "../src/components/jira/list/menus/cardActions.ts";
import { currentSprintOf, sprintMoveAsk } from "../src/components/jira/list/viewsModel.ts";

const card = (key: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id: key, key, title: `Card ${key}`, status: "In progress", statusKind: "progress", tags: [], assignees: [], ...o }) as unknown as ProviderTask;

/* A space view has no board, so its context carries no sprint; its cards still carry the one running now. */
const s2 = { sprint: "ORBIT S2 11/04-11/17", sprintActive: true, sprintId: "42" };
const cards = [card("ORBIT-1", s2), card("ORBIT-2", s2), card("ORBIT-3", { sprint: "ORBIT S1", sprintId: "41" }), card("ORBIT-4")];

describe("the current sprint of a view that has no board", () => {
  test("the board's own sprint wins", () => {
    expect(currentSprintOf({ id: "7", name: "Board sprint" }, cards)).toEqual({ id: "7", name: "Board sprint" });
  });
  test("else the active sprint the cards carry, closed ones ignored", () => {
    expect(currentSprintOf(undefined, cards)).toEqual({ id: "42", name: "ORBIT S2 11/04-11/17" });
    expect(currentSprintOf(null, [card("ORBIT-3", { sprint: "ORBIT S1", sprintId: "41" }), card("ORBIT-4")])).toBeNull();
  });
  test("a card in its own active sprint answers with it when the view runs two", () => {
    const two = [...cards, card("ACME-1", { sprint: "ACME 9", sprintActive: true, sprintId: "90" })];
    expect(currentSprintOf(undefined, two, two[4])).toEqual({ id: "90", name: "ACME 9" });
    expect(currentSprintOf(undefined, two, two[3])?.id).toBe("42");
  });
  test("a card with no sprint id (an older read) offers none", () => {
    expect(currentSprintOf(undefined, [card("ORBIT-1", { sprint: "S", sprintActive: true })])).toBeNull();
  });
  test("the menu offers the move on a space view, and the move names the id", () => {
    const sprint = currentSprintOf(undefined, cards, cards[0]);
    const facts = { pr: null, pinned: false, writable: true, moves: "reading" as const, agent: false, people: [], sprint, inSprint: true };
    const groups = cardActions(cards[0]!, facts as never).groups;
    const sub = groups.flatMap((g) => g.items).find((i) => i.id === "sprintTo")!;
    expect(sub.why).toBeUndefined();
    expect(sub.children?.[0]?.label).toBe("Current ORBIT S2 11/04-11/17");
    expect(sprintMoveAsk(sprint, ["ORBIT-4"])).toMatchObject({ ok: true, id: "42", keys: ["ORBIT-4"] });
  });
  test("a cross-space view never hands a card another space's sprint", () => {
    const mixed = [card("ACME-1", { sprint: "ACME S9", sprintActive: true, sprintId: "90" }), card("ACME-2", { sprint: "ACME S9", sprintActive: true, sprintId: "90" }), card("ORBIT-1", s2), card("ORBIT-9")];
    expect(currentSprintOf(null, mixed, card("ORBIT-9"))).toEqual({ id: "42", name: s2.sprint });
    expect(currentSprintOf(null, mixed, card("BETA-1"))).toBeNull();
    expect(currentSprintOf(null, mixed)).toBeNull();
  });
});
