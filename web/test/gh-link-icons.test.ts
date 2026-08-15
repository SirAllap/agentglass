/*
 * The two controls on a comment: go to it, and copy its address.
 *
 * The arrow on its own said "this leaves" and not where to, which matters on a
 * row that can also send you to ClickUp — so the GitHub mark goes beside it.
 * The copy button is the other half of the ask: what you paste into a chat so
 * somebody lands on that exact remark rather than on the pull request.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const block = src.slice(src.indexOf("function GhMark"), src.indexOf("function GhLink") + 2600);

describe("the link and copy controls on a comment", () => {
  it("draws GitHub's mark, so the destination is readable without a hover", () => {
    expect(src).toContain("function GhMark");
    expect(block).toContain("<GhMark");
  });

  it("keeps the arrow, because the mark alone does not say it leaves the app", () => {
    expect(block).toContain("↗");
  });

  it("copies the address, not the comment's text", () => {
    // The point is a link somebody can follow. Copying the body would be a
    // different feature wearing the same icon.
    expect(block).toContain("navigator.clipboard?.writeText(safe)");
  });

  it("copies the URL it vouched for, never the raw one from the API", () => {
    /* `externalUrl` is what decides a link is plain enough to offer. Copying
       `href` instead would hand out exactly the address the anchor refused to
       navigate to. */
    expect(block).not.toMatch(/writeText\(href\)/);
  });

  it("sizes both off the icon scale rather than the type beside them", () => {
    // An icon-only control that inherits a 10px row is a target nobody can hit
    // — the repeated note about icons coming out tiny.
    expect(block).toContain("ICON.xs");
    expect(block).toContain("width: 20, height: 20");
  });

  it("says nothing at all when the link cannot be vouched for", () => {
    // Both controls go, not just the anchor: a copy button beside no link is a
    // button that copies nothing.
    expect(block).toContain("if (!safe) return null;");
  });

  it("confirms the copy on the button that was pressed", () => {
    // A silent copy is indistinguishable from a copy that failed.
    expect(block).toContain('title={copied ? "Link copied"');
  });

  it("stops the click from reaching the row underneath", () => {
    // These sit inside comment cards that open things when clicked.
    expect(block).toContain("e.stopPropagation()");
  });
});
