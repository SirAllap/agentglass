/*
 * A card folded in from the detail panel must not hide a newer board read: ORBIT-1042 gains epic ORBIT-1446 on the site,
 * the board refresh brings it, and the board shows it (useJiraList `land` drops folded copies the read replaced).
 */
import { expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { overAfterRead, pageCards } from "../src/components/jira/list/model.ts";

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: id, title: `Card ${id}`, status: "To do", statusKind: "open", assignees: [], tags: [], priority: null, ...o } as ProviderTask);

test("board refresh shows the epic a folded old copy lacked", () => {
  const folded = { "ORBIT-1042": card("ORBIT-1042") };
  const read = [card("ORBIT-1042", { parent: { key: "ORBIT-1446", title: "Consolidate", type: "Epic" } })];
  const args = { areaId: null, areaTasks: undefined, sprintName: undefined };
  // before the fix the folded copy won
  expect(pageCards({ ...args, tasks: read, over: folded })[0]!.parent).toBeUndefined();
  const over = overAfterRead(folded, read);
  expect(pageCards({ ...args, tasks: read, over })[0]!.parent?.key).toBe("ORBIT-1446");
});

test("a folded card the read did not bring stays", () => {
  const over = overAfterRead({ "ORBIT-7": card("ORBIT-7") }, [card("ORBIT-1042")]);
  expect(Object.keys(over)).toEqual(["ORBIT-7"]);
});

test("a card whose rank still waits on the site keeps its folded copy", () => {
  const moved = card("ORBIT-1042", { order: "0|b" });
  const over = overAfterRead({ "ORBIT-1042": moved }, [card("ORBIT-1042", { order: "0|a" })], new Set(["ORBIT-1042"]));
  expect(over["ORBIT-1042"]).toBe(moved);
});
