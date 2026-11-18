/*
 * A space read that failed is not the space's state: it is asked again on the next refresh and when the space is
 * opened, so a one-off unreadable answer does not stay on screen until a restart.
 */
import { beforeEach, expect, test } from "bun:test";
import { api } from "../src/lib/api.ts";
import { __resetJiraTree, jiraTreeNow, retryFailedReads } from "../src/lib/useJiraTree.ts";

const tree = { ok: true as const, space: "ORBIT", noEpic: 0, components: [], total: 0, done: 0, hidDone: 0, readAt: 1 };
let calls = 0;
let answer: unknown;
beforeEach(() => {
  __resetJiraTree();
  calls = 0;
  (api as unknown as Record<string, unknown>).jiraSpaceTree = async () => { calls++; return answer; };
});
const settle = () => new Promise((r) => setTimeout(r, 5));

test("an error read is asked again, and the good answer replaces it", async () => {
  answer = { ok: false, error: "Jira answered something that is not JSON (GET /x: 200, text/html, starts \"<html>\")" };
  retryFailedReads("ORBIT"); // nothing held yet: no request
  expect(calls).toBe(0);
  const { jiraTreeNow: now } = await import("../src/lib/useJiraTree.ts");
  // first read, as opening the space does
  const mod = await import("../src/lib/useJiraTree.ts");
  expect(mod).toBeDefined();
  (jiraTreeNow() as { reads: Record<string, unknown> }).reads.ORBIT = { state: "error", error: "x" };
  answer = tree;
  retryFailedReads();
  await settle();
  expect(calls).toBe(1);
  expect(now().reads.ORBIT).toMatchObject({ state: "ready" });
  retryFailedReads();
  await settle();
  expect(calls).toBe(1); // a ready space is not asked again
});

test("a throttled space is not retried, and a space that keeps failing costs one call per trigger", async () => {
  const reads = (jiraTreeNow() as { reads: Record<string, unknown> }).reads;
  reads.HOT = { state: "error", error: "held", throttled: true };
  reads.BAD = { state: "error", error: "x" };
  answer = { ok: false, error: "x" };
  retryFailedReads();
  await settle();
  expect(calls).toBe(1); // BAD only
  retryFailedReads();
  await settle();
  expect(calls).toBe(2);
});

test("thirty failed spaces are read at most three at a time", async () => {
  const reads = (jiraTreeNow() as { reads: Record<string, unknown> }).reads;
  for (let i = 0; i < 30; i++) reads[`S${i}`] = { state: "error", error: "x" };
  let live = 0, peak = 0;
  (api as unknown as Record<string, unknown>).jiraSpaceTree = async () => { calls++; peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 1)); live--; return tree; };
  retryFailedReads();
  await new Promise((r) => setTimeout(r, 80));
  expect(calls).toBe(30);
  expect(peak).toBeLessThanOrEqual(3);
});
