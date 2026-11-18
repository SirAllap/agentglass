/*
 * The board's Refresh reads the search past the 30 s kept copy, and a card write drops every kept search: a card that left
 * "assignee = currentUser()" must not come back from memory. Fake run only, no site.
 */
import { afterEach, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";

const Q = await import("../src/jiraJql.ts");

const card = (id: string) => ({ id, customId: id, title: id, status: "To do", statusKind: "open", assignees: [], tags: [], priority: null, updated: 1 } as unknown as ProviderTask);
const Q1 = "assignee = currentUser() AND project = ORBIT";

/** The site's answer: ORBIT-1042 is on it until `left` is set. */
function fakeSite() {
  const s = { left: false, calls: 0 };
  Q.__setRun(async () => { s.calls++; return { ok: true, data: { tasks: s.left ? [card("ORBIT-7")] : [card("ORBIT-1042"), card("ORBIT-7")], truncated: false } }; });
  return s;
}
const ids = async (o: { fresh?: boolean; now: number }) => ((await Q.runJql(Q1, { ...o, pages: 1 })).data?.tasks ?? []).map((t) => t.id);

afterEach(() => { Q.__setRun(null); });

test("inside 30 s the kept answer stands; fresh asks the site and the card that left is gone", async () => {
  const site = fakeSite();
  expect(await ids({ now: 1_000 })).toEqual(["ORBIT-1042", "ORBIT-7"]);
  site.left = true;
  expect(await ids({ now: 2_000 })).toEqual(["ORBIT-1042", "ORBIT-7"]);
  expect(site.calls).toBe(1);
  expect(await ids({ now: 3_000, fresh: true })).toEqual(["ORBIT-7"]);
  expect(site.calls).toBe(2);
  // The fresh answer is the kept one now.
  expect(await ids({ now: 4_000 })).toEqual(["ORBIT-7"]);
  expect(site.calls).toBe(2);
});

test("a card write drops every kept search", async () => {
  const site = fakeSite();
  await ids({ now: 1_000 });
  site.left = true;
  Q.forgetJqlReads();
  expect(await ids({ now: 1_500 })).toEqual(["ORBIT-7"]);
  expect(site.calls).toBe(2);
});
