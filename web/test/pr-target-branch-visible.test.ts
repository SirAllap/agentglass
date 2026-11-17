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
    // The trunk (main, master) never truncates (.prx-base is flex: none); a stacked PR's feature base may.
    expect(tag).toContain('isTrunk(d.baseRefName) ? "prx-branch prx-base" : "prx-branch"');
  });
  it("detail header: the route chip's head may shrink, the trunk base chip never does", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.prx-base \{ flex: none; white-space: nowrap; \}/);
    expect(css).toMatch(/\.prx-branch > span \{[^}]*text-overflow: ellipsis/);
  });
  it("the list row is gone: the board's cards are the only list", () => {
    expect(panel).not.toContain("Merges into ${p.baseRefName}");
  });
  it("board card: the base is never truncated", () => {
    const tag = line(board, "data-tip={`${p.headRefName} → ${p.baseRefName}`}");
    /* The base is a chip that never shrinks: its class says `flex: none`, the branch it came from is the one that gives way. */
    expect(tag).toContain("agx-pc-dest");
    expect(readFileSync(new URL("../src/index.css", import.meta.url), "utf8")).toMatch(/\.agx-pc-dest \{ flex: none; white-space: nowrap;/);
    expect(tag).not.toContain("truncate");
    expect(tag).not.toContain("maxWidth: 90");
  });
});
