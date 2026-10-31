// The Lantern's Housekeeping rows: one row per pull request, changed in place,
// calm (no "needs you"), and nothing for a blocked or empty one.
import { describe, expect, test } from "bun:test";
import { housekeepingRows, whenWord, type AutoEntry } from "../src/lib/housekeeping.ts";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const base: AutoEntry = {
  repo: "/code/orbit", pr: 322, state: "cleaned", label: "acme/orbit", slug: "ORBIT-1042", title: "Fix the thing",
  reason: "", done: 10, total: 10, freed: 6_200_000_000, started_at: NOW - 120_000, ended_at: NOW - 60_000, items: [],
};

describe("housekeepingRows", () => {
  test("a running entry reads as one calm line with its progress and bytes so far", () => {
    const [r] = housekeepingRows([{ ...base, state: "cleaning", done: 5, total: 10, freed: 5_800_000_000, ended_at: null }], NOW);
    expect(r).toMatchObject({ tone: "run", title: "Cleaning ORBIT-1042...", sub: "acme/orbit · 5 of 10 removed", fresh: true });
    expect(r!.badge).toMatch(/so far$/);
  });

  test("the same pull request, finished, is the same row key with the result in the title", () => {
    const run = housekeepingRows([{ ...base, state: "cleaning", ended_at: null }], NOW)[0]!;
    const done = housekeepingRows([base], NOW)[0]!;
    expect(done.key).toBe(run.key);
    expect(done).toMatchObject({ tone: "ok", fresh: true });
    expect(done.title).toMatch(/^ORBIT-1042 cleaned, .* freed$/);
    expect(done.badge).toBeUndefined();
  });

  test("a blocked pull request and one with nothing to clean have no row; their reason is for the badge", () => {
    expect(housekeepingRows([{ ...base, state: "blocked", reason: "uncommitted changes" }, { ...base, pr: 5, state: "nothing" }], NOW)).toEqual([]);
  });

  test("running first, then newest first; a failure is a warning row with its reason", () => {
    const rows = housekeepingRows([
      { ...base, pr: 1, slug: "ORBIT-1", started_at: NOW - 5_000_000, ended_at: NOW - 4_900_000 },
      { ...base, pr: 2, slug: "ORBIT-2", state: "failed", reason: "docker refused", started_at: NOW - 3_000_000, ended_at: NOW - 2_900_000 },
      { ...base, pr: 3, slug: "ORBIT-3", state: "cleaning", ended_at: null },
    ], NOW);
    expect(rows.map((r) => r.key.split("#")[1])).toEqual(["3", "2", "1"]);
    expect(rows[1]).toMatchObject({ tone: "warn", fresh: false });
    expect(rows[1]!.sub).toContain("docker refused");
  });

  test("an entry with no slug is named by its number; Details lists each item", () => {
    const [r] = housekeepingRows([{ ...base, slug: "", items: [{ kind: "worktree", target: "/work/orbit-322", status: "done", detail: "", bytes: 1_000_000 }, { kind: "stashes", target: "stash@{0}", status: "failed", detail: "busy" }] }], NOW);
    expect(r!.title.startsWith("#322 cleaned")).toBe(true);
    expect(r!.lines).toEqual([expect.stringMatching(/^Removed: \/work\/orbit-322 \(/), "Failed: stash@{0} - busy"]);
  });

  test("whenWord", () => {
    expect([0, 90_000, 7_200_000, 100_000_000, 400_000_000].map((ms) => whenWord(NOW - ms, NOW))).toEqual(["just now", "1 min ago", "2 h ago", "yesterday", "4 days ago"]);
  });
});

const src = await Bun.file(new URL("../src/components/agents/AgentsSections.tsx", import.meta.url)).text();
const body = src.slice(src.indexOf("export function HousekeepingSection("));
describe("the Housekeeping card", () => {
  test("shows the newest few rows and keeps the rest behind Show more", () => {
    expect(src).toContain("const HK_SHOWN = 5;");
    expect(body).toContain("rows.slice(0, HK_SHOWN)");
    expect(body).toContain("Show ${rows.length - HK_SHOWN} more");
  });
});
