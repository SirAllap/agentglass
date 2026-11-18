/*
 * The Jira card's CI chip never says "not read" before the Pull requests board's own list load has run: an empty store
 * triggers that one load, "loading" shows while it is in flight, "not read" only after it finished without the PR.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetListChecks, ciPlan, listLoadOf, publishListChecks, listChecksFor } from "../src/lib/prListChecks.ts";
import { ensureListLoaded, loadBoardLists } from "../src/lib/prBoardLoad.ts";
import type { PrListResponse } from "../../shared/types.ts";

const roll = { success: 3, failure: 0, pending: 0, total: 3, allDone: true, verdict: "green", failing: [] } as never;
const answer = (n: number): PrListResponse => ({ ok: true, repo: { owner: "orbit", name: "web" }, prs: [{ number: n, checks: roll, checksLoaded: true }], fetchedAt: 1 }) as never;

beforeEach(() => __resetListChecks());

describe("ciPlan", () => {
  test("empty store, nothing asked: trigger once and say loading", () => {
    expect(ciPlan(false, "idle")).toEqual({ show: "loading", trigger: true });
  });
  test("in flight: loading, no second trigger", () => {
    expect(ciPlan(false, "loading")).toEqual({ show: "loading", trigger: false });
  });
  test("done or failed without the PR: not read", () => {
    expect(ciPlan(false, "done")).toEqual({ show: "not-read", trigger: false });
    expect(ciPlan(false, "failed")).toEqual({ show: "not-read", trigger: false });
  });
  test("a reading wins whatever the load says", () => {
    expect(ciPlan(true, "loading")).toEqual({ show: "read", trigger: false });
  });
});

describe("one load call path", () => {
  test("the board and Jira open together: each list is fetched once", async () => {
    const calls: string[] = [];
    const fetcher = async (root: string, filter: "mine" | "review") => { calls.push(`${root}:${filter}`); await Promise.resolve(); return answer(7); };
    const board = loadBoardLists("gh:orbit/web", "open", false, fetcher);
    ensureListLoaded("orbit/web", fetcher);
    ensureListLoaded("orbit/web", fetcher);
    await Promise.all([board.mine, board.review]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.sort()).toEqual(["gh:orbit/web:mine", "gh:orbit/web:review"]);
  });
  test("loading while in flight, done after, and the list answer feeds the chip", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetcher = async () => { await gate; const a = answer(7); publishListChecks(a.repo, a.prs); return a; };
    ensureListLoaded("orbit/web", fetcher);
    expect(listLoadOf("orbit/web")).toBe("loading");
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(listLoadOf("orbit/web")).toBe("done");
    expect(listChecksFor("orbit/web", 7)).not.toBeNull();
    expect(listChecksFor("orbit/web", 8)).toBeNull();
  });
  test("a failed load ends as failed, so the chip says not read", async () => {
    ensureListLoaded("orbit/web", async () => { throw new Error("offline"); });
    await new Promise((r) => setTimeout(r, 0));
    expect(listLoadOf("orbit/web")).toBe("failed");
  });
});
