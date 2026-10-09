/*
 * A comment card hugs its text.
 *
 * The hover-revealed actions (Reply, Edit, Resolve, Delete) sat in the flow
 * under the paragraph at opacity 0, so every card kept a ~30px blank band
 * below even a one-line remark (measured 43px from text to card edge, 13px
 * without the row). They now float over the card's bottom edge instead.
 */
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("comment actions reserve no height", () => {
  it("the hover row is absolutely positioned, not a margin-top row", () => {
    const at = panel.indexOf('<div className="agx-hover-show absolute');
    expect(at).not.toBe(-1);
    const tag = panel.slice(at, panel.indexOf(">", at));
    expect(tag).toContain("bottom-1.5");
    expect(tag).not.toMatch(/\bmt-\d/);
  });

  it("no comment-level hover row stays in the flow", () => {
    expect(panel).not.toContain('className="agx-hover-show flex flex-wrap items-center gap-1 mt-2"');
  });
});
