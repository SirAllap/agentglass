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

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();

const line = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i).toBeGreaterThan(-1);
  return src.slice(src.lastIndexOf("<", i), src.indexOf(">", i) + 1);
};

describe("target branch chip", () => {
  it("detail header: the base is a shrink-0 nowrap chip", () => {
    const tag = line(panel, "data-base-chip");
    expect(tag).toContain("shrink-0");
    expect(tag).toContain("whitespace-nowrap");
    expect(tag).not.toContain("truncate");
  });
  it("detail header: the head chip may shrink, the cell is a share of the row", () => {
    expect(panel).toContain('<Field label="Branch" max="62%"');
    expect(panel).not.toContain('<Field label="Branch" max={460}');
  });
  it("list row: the destination span has no width cap", () => {
    const tag = line(panel, 'title={`Merges into ${p.baseRefName}`}');
    expect(tag).toContain("shrink-0");
    expect(tag).not.toContain("maxWidth");
    expect(tag).not.toContain("truncate");
  });
  it("board card: the base is never truncated", () => {
    const tag = line(board, "title={`${p.headRefName} → ${p.baseRefName}`}");
    expect(tag).toContain("shrink-0");
    expect(tag).not.toContain("truncate");
    expect(tag).not.toContain("maxWidth: 90");
  });
});
