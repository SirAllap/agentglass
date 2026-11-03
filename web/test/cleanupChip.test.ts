// The window bar's cleanup chip: what it says while Automatic cleanup works, nothing when idle,
// and the wiring that puts it in the bar. A rule about source is asserted against source.
import { describe, expect, test } from "bun:test";
import { cleanupChip } from "../src/lib/cleanupChip.ts";
import { nowLine } from "../src/lib/cleanupSettings.ts";
import type { AutoEntry } from "../src/lib/housekeeping.ts";

const base: AutoEntry = {
  repo: "/code/orbit", pr: 322, state: "cleaning", label: "acme/orbit", slug: "ORBIT-1042", title: "Fix the thing",
  reason: "", done: 3, total: 10, freed: 1_500_000_000, started_at: 1000, ended_at: null, items: [],
};

describe("cleanupChip", () => {
  test("running: items done over total of the current PR, the queue behind it, the bar fraction", () => {
    const c = cleanupChip([base], 2)!;
    expect(c).toMatchObject({ label: "Cleaning 3 of 10", more: "+2", fraction: 0.3 });
    expect(c.tip.name).toBe("Cleaning ORBIT-1042");
    expect(c.tip.text).toMatch(/^3 of 10 items removed, .* freed so far\. 2 more waiting\.$/);
  });

  test("idle: nothing at all, also when only finished, blocked or failed rows exist", () => {
    const rest = (["cleaned", "blocked", "failed", "nothing"] as const).map((state) => ({ ...base, state }));
    expect(cleanupChip([], 0)).toBeNull();
    expect(cleanupChip(rest, 0)).toBeNull();
  });

  test("queued with no row yet: a chip without a bar", () => {
    expect(cleanupChip([], 3)).toMatchObject({ label: "Cleaning", more: "+3", fraction: null });
  });

  test("the newest running entry is the current one; no bytes and no queue add no words", () => {
    const c = cleanupChip([{ ...base, pr: 1, started_at: 1 }, { ...base, pr: 2, slug: "", started_at: 9, freed: 0 }], 0)!;
    expect(c.tip).toEqual({ name: "Cleaning #2", text: "3 of 10 items removed." });
    expect(c.more).toBe("");
  });

  test("a zero total does not divide by zero", () => {
    expect(cleanupChip([{ ...base, done: 0, total: 0 }], 0)!.fraction).toBe(0);
  });
});

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const bar = await read("../src/components/TopBar.tsx");
const chip = await read("../src/components/CleanupChip.tsx");
const store = await read("../src/lib/housekeepingStore.ts");

describe("the chip's wiring", () => {
  test("the bar mounts it beside the bell and opens the Lantern", () => {
    expect(bar).toContain("<CleanupChip noDrag={NO_DRAG} onOpen={onOpenLantern} />");
    expect(bar.indexOf("<CleanupChip")).toBeLessThan(bar.indexOf("<NotifyBell"));
  });
  test("it reads the housekeeping feed, draws nothing when idle, and has the house tooltip", () => {
    expect(chip).toContain("housekeeping.subscribe");
    expect(chip).toContain("if (!chip) return null;");
    expect(chip).toContain("data-tip={tipAttr(chip.tip)}");
    expect(chip).not.toMatch(/setInterval|setTimeout/);
  });
  test("the queue comes with the same re-read, never a timer", () => {
    expect(store).toContain("queued = typeof r.queued");
    expect(store).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("the Automatic option's explanation", () => {
  const text = nowLine("auto");
  test.each([
    "in the background", "one merged PR at a time", "in the order they were merged", "picks up where it stopped",
    "merged in the last day", "worktree", "branch", "evidence folders", "Docker", "archive/",
    "uncommitted changes", "a live session", "a stacked PR", "commits not in the PR", "the reason shows on the PR",
  ])("says %s", (w) => expect(text).toContain(w));
});
