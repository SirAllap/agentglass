/* Which chips a board card's header carries. Invented cards. */
import { describe, expect, test } from "bun:test";
import { headChips, isEpicPage } from "../src/components/jira/list/boardModel.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (key: string, issueType: string, parent?: ProviderTask["parent"], epic?: ProviderTask["epic"]): ProviderTask =>
  ({ id: key, customId: key, title: key, status: "To Do", assignees: [], tags: [], issueType, ...(parent ? { parent } : {}), ...(epic ? { epic } : {}) }) as unknown as ProviderTask;
const EPIC = { key: "ORBIT-122", title: "Orbit RBAC" };
const STORY = { key: "ORBIT-123", title: "Reporting & exports" };
const sub = card("ORBIT-131", "Sub-task", STORY, EPIC);

describe("headChips", () => {
  test("epic page: a sub-task shows the parent only", () => expect(headChips(sub, true)).toEqual({ parent: true, epic: false }));
  test("other board: parent and epic", () => expect(headChips(sub, false)).toEqual({ parent: true, epic: true }));
  test("no parent: the epic", () => expect(headChips(card("ORBIT-123", "Story", EPIC), false)).toEqual({ parent: false, epic: true }));
});
describe("isEpicPage", () => {
  test("lanes by epic", () => expect(isEpicPage([sub], "epic")).toBe(true));
  test("every card in one epic", () => expect(isEpicPage([sub, card("ORBIT-123", "Story", EPIC)], "none")).toBe(true));
  test("mixed epics", () => expect(isEpicPage([sub, card("ORBIT-9", "Story", { key: "ORBIT-5", title: "Other" })], "none")).toBe(false));
});
