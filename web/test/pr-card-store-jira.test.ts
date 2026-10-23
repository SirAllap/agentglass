/*
 * A Jira key is asked of Jira. The store used to ask ClickUp for every card, so
 * a Jira-owned `ORBIT-7` was a request that could only come back "not found",
 * once per row on a board with both trackers connected.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const calls: string[] = [];
const mod = await import("../src/lib/api.ts");
const a = mod.api as unknown as Record<string, unknown>;
const saved = { clickupFind: a.clickupFind, jiraFind: a.jiraFind };
a.clickupFind = (q: string) => { calls.push(`clickup:${q}`); return Promise.resolve({ ok: false, error: "no" }); };
a.jiraFind = (q: string) => { calls.push(`jira:${q}`); return Promise.resolve({ ok: true, task: { id: "10007", customId: q, title: "Retry the export", status: "In Review" } }); };

const { cardOf, forgetCards, withCard } = await import("../src/lib/prCardStore.ts");
const settle = () => new Promise((r) => setTimeout(r, 30));

import { afterAll } from "bun:test";
afterAll(() => { a.clickupFind = saved.clickupFind; a.jiraFind = saved.jiraFind; forgetCards(); });

describe("which tracker answers for a card", () => {
  beforeEach(() => { calls.length = 0; forgetCards(); });

  it("asks Jira, and only Jira, for a Jira-owned key", async () => {
    cardOf("ORBIT-7", undefined, "jira");
    await settle();
    expect(calls).toEqual(["jira:ORBIT-7"]);
    expect(cardOf("ORBIT-7", undefined, "jira")?.task).toMatchObject({ status: "In Review" });
  });

  it("still asks ClickUp when nothing says otherwise", async () => {
    cardOf("ORBIT-1042");
    await settle();
    expect(calls).toEqual(["clickup:ORBIT-1042"]);
  });

  it("does not ask ClickUp about a row whose card the server already named as Jira's", async () => {
    const row = { headRefName: "fix/ORBIT-1042-x", title: "x", card: { id: "1", title: "t", status: "Open", priority: null, tracker: "jira" as const, at: 1 } };
    expect(withCard(row as never, true)).toBe(row as never);
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("a ClickUp miss is not Jira's answer", () => {
  beforeEach(() => { calls.length = 0; forgetCards(); });

  it("asks Jira when the list already stored a ClickUp miss for the same key", async () => {
    cardOf("ORBIT-7"); // what the PR list does for a row the server did not name as Jira's
    await settle();
    expect(calls).toEqual(["clickup:ORBIT-7"]);
    expect(cardOf("ORBIT-7", undefined, "jira")?.task ?? null).toBeNull();
    await settle();
    expect(calls).toEqual(["clickup:ORBIT-7", "jira:ORBIT-7"]);
    expect(cardOf("ORBIT-7", undefined, "jira")?.task).toMatchObject({ status: "In Review" });
  });

  it("asks Jira when a ClickUp request for the key is still in flight", async () => {
    cardOf("ORBIT-9");
    expect(cardOf("ORBIT-9", undefined, "jira")?.task ?? null).toBeNull();
    await settle();
    cardOf("ORBIT-9", undefined, "jira");
    await settle();
    expect(calls).toContain("jira:ORBIT-9");
    expect(cardOf("ORBIT-9", undefined, "jira")?.task).toMatchObject({ status: "In Review" });
  });
});
