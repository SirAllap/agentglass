/**
 * A card on the board and the same card in the detail are one datum.
 *
 * Removing an assignee in the pull request's detail left the board card drawing
 * both faces until Refresh. The detail reads the store; the board reads the
 * row the server sent, overlaid by the store only when the store's reading is
 * newer. These pin that overlay, as a projection rather than a renderer.
 */
import { test, expect, beforeEach } from "bun:test";
import { withCard, putCard, forgetCard, forgetCards, cardOf, peekCard } from "../src/lib/prCardStore.ts";
import type { PrSummary } from "../../shared/types.ts";
import type { ProviderTask } from "../../shared/providers.ts";

beforeEach(() => forgetCards());

const ada = { id: 1, name: "Ada Lovelace", initials: "AL" };
const grace = { id: 2, name: "Grace Hopper", initials: "GH" };

const row = (card: Record<string, unknown>): PrSummary => ({
  number: 7, title: "PR 7", author: "someone", state: "open",
  headRefName: "ORBIT-8810-something",
  card: { id: "c1", customId: "ORBIT-8810", title: "a card", status: "code review", priority: null, ...card },
} as unknown as PrSummary);

const task = (people: unknown[], updated: number): ProviderTask => ({
  id: "86abc12", customId: "ORBIT-8810", title: "a card", status: "code review", priority: null, people, updated,
} as unknown as ProviderTask);

/* The detail has the pull request's body, so a card address in it makes the
   reference the task's own id; the list row has no body and reads the id out of
   the branch. Same card, two keys. */
const DETAIL_KEY = "86abc12";
const ROW_KEY = "ORBIT-8810";

test("removing an assignee in the detail shows on the board card at once", () => {
  const p = row({ people: [ada, grace], at: Date.now() - 60_000 });
  putCard(DETAIL_KEY, task([ada], Date.now()));
  expect(withCard(p, true).card?.people?.map((x) => x.name)).toEqual(["Ada Lovelace"]);
});

test("a status moved in the detail shows on the board card too", () => {
  const p = row({ status: "in development", people: [ada], at: Date.now() - 60_000 });
  putCard(DETAIL_KEY, { ...task([ada], Date.now()), status: "code review" });
  expect(withCard(p, true).card?.status).toBe("code review");
});

test("a read made for the board row is the one the detail shows", async () => {
  const api = (await import("../src/lib/api.ts")).api as unknown as Record<string, unknown>;
  const before = api.clickupFind;
  api.clickupFind = async (q: string) => (q === ROW_KEY
    ? { ok: true, task: task([ada], 2_000) }
    : (before as (q: string) => Promise<unknown>)(q));
  try {
    putCard(DETAIL_KEY, task([ada, grace], 1_000));
    forgetCard(ROW_KEY);
    cardOf(ROW_KEY);
    for (let i = 0; i < 50 && peekCard(DETAIL_KEY)?.task?.people?.length !== 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(peekCard(DETAIL_KEY)?.task?.people?.map((x) => x.name)).toEqual(["Ada Lovelace"]);
  } finally {
    api.clickupFind = before;
  }
});

test("forgetting a card under one name forgets it under the other", () => {
  putCard(DETAIL_KEY, task([ada], Date.now()));
  forgetCard(ROW_KEY);
  expect(peekCard(DETAIL_KEY)).toBeNull();
});

test("the Tasks view feeds what its writes answer with into the same store", async () => {
  const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
  expect(src).toMatch(/onTask: \(task\) => \{ putCard\(task\.id, task\);/);
});
