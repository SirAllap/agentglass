// A reviewer was drawn in four places, and they used to disagree about what a
// reviewer is. Only the list had a shape that could say "this one is a team",
// so only the list drew a team as initials; the sidebar and the overview asked
// the avatar proxy for a portrait of one and got a broken image back. The
// fourth was the browser companion, which had the opposite failure — it joined
// the objects and rendered "[object Object]" — and it is deleted.
//
// Components are pinned by reading their source here, as elsewhere in this
// suite — see budgets-pane.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const panel = read("src/components/PrPanel.tsx");

describe("a team is not drawn as a face", () => {
  test("the reviewer surfaces go through the one component", () => {
    expect(panel).toContain("<ReviewerFace r={r} size={18} />"); // the list's stack
    expect(panel).toContain("<ReviewerFace r={p} size={16} />"); // assignees, in the sidebar
    // The sidebar's reviewer list, which carries a verdict per person and
    // therefore builds its own row — see lib/prReviewers.
    expect(panel).toContain("<ReviewerFace r={{ login: r.login, isTeam: r.isTeam }} size={16} />");
  });

  /*
   * THE MASTHEAD NO LONGER DUPLICATES THE SIDEBAR.
   *
   * The masthead's own "Reviewers" cell built the same roster with the same
   * verdict beside a second copy of the same three faces the sidebar already
   * lists — "why do we want this info up here if we already have it on the
   * right?". Its faces were also the one place `ReviewerFace` sat inside a
   * flexible wrapper instead of a `shrink-0` one, so a longer verdict label
   * squeezed them into slivers the moment "asked again" grew the row. Both
   * problems close by there being one home for this fact instead of two: the
   * verdict moved to the top of the sidebar's own Reviewers section, and the
   * masthead cell is gone.
   */
  test("the masthead cell is gone, and its verdict lives in the sidebar instead", () => {
    expect(panel).not.toContain('<Field label="Reviewers"');
    expect(panel).not.toContain("<ReviewerFace r={{ login: r.login, isTeam: r.isTeam }} size={14} />");
    const sidebar = panel.slice(panel.indexOf('<SidebarSection title="Reviewers"'));
    const section = sidebar.slice(0, sidebar.indexOf("</SidebarSection>"));
    expect(section, "the same verdict the masthead used to draw, now above the roster it came from")
      .toContain("verdictLine(v)");
    expect(section).toContain("<ReviewerList rows={rows} />");
  });

  /*
   * THE MASTHEAD'S LABELS CELL IS GONE THE SAME WAY.
   *
   * A run of the same names, in the same order, under a sidebar section that
   * already edits them — "and this one too, since it is all in this panel".
   */
  test("the masthead's Labels cell is gone too", () => {
    expect(panel).not.toContain('<Field label="Labels"');
  });

  test("and no surface builds a face any other way", () => {
    /* The guard the literals above cannot give: they pin the ones that exist
       and say nothing about a fifth. Every reviewer or assignee portrait in
       this panel goes through `ReviewerFace`, because that is the one place
       that knows a team is initials rather than a photograph. */
    const faces = (panel.match(/<ReviewerFace /g) ?? []).length;
    expect(faces, "the three pinned above, and any new one must be one of these")
      .toBeGreaterThanOrEqual(3);
  });

  test("the sidebar no longer hands a bare login to the avatar", () => {
    expect(panel).not.toContain("logins={d.reviewers}");
    /* And it no longer prints the OUTSTANDING request list under the heading
       "Reviewers": on a pull request where everybody has answered that list is
       empty, so the panel said "No reviewers" over two approvals and a request
       for changes. The roster is the union — see pr-reviewers.test.ts. */
    expect(panel).not.toContain("people={d.reviewers}");
    expect(panel).toContain("<ReviewerList rows={rows} />");
  });

  test("an assignee is a person with nothing to flag", () => {
    // The sidebar list is shared, and only a reviewer can be a team.
    expect(panel).toContain("people={d.assignees.map((login) => ({ login }))}");
  });
});

/*
 * NO SIDEWAYS SCROLL IN THE SIDEBAR.
 *
 * The column carried `overflow-y-auto` alone, which reads as "scroll
 * vertically, leave the other axis be". CSS does not do that: when one axis is
 * a scrolling value and the other is `visible`, the `visible` one computes to
 * `auto`. So a horizontal scrollbar appeared under a column of narrow labels,
 * three quarters of the width — "this scroll makes no sense here, there must
 * never be a horizontal scroll here".
 *
 * Read from the source because the browser's own computed style is what is
 * wrong here, and `renderToStaticMarkup` has no layout: there is no width to
 * overflow and nothing to measure.
 */
describe("the pull request sidebar", () => {
  test("declares both axes, so the browser cannot pick the second one", () => {
    const aside = panel.slice(panel.indexOf("<aside className=\"sticky top-0"));
    const cls = /className="([^"]*)"/.exec(aside)?.[1] ?? "";
    expect(cls, "the sidebar's own classes").toContain("overflow-y-auto");
    expect(cls, "without this, `visible` computes to `auto` and scrolls sideways")
      .toContain("overflow-x-hidden");
  });
});

/*
 * A FIELD CLIPS AT ITS OWN EDGE, RATHER THAN PAINTING PAST IT.
 *
 * Found on the masthead's old Reviewers cell, before it was removed: `max` on
 * `Field` is a real cap only if something on the row actually cuts there, and
 * this row had nothing that did — every child already truncated or refused to
 * shrink on its own, so a row too full to fit painted over the field beside
 * it instead of stopping. `Field` is shared by everything still in the
 * masthead (Branch, Worktree, Assignee, Milestone, Checks, Review), so the
 * fix belongs there rather than in whichever cell happened to overflow first.
 *
 * Read from source: `renderToStaticMarkup` has no layout, so there is no
 * width to overflow and nothing to measure.
 */
describe("a Field never paints past its own edge", () => {
  test("its content row clips rather than spilling into the next field", () => {
    const start = panel.indexOf("function Field(");
    const block = panel.slice(start, start + 1200);
    expect(block).toContain('flex items-center gap-1 min-w-0 overflow-hidden');
  });
});
