// The Review stage's bar is one segment per reviewer, the whole width of the
// cell, with a face inside each segment. Which segments get a face is a rule
// about width: a lone approval of one filled a third of its cell, and four
// reviewers at the narrowest cell (~168px) left each line 4px long.
//
// Components are pinned by reading their source, as elsewhere in this suite —
// there is no renderer here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BAR_FACES_MAX, badgeGlyph, barLayout } from "../src/lib/reviewBar.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

describe("barLayout", () => {
  test("nobody is nothing to draw", () => {
    expect(barLayout(0)).toEqual([]);
    expect(barLayout(-2)).toEqual([]);
  });

  test("one reviewer, and two, each get a face", () => {
    expect(barLayout(1)).toEqual([{ index: 0, face: true }]);
    expect(barLayout(2).map((s) => s.face)).toEqual([true, true]);
  });

  test("past the cap the people are still counted, only the face is withheld", () => {
    const six = barLayout(6);
    expect(six).toHaveLength(6);
    expect(six.filter((s) => s.face)).toHaveLength(BAR_FACES_MAX);
    // the ones that keep a face are the first, which the roster ranks by what they cost you
    expect(six.map((s) => s.face)).toEqual([true, true, true, false, false, false]);
  });

  test("a fractional count does not invent a segment", () => {
    expect(barLayout(2.9)).toHaveLength(2);
  });
});

describe("the state mark on a face", () => {
  test("only a decision carries a glyph; waiting and commenting are colour alone", () => {
    expect(badgeGlyph("approved")).toBe("tick");
    expect(badgeGlyph("approved-old")).toBe("tick");
    expect(badgeGlyph("changes")).toBe("cross");
    for (const s of ["approved-void", "changes-again", "commented", "requested", "dismissed", "team"] as const) {
      expect(badgeGlyph(s)).toBe("none");
    }
  });
});

describe("the merge box draws people as faces", () => {
  const box = read("src/components/MergeBox.tsx");
  const face = read("src/components/ReviewFace.tsx");
  const panel = read("src/components/PrPanel.tsx");

  test("the letter circle is gone; a row and the bar both go through ReviewFace", () => {
    expect(box).not.toContain("login.charAt(0)");
    expect(box).toContain("<ReviewFace login={r.person.login} state={r.person.state} badge />");
    expect(box).toContain("<ReviewBar tally={s.tally} />");
    expect(face).toContain("<Avatar login={login} size={size} />");
  });

  test("history: a request by the viewer is their face, not a Y; a verdict row has the reviewer's", () => {
    expect(panel).toContain("useContext(ViewerCtx) || you");
    expect(panel).toContain('e.actor === "you" ? viewerLogin : e.actor');
    expect(panel).toContain("e.kind !== \"ask\" ? g.login");
  });
});
