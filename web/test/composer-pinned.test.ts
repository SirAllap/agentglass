/*
 * The comment box is always in reach.
 *
 * It sat at the end of what scrolls, so on a card with seventeen comments the
 * one control the Activity tab exists for was a full scroll away. It is now a
 * footer under the scroller: the list scrolls above it, the box starts at a
 * few lines, grows with its text up to a share of the pane and scrolls inside
 * after that.
 */
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const composer = await Bun.file(new URL("../src/components/tasks/Composer.tsx", import.meta.url)).text();

const scrollerAt = panel.indexOf("ref={listRef}");
const endOfScroller = panel.indexOf("{full === null && <div");
const box = panel.indexOf("<Composer value={say}");

describe("the card's comment box", () => {
  it("is outside the scroller, after it", () => {
    expect(scrollerAt).toBeGreaterThan(0);
    expect(endOfScroller).toBeGreaterThan(scrollerAt);
    expect(box).toBeGreaterThan(endOfScroller);
    // and nothing else in the scroller mounts it
    expect(panel.slice(scrollerAt, endOfScroller)).not.toContain("<Composer value={say}");
  });

  it("is a full-width footer with a rule on top, on the Activity tab only", () => {
    const foot = panel.slice(panel.lastIndexOf("{writable &&", box), box);
    expect(foot).toContain('view === "activity"');
    expect(foot).toContain('className="shrink-0 px-4 pt-2 pb-3"');
    expect(foot).toContain("borderTop: LINE");
  });

  it("is given a cap that is a share of the pane, and grows", () => {
    expect(panel).toContain("COMPOSER_SHARE = 0.3");
    expect(panel).toContain("pane.clientHeight * COMPOSER_SHARE");
    expect(panel.slice(box, box + 80)).toContain("growTo={sayCap}");
    const grow = composer.slice(composer.indexOf("useLayoutEffect(() => {\n    const el = box.current;"));
    expect(grow.slice(0, 500)).toMatch(/style\.height = "auto"[\s\S]*Math\.min\(el\.scrollHeight, growTo\)/);
    expect(grow.slice(0, 600)).toContain('"auto" : "hidden"');
  });

  it("keeps a reader at the end of the thread at the end while it grows", () => {
    expect(panel).toContain("list.clientHeight !== last && atEnd.current");
    expect(panel).toContain("list.scrollTop = list.scrollHeight");
  });

  it("takes the reader to the comment just posted", () => {
    expect(panel).toContain("sentRef.current = true; reread();");
    expect(panel).toMatch(/if \(!sentRef\.current\) return;[\s\S]{0,120}\[rows\.length\]/);
  });

  it("the reply and edit boxes keep their fixed, resizable height", () => {
    expect(composer).toContain('growTo == null ? "resize-y" : "resize-none"');
    expect(composer).toContain("minHeight: growTo == null ? 84 : COMPOSER_MIN");
  });
});
