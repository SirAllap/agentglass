/*
 * The branch a pull request merges INTO is never the part that is cut.
 *
 * A long head branch was truncated at a fixed width with most of the header
 * strip still empty to its right, and it took the destination with it
 * ("-> ma..."). The destination is what says whether this lands on the trunk or
 * on somebody's stack, so only the head on the left may truncate: the target
 * is its own non-shrinking chip in the detail header and a non-truncating span
 * in the list row and the board card. There is no renderer in this project, so
 * this is asserted against source.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();

const line = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i).toBeGreaterThan(-1);
  return src.slice(src.lastIndexOf("<", i), src.indexOf(">", i) + 1);
};

describe("target branch chip", () => {
  it("detail header: the base is a shrink-0 nowrap chip, but for a feature base in a one-row header", () => {
    const tag = line(panel, "data-base-chip");
    expect(tag).toContain("shrink-0 whitespace-nowrap");
    // The trunk (main, master) never truncates; a stacked PR's feature base may,
    // and only where the header is one row, so its name stays in the tooltip.
    expect(tag).toContain('plan.metaOneRow && !isTrunk(d.baseRefName) ? "truncate min-w-0" : "shrink-0 whitespace-nowrap"');
  });
  it("detail header: the route chip's head may shrink, the trunk base chip never does", () => {
    const i = panel.indexOf("data-base-chip");
    const base = panel.slice(panel.lastIndexOf("<span", i), panel.indexOf("</span>", i));
    expect(base).toContain("shrink-0 whitespace-nowrap");
    expect(panel).toContain('className="px-1 py-0.5 rounded text-[10.5px] truncate min-w-0"');
  });
  it("the list row is gone: the board's cards are the only list", () => {
    expect(panel).not.toContain("Merges into ${p.baseRefName}");
  });
  it("board card: the base is never truncated", () => {
    const tag = line(board, "title={`${p.headRefName} → ${p.baseRefName}`}");
    /* The base is a chip that never shrinks: its class says `flex: none`, the branch it came from is the one that gives way. */
    expect(tag).toContain("agx-pc-dest");
    expect(readFileSync(new URL("../src/index.css", import.meta.url), "utf8")).toMatch(/\.agx-pc-dest \{ flex: none; white-space: nowrap;/);
    expect(tag).not.toContain("truncate");
    expect(tag).not.toContain("maxWidth: 90");
  });
});
