/*
 * The merge dialog's header held the branches inside the chips row: a long head
 * branch was clipped from the left, the arrow overlapped it and the base chip
 * wrapped inside its pill. The branches now sit in their own block, and the
 * decision of where a name may break is a pure function.
 */
import { describe, expect, test } from "bun:test";
import { branchSegments } from "../src/lib/branchBreaks.ts";

const SRC = await Bun.file(new URL("../src/components/MergeDialog.tsx", import.meta.url)).text();
const LONG = "orbit-1042-reports-section-on-the-security-groups-page/with-a-very-long-suffix_and_more.words-here-0001";

describe("branchSegments", () => {
  test("a 90+ char branch breaks after separators and rejoins exactly", () => {
    expect(LONG.length).toBeGreaterThan(90);
    const segs = branchSegments(LONG);
    expect(segs.join("")).toBe(LONG);
    expect(segs.length).toBeGreaterThan(10);
    for (const s of segs.slice(0, -1)) expect(/[-/_.]$/.test(s)).toBe(true);
  });
  test("short and empty names", () => {
    expect(branchSegments("main")).toEqual(["main"]);
    expect(branchSegments("")).toEqual([]);
  });
});

describe("chips row", () => {
  const start = SRC.indexOf('<div className="agx-mg-chips">');
  const chips = SRC.slice(start, SRC.indexOf("</div>", start));
  test("holds the number and the commit count only", () => {
    expect(chips).toContain("pending.number");
    expect(chips).toContain("commits.length");
    expect(chips).not.toContain("headRefName");
    expect(chips).not.toContain("baseRefName");
    expect(chips).not.toContain("ArrowRightIcon");
  });
  test("branches get their own From / Into rows", () => {
    expect(SRC).toContain('<BranchRow label="From" name={pending.headRefName} />');
    expect(SRC).toContain('<BranchRow label="Into" name={pending.baseRefName} />');
  });
});
