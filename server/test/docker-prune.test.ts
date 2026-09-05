/*
 * Reclaiming disk.
 *
 * Two things are pinned here, and the second one is the important one.
 *
 * The first is the accounting: docker prints what it freed and the panel repeats
 * it, so misreading "41.23GB" is telling somebody a number about their own
 * machine that is wrong.
 *
 * The second is what is NOT here. `docker volume prune` is one command and
 * every developer knows it — and it takes every node_modules volume on this
 * machine, handing twenty-five worktrees a cold install each. It is deliberately
 * absent from this module, and this test is what stops it being added back on a
 * quiet afternoon as "the obvious missing one".
 */
import { describe, expect, test } from "bun:test";
import { reclaimedFrom } from "../src/dockerprune.ts";

describe("what docker says it freed", () => {
  test("the line it prints", () => {
    expect(reclaimedFrom("deleted: sha256:abc\nTotal reclaimed space: 41.23GB\n")).toBe(41_230_000_000);
    expect(reclaimedFrom("Total reclaimed space: 512.4MB")).toBe(512_400_000);
    expect(reclaimedFrom("Total reclaimed space: 0B")).toBe(0);
  });

  test("and null when it did not say", () => {
    // Null, not zero: "it freed nothing" and "it did not tell us" are different
    // sentences and the panel prints different words for them.
    expect(reclaimedFrom("")).toBe(null);
    expect(reclaimedFrom("Deleted build cache objects:\nabc\ndef")).toBe(null);
  });
});

const raw = await Bun.file(new URL("../src/dockerprune.ts", import.meta.url).pathname).text();
/* Comments stripped before matching: the module's own header explains at length
   why `docker volume prune` is not here, and a lock that trips over the
   explanation would force whoever added it to delete the reasoning. */
const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("what this module refuses to offer", () => {

  /* The lock. `docker volume prune` frees a few gigabytes and costs every
     worktree on the machine a cold `pnpm install` — minutes each, all at once,
     for people who did not press the button. A panel that offers it next to
     "clear build cache" makes the two look like the same kind of decision. */
  test("no volume prune, in any spelling", () => {
    expect(source).not.toMatch(/"volume"\s*,\s*"prune"/);
    expect(source).not.toMatch(/volume prune/);
  });

  test("nor a bare system prune, which is the same thing wearing a hat", () => {
    expect(source).not.toMatch(/"system"\s*,\s*"prune"/);
  });

  /* Build cache is kept under a BUDGET, never emptied. `--all` throws away the
     cache that makes today's builds fast, which is a cost nobody associates
     with the button they pressed last week.

     And a budget rather than an age filter because the age filters do not
     work: measured on docker 29.7.2 / buildkit v0.32.2 with 96GB of cache last
     used months ago, `--filter until=720h` and `--filter unused-for=720h` each
     freed 0B, twice. A raw-byte `--max-used-space` freed 111GB. A button that
     frees nothing while reporting success is worse than no button. */
  test("the cache is capped, never emptied", () => {
    expect(source).toContain("--max-used-space");
    expect(source).not.toMatch(/"prune"[^)]*"--all"/);
  });

  test("the cap is in raw bytes — a human-readable size silently frees nothing", () => {
    expect(source).toContain("String(budget)");
    expect(source).not.toMatch(/max-used-space",\s*"\d+GB"/);
  });

  test("and it has a floor, so a budget cannot become a wipe", () => {
    // A cap small enough to empty the cache is `prune --all` with extra steps.
    expect(source).toMatch(/Math\.max\([\s\S]*?1_000_000_000\)/);
  });

  /* Images are removed one at a time so that one refusal does not silently
     abandon the rest — `docker rmi a b c` stops at the first failure. */
  test("images are removed one by one", () => {
    expect(source).toMatch(/for \(const ref of wanted\)/);
    expect(source).toContain('"image", "rm", ref');
  });
});
