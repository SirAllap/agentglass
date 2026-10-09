/*
 * The card's scrollbar starts where its content does.
 *
 * The scroller used to wrap the whole card, header included, so the bar ran
 * alongside the chips and title where nothing moves, showed the platform's
 * arrowed track, and the header and the comment cards stopped 16px and 26px
 * short of it. Now the header is a plain band and only what is below the tabs
 * scrolls.
 */
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("the card pane", () => {
  it("the header is not inside the scroller", () => {
    expect(panel).not.toContain('className="sticky top-0 z-20 pt-4 pb-1.5"');
    expect(panel).toContain('className="shrink-0 px-4 pt-4 pb-2"');
    expect(panel.indexOf('className="shrink-0 px-4 pt-4 pb-2"'))
      .toBeLessThan(panel.indexOf("agx-scroll agx-cu-scroll"));
  });

  it("neither wrapper around the card scrolls or pads it", () => {
    for (const m of panel.matchAll(/\{cardBody\}/g)) {
      const at = m.index!;
      expect(panel.slice(panel.lastIndexOf("<div", at), at)).not.toMatch(/overflow-y-auto|px-4/);
    }
  });

  it("the bar has no arrow buttons and keeps its width in reserve", () => {
    expect(panel).toContain("::-webkit-scrollbar-button{display:none");
    expect(panel).toContain("[scrollbar-gutter:stable]");
  });
});
