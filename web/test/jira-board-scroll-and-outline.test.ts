/*
 * Two board-only fixes: normal horizontal scroll (wheel, trackpad, scrollbar drag) must reach every column, not only the
 * "+N columns" pill; and Board must not offer "By epic, then status" (Board draws its own rows as Swimlanes - that
 * outline is a List idea).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupControl } from "../src/components/jira/list/GroupControl.tsx";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";

const index = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const mock = await Bun.file(new URL("../src/jiraMock.css", import.meta.url)).text();

describe("the board's horizontal scroll", () => {
  test("no snap: a wheel notch or a trackpad swipe is never pulled back to a column's edge", () => {
    // Mandatory snapped every short scroll straight back; proximity still did whenever a gesture ended near a column.
    const rule = /\.agx-jb-scroll\s*\{[^}]*\}/.exec(index)?.[0] ?? "";
    expect(rule).toContain("scroll-snap-type: none;");
    expect(rule).not.toMatch(/scroll-snap-type: x (mandatory|proximity)/);
  });

  test("the mockup's board rules are scoped under .agx-jmock, so they cannot clip the real board", () => {
    for (const sel of [".agx-jb", ".agx-jb-percol", ".agx-jb-colbox", ".agx-jb-cards"]) {
      const esc = sel.replace(".", "\\.");
      // A bare rule starts the line with the selector; the scoped one always has ".agx-jmock " first.
      const bare = new RegExp(`^${esc}(?=[\\s{,>])`, "m");
      const scoped = new RegExp(`\\.agx-jmock\\s+${esc}(?=[\\s{,>])`);
      expect(scoped.test(mock), `${sel} should appear scoped under .agx-jmock`).toBe(true);
      expect(bare.test(mock), `${sel} should never appear unscoped in jiraMock.css`).toBe(false);
    }
  });
  test("a column's own vertical scroll lets a sideways wheel through to the board", () => {
    // `overscroll-behavior: contain` on a column stops chaining on both axes: a trackpad's deltaX over a card died in the
    // column, and the board only moved with the pointer on its bottom scrollbar. Only the vertical axis is contained.
    const at = mock.indexOf(".agx-jmock .agx-jb-cards {");
    expect(at).toBeGreaterThan(-1);
    const rule = mock.slice(at, mock.indexOf("}", at));
    expect(rule).toMatch(/overscroll-behavior:\s*auto\s+contain\s*;/);
  });
});

describe("Board's outline presets", () => {
  const render = (board: boolean) =>
    renderToStaticMarkup(React.createElement(GroupControl, { filters: NO_FILTERS, onFilters: () => {}, hasAreas: true, board }));

  test("List offers \"By epic, then status\"", () => {
    expect(render(false)).toContain("By epic, then status");
  });

  test("Board does not: it draws its own rows (Swimlanes)", () => {
    const html = render(true);
    expect(html).not.toContain("By epic, then status");
    expect(html).not.toContain("By status");
  });
});
