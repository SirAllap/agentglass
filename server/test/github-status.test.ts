/*
 * GitHub's public status is read at most once per ten minutes, however many
 * pull requests ask, and being offline never reads as a problem.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { githubStatusCached, __resetStatusMemo } from "../src/prs.ts";

const T0 = Date.parse("2026-10-09T13:00:00Z");
const MIN = 60_000;
const degraded = { components: [{ name: "Pull Requests", status: "degraded_performance" }], incidents: [] };
const ok = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => __resetStatusMemo());

describe("githubStatusCached", () => {
  test("one fetch inside ten minutes, whoever asks", async () => {
    let calls = 0;
    const f = async () => { calls++; return ok(degraded); };
    const a = await githubStatusCached(T0, f);
    const b = await githubStatusCached(T0 + 9 * MIN, f);
    expect(calls).toBe(1);
    expect(a.problem?.text).toContain("pull requests");
    expect(b.cached).toBe(true);
    await githubStatusCached(T0 + 10 * MIN, f);
    expect(calls).toBe(2);
  });
  test("offline: no problem, and not retried for the whole window", async () => {
    let calls = 0;
    const f = async () => { calls++; throw new Error("offline"); };
    expect((await githubStatusCached(T0, f)).problem).toBeNull();
    await githubStatusCached(T0 + 5 * MIN, f);
    expect(calls).toBe(1);
  });
  test("a non-200 is no news", async () => {
    expect((await githubStatusCached(T0, async () => ({ ok: false, json: async () => degraded }))).problem).toBeNull();
  });
  test("asks the public summary, with no credentials", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    await githubStatusCached(T0, async (url, init) => { seen = { url, headers: init.headers }; return ok({}); });
    expect(seen!.url).toBe("https://www.githubstatus.com/api/v2/summary.json");
    expect(Object.keys(seen!.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });
});
