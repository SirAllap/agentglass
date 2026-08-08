/*
 * The warning you get for landing a pull request past a review you asked for.
 *
 * Reported from a real pull request: an automation approved it, GitHub called
 * it mergeable, and the panel said "Ready to merge — nothing is standing in the
 * way" while a named person sat in "1 pending review". Nothing was wrong about
 * the mechanics. The sentence was about branch protection and the reader was
 * asking about their colleague.
 *
 * WHY THIS FILE EXISTS AT ALL. The warning shipped with three assertions over
 * it, all of them reading MergeDialog.tsx as text: that the interface still
 * declares `awaitingReview?: string[]`, that the words "asked to review and"
 * appear somewhere in the file, and that no `disabled=` is spelled against the
 * field. Nothing rendered the dialog. An audit changed the one condition that
 * decides whether the banner is drawn —
 *
 *     {(pending.awaitingReview?.length ?? 0) > 0 && (   →   … > 99 && (
 *
 * — so the warning could never appear on any pull request anybody will ever
 * open, and the whole suite stayed green: the interface line was untouched, the
 * prose was still in the file, and prose in a branch nothing can reach is prose
 * nobody reads.
 *
 * So this renders it. There is no DOM under `bun test`, so the component goes
 * through `renderToStaticMarkup` exactly as `file-rail-view.test.ts` does, and
 * what is asserted is the sentence a person gets — singular against plural, the
 * overflow, the clause about automation, and the button still being pressable
 * underneath all of it.
 */
import { describe, expect, test, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/*
 * Two seams, both mocked for the same reason: they are the parts of this
 * component that need a browser, and neither is what is being asserted.
 *
 * `Portal` calls `document.createElement` in a `useState` initialiser — which
 * runs during render, not in an effect — and then `createPortal`, which React's
 * server renderer refuses outright. It exists to escape the panel's stacking
 * context; here there is no stacking context, so a passthrough is the whole
 * truth of it.
 *
 * `api.ts` reads `window.agentglass`, `location.href` and localStorage while
 * its module body runs. The dialog only calls it from an effect, and
 * `renderToStaticMarkup` runs no effects, so nothing here reaches a stub — but
 * the import alone would throw before the first test.
 */
mock.module(new URL("../src/components/Portal.tsx", import.meta.url).pathname, () => ({
  Portal: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module(new URL("../src/lib/api.ts", import.meta.url).pathname, () => ({
  api: {
    clickupViews: async () => null,
    clickupFind: async () => null,
    clickupList: async () => null,
    clickupSetWrites: async () => null,
  },
}));

const { MergeDialog } = await import("../src/components/MergeDialog.tsx");
type Spec = NonNullable<Parameters<typeof MergeDialog>[0]["pending"]>;

/*
 * A squash of two commits on an invented repository. Only the fields the dialog
 * reads are filled, and `card: null` keeps ClickUp out of it entirely — the
 * card row is a different feature with its own reasons.
 */
const spec = (over: Partial<Spec> = {}): Spec => ({
  number: 482,
  title: "Round the checkout total once, at the end",
  method: "squash",
  baseRefName: "main",
  headRefName: "fix/checkout-rounding",
  commits: [
    { message: "Round once, at the end" },
    { message: "Cover the half-cent boundary" },
  ],
  repoDeletesBranch: false,
  card: null,
  resolve: () => {},
  ...over,
});

const render = (over: Partial<Spec> = {}): string =>
  renderToStaticMarkup(React.createElement(MergeDialog, { pending: spec(over) }));

/** The confirm button's own opening tag. The dialog has six buttons in it and a
 *  claim about "the merge button" has to be a claim about THAT one — which is
 *  the last one in the footer, the one wearing the method's label. */
const confirm = (html: string, label = "Squash and merge"): string => {
  const i = html.lastIndexOf(label);
  expect(i).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", i), i);
};

/** Whether that button is actually dead. `disabled=""` is the attribute React
 *  writes; `disabled:opacity-40` is a Tailwind class that is on the button in
 *  both states and is not a claim about anything — an earlier draft of this file
 *  asked for "disabled" and got the class. */
const dead = (tag: string): boolean => tag.includes("disabled=");

/** The names inside the warning's own bold, which is the only place the sentence
 *  lists anybody. A claim about who is named has to be read from there and not
 *  from the whole document — the head branch and the card row also carry text,
 *  and `not.toContain("+")` over 4kB of markup is a claim about the markup. */
const named = (html: string): string => {
  const i = html.indexOf("asked to review and");
  expect(i).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<b ", i);
  return html.slice(html.indexOf(">", open) + 1, html.indexOf("</b>", open));
};

/*
 * THE CONTROL, and it is not a formality.
 *
 * Every assertion below that says the warning is ABSENT would also pass on a
 * dialog that rendered nothing at all — which, with the audit's `> 99` in
 * place, is very nearly what happened. So one test proves the render is real
 * first, and the negatives are read against it.
 */
describe("the dialog renders, before anything is claimed about what it says", () => {
  test("it draws the question it is asking", () => {
    const html = render();
    expect(html).toContain("Squash and merge");
    expect(html).toContain("#482");
    expect(html).toContain("fix/checkout-rounding");
    expect(html).toContain("main");
    expect(html).toContain("2 commits");
    expect(html).toContain(`role="dialog"`);
  });
});

describe("merging past a review somebody owes you", () => {
  test("with nobody waiting, there is no warning to give", () => {
    // Both spellings of nobody: the field absent, and the list empty. The panel
    // sends `reviewers.map(...)`, which is `[]` on a pull request nobody was
    // asked to look at, and a warning about an empty list is a warning about
    // nothing.
    for (const awaitingReview of [undefined, []]) {
      const html = render({ awaitingReview });
      expect(html).toContain("Squash and merge"); // the control, per render
      expect(html).not.toContain("asked to review");
      expect(html).not.toContain("Merging now lands it without them");
    }
  });

  test("one person is named, in the singular", () => {
    /*
     * The reported case exactly: "1 pending review", one login. Read aloud it
     * has to be "d-okafor was asked to review and has not" — a plural verb over
     * a single name is the sentence looking machine-generated at the one moment
     * the reader is deciding whether to override a colleague.
     */
    const html = render({ awaitingReview: ["d-okafor"] });
    expect(html).toContain("d-okafor");
    expect(html).toContain("was asked to review and");
    expect(html).toContain(" has not.");
    expect(html).not.toContain("were asked");
    expect(html).not.toContain(" have not.");
    expect(html).toContain("Merging now lands it without them.");
  });

  test("several are named, in the plural, all of them", () => {
    const html = render({ awaitingReview: ["d-okafor", "p-navarro"] });
    expect(html).toContain("d-okafor, p-navarro");
    expect(html).toContain("were asked to review and");
    expect(html).toContain(" have not.");
    expect(html).not.toContain("was asked");
  });

  test("past three it names three and counts the rest", () => {
    /*
     * A team review request is eight logins, and eight logins is a paragraph in
     * a 760px dialog. Three and a tally: enough to recognise who this is about,
     * short enough to still be a sentence. The number is what is LEFT, not the
     * total — "+2" over five names, because "+5" would read as seven people.
     */
    const html = render({ awaitingReview: ["d-okafor", "p-navarro", "l-adeyemi", "s-varga", "m-okonkwo"] });
    expect(named(html)).toBe("d-okafor, p-navarro, l-adeyemi +2");
    // The two it did not name are not in the sentence at all — an overflow that
    // still printed them would be the paragraph this rule exists to prevent.
    expect(html).not.toContain("s-varga");
    expect(html).not.toContain("m-okonkwo");
    expect(html).toContain("were asked to review and");
  });

  test("exactly three is three names and no tally", () => {
    // The boundary, and the reason it is here: `slice(0, 3)` with a `> 3` guard
    // and `length - 3` is three chances to be off by one, and "+0" is the shape
    // the mistake takes.
    const html = render({ awaitingReview: ["d-okafor", "p-navarro", "l-adeyemi"] });
    expect(named(html)).toBe("d-okafor, p-navarro, l-adeyemi");
  });
});

describe("who did the approving, when somebody is still waiting", () => {
  const waiting = { awaitingReview: ["d-okafor"] };
  const CLAUSE = "The approval that unblocked this came from automation.";

  test("a bot approved and no person did — which is the pull request that was reported", () => {
    const html = render({ ...waiting, humanApproved: false, botApproved: true });
    expect(html).toContain(CLAUSE);
  });

  test("a person approved too, so the clause would be false", () => {
    // Somebody did look at it. The warning still stands — the person who was
    // ASKED has not answered — but "the approval came from automation" is no
    // longer true, and a true warning carrying a false clause is worse than no
    // clause.
    const html = render({ ...waiting, humanApproved: true, botApproved: true });
    expect(html).toContain("was asked to review and");
    expect(html).not.toContain(CLAUSE);
  });

  test("nothing approved it at all, which is not the same as a bot approving", () => {
    /*
     * The reason `botApproved` exists as a second flag rather than being read
     * off `humanApproved === false`. That one flag alone is also `false` for
     * "nobody and nothing has approved this", and the sentence built from it
     * told the reader a bot had signed off on a pull request no one had touched.
     */
    const html = render({ ...waiting, humanApproved: false, botApproved: false });
    expect(html).toContain("was asked to review and");
    expect(html).not.toContain(CLAUSE);
  });

  test("and neither flag was sent, so it says only what it knows", () => {
    // Both are optional on the spec. Absent is not `false`; a caller that has
    // not looked at the approvals must not have a claim made on its behalf.
    const html = render({ ...waiting });
    expect(html).toContain("was asked to review and");
    expect(html).not.toContain(CLAUSE);
  });
});

/*
 * It warns. It does not block.
 *
 * There are good reasons to land ahead of a review you asked for and the panel
 * does not know which day this is. What it must not do is let the press happen
 * without the fact on screen — and equally, having put the fact on screen, it
 * must not then take the decision away.
 */
describe("the warning does not take the button away", () => {
  test("the confirm button is untouched by it, to the character", () => {
    /*
     * The two renders differ ONLY in `awaitingReview`, so comparing the button's
     * own tag between them is the whole claim: whatever that button's state is,
     * the warning did not change it. Stronger than reading the `disabled`
     * expression, and it does not care how the expression is spelled.
     */
    const quiet = render();
    const warned = render({ awaitingReview: ["d-okafor", "p-navarro"] });
    expect(warned).toContain("were asked to review and");
    expect(confirm(warned)).toBe(confirm(quiet));
  });

  test("and it is genuinely pressable with a warning on screen", () => {
    /*
     * The comparison above is airtight and would survive both buttons being
     * dead, so here is one that is actually enabled. It is a REBASE because
     * `renderToStaticMarkup` runs no effects: the subject field is prefilled by
     * one, so under a static render a squash's subject is empty and its button
     * is honestly disabled for a reason that has nothing to do with reviews.
     * Rebase writes no commit message, so its button depends on nothing but the
     * dialog being open — which makes it the one method where "still pressable"
     * is a statement about the warning.
     */
    const html = renderToStaticMarkup(React.createElement(MergeDialog, {
      pending: spec({ method: "rebase", awaitingReview: ["d-okafor", "p-navarro"] }),
    }));
    expect(html).toContain("were asked to review and");
    expect(dead(confirm(html, "Rebase and merge"))).toBe(false);
  });
});
