/*
 * The card's reviewer faces, drawn: the ring is the state (dashed only for
 * "asked, never answered"), the badge repeats it at the house floor size, and
 * the +N pill carries the people the faces left out.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardFaces } from "../src/components/CardFaces.tsx";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import { ICON } from "../src/lib/iconSize.ts";

const draw = (people: { login: string; state: string; team?: boolean }[]) =>
  renderToStaticMarkup(React.createElement(CardFaces, { r: cardReviewers({ kind: "awaiting", who: people.map((p) => p.login), people }) }));

describe("CardFaces", () => {
  test("nobody to draw is nothing at all", () => {
    expect(draw([])).toBe("");
  });

  test("one face per person with its state, tooltip and ring", () => {
    const html = draw([{ login: "tlindqvist", state: "again" }, { login: "rnakamura", state: "await" }, { login: "ofarah", state: "approved" }]);
    expect(html).toContain('title="tlindqvist — re-review requested"');
    expect(html).toContain('title="rnakamura — review requested, not answered yet"');
    expect(html.match(/data-face-state=/g)).toHaveLength(3);
    expect(html).toContain("1.5px solid var(--warning)");
    expect(html).toContain("1.5px dashed var(--text4)");
    expect(html).toContain("1.5px solid var(--success)");
    expect(draw([{ login: "hvelez", state: "changes" }])).toContain("1.5px solid var(--error)");
  });

  test("only the not-answered ring is dashed", () => {
    const html = draw([{ login: "a", state: "again" }, { login: "b", state: "changes" }, { login: "c", state: "approved" }]);
    expect(html).not.toContain("dashed");
  });

  test("the badge is the house floor, not a size of its own", () => {
    const html = draw([{ login: "a", state: "await" }]);
    expect(html).toContain(`width:${ICON.xs}px;height:${ICON.xs}px`);
    expect(html).toContain(`width="${ICON.xs}" height="${ICON.xs}"`);
    expect(html).not.toMatch(/width:(7|8|9|10|11)px/);
  });

  test("the +N pill names the people it hides", () => {
    const html = draw(["a", "b", "c", "d", "e"].map((login) => ({ login, state: "await" })));
    expect(html).toContain("+2");
    expect(html).toContain('title="d — review requested, not answered yet\ne — review requested, not answered yet"');
  });

  test("a team is a flat initials badge with its own name in the tooltip", () => {
    const html = draw([{ login: "platform", state: "await", team: true }]);
    expect(html).toContain("PL");
    expect(html).toContain('title="platform (team) — review requested, not answered yet"');
    expect(html).not.toContain("avatars");
  });

  test("the whole thing is decoration for a screen reader: the band's label carries the words", () => {
    expect(draw([{ login: "a", state: "await" }])).toContain('aria-hidden="true"');
  });
});
