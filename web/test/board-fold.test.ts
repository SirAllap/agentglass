/*
 * A folded lane gives back its width and keeps its number.
 *
 * The board demands `5 × 268 + 4 × 10 + 32 = 1412` CSS pixels. His screen at
 * 175% zoom leaves 1170 — which is why the cards in his screenshot wrap to two
 * lines and the last one is cut off by the column's edge. A lane folded from
 * 268 to 44 gives back 224 plus its gap, so TWO folded lanes bring the minimum
 * under 1000: below his real width, with no breakpoint and nothing moving on
 * its own.
 *
 * FOLDING IS NOT FILTERING, and this board already refused that twice in
 * writing. Eight printed numbers derive from the flattened partition rather
 * than from what is drawn — the headline "22 of 391", the "9 can land right
 * now", each segment count, the footer. If a fold subtracted, all eight go
 * wrong at once and the footer becomes a lie: those pull requests still want
 * something from you, you just stopped looking. Every fold in this app that
 * hides something countable keeps the number on the folded header, and one of
 * them states it as law: "the count is the whole point of a folded row".
 *
 * Rendered, not read from source, because these are claims about what ends up
 * on screen. The stubs go in before the import and come back out after: one
 * process runs every file in this suite, and a `localStorage` left behind is
 * one the next file inherits.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrSummary } from "../../shared/types.ts";
import { forgetCards } from "../src/lib/prCardStore.ts";
const stubGlobal = globalStubs();

const cell = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, String(v)); },
  removeItem: (k: string) => { cell.delete(k); },
});

const { TriageBoard } = await import("../src/components/TriageBoard.tsx");
const { readTip } = await import("../src/lib/tip.ts");
const { LANE_WIDTH_PX } = await import("../src/lib/prSearch.ts");
const { ALWAYS_OPEN, foldedLanes, setFoldedLanes, walkable } = await import("../src/lib/boardPrefs.ts");

/** The board's own fixture, copied from triage-board.test.ts rather than
 *  invented: the first draft here left `labels` off and React threw inside the
 *  renderer, which is a slow way to learn what a component reads. */
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const pr = (number: number, o: Partial<PrSummary> = {}): PrSummary => ({
  number, title: `pull request ${number}`, author: "someone", state: "OPEN", isDraft: false,
  headRefName: `h${number}`, baseRefName: "main", url: "", updatedAt: iso(1),
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1,
  labels: [], assignees: [], milestone: null,
  checks: {
    total: 3, success: 3, failure: 0, skipped: 0, pending: 0,
    allDone: true, verdict: "green", failing: [],
  },
  ...o,
} as unknown as PrSummary);

const render = (props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(TriageBoard as never, {
    mine: [], review: [], total: 0, hasTaskProvider: false,
    pinned: () => false, onOpen: () => {}, onTogglePin: () => {},
    onShowTable: () => {}, onAct: () => {},
    ...props,
  } as never));

/** One lane's column, from its own marker to the next one's. */
const column = (html: string, lane: string): string => {
  const start = html.indexOf(`data-lane="${lane}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-lane=", start + 10);
  return next < 0 ? html.slice(start) : html.slice(start, next);
};
const drawn = (html: string, lane: string): number => (column(html, lane).match(/data-pr="/g) ?? []).length;

/* The card store is an ambient input to every render here: a lookup another
   file queued lands in it, and a row's own five-hour-old reading is then
   replaced by a fresh one — which is what the rows below are asserting the age
   of. Cleared so these draw from the row and nothing else. */
beforeEach(() => { cell.clear(); forgetCards(); });

describe("what is remembered", () => {
  test("nothing folded is stored as nothing, not as an empty list", () => {
    // A default worth writing down is a default that will disagree with the
    // code the day the default changes.
    setFoldedLanes(["land"]);
    expect(cell.size).toBe(1);
    setFoldedLanes([]);
    expect(cell.size).toBe(0);
  });

  test("a fold for a lane that no longer exists is dropped on read", () => {
    // Reconciled against the catalogue, the way taskSources.ts does it, so a
    // renamed lane cannot leave a fold pointing at nothing.
    setFoldedLanes(["land", "a-lane-that-was-removed"]);
    expect(foldedLanes(["review", "land", "blocked"])).toEqual(["land"]);
  });

  test("and the key is the app's own spelling", () => {
    // Eleven container folds, four state shapes, three namespaces. This one
    // joins the majority instead of being the twelfth.
    setFoldedLanes(["land"]);
    expect([...cell.keys()]).toEqual(["agentglass.pr.lanes"]);
  });

  test("stores what is SHUT, so a lane added tomorrow arrives open", () => {
    setFoldedLanes(["land"]);
    expect(JSON.parse(cell.get("agentglass.pr.lanes")!)).toEqual(["land"]);
  });
});

describe("a folded lane", () => {
  const withCards = { mine: [pr(1), pr(2), pr(3)], review: [], total: 40 };

  test("draws none of its cards", () => {
    const open = render(withCards);
    const openCards = drawn(open, "flight");
    expect(openCards, "the lane has cards to hide").toBeGreaterThan(0);

    cell.set("agentglass.pr.lanes", JSON.stringify(["flight"]));
    expect(drawn(render(withCards), "flight")).toBe(0);
  });

  test("but still says how many it holds", () => {
    // The whole bargain. A fold that swallowed the number would be the filter
    // this board refuses to become.
    cell.set("agentglass.pr.lanes", JSON.stringify(["flight"]));
    const html = column(render(withCards), "flight");
    expect(html).toContain(">3<");
  });

  test("and still says which lane it is", () => {
    // "34 pixels of nothing but the button that unfolds it — asked about as
    // 'is it normal that nothing shows'."
    cell.set("agentglass.pr.lanes", JSON.stringify(["flight"]));
    expect(column(render(withCards), "flight").toLowerCase()).toContain("in flight");
  });

  test("takes 44px instead of the lane width", () => {
    cell.set("agentglass.pr.lanes", JSON.stringify(["flight"]));
    const html = render(withCards);
    expect(html).toContain("44px");
    // And the open ones are a fixed width, not a share of the window: the old
    // `minmax(268px, 1fr)` squeezed them when the window narrowed.
    expect(html).toContain(`${LANE_WIDTH_PX}px`);
    expect(html).not.toContain("minmax(268px, 1fr)");
  });

  test("the lane strip is as wide as its lanes and the scroller around it goes sideways", () => {
    const html = render(withCards);
    expect(html).toContain("overflow-x-auto");
    // The card is 336px and never shrinks, so a lane is a fixed column (the card and its gutter), not a share of the window: a wide window leaves room at the end, a narrow one scrolls.
    expect(html).toMatch(new RegExp(`grid-template-columns:[^"]*${LANE_WIDTH_PX}px`));
    expect(html).not.toMatch(/grid-template-columns:[^"]*1fr/);
    expect(html).toMatch(/min-width:\d+px/);
    // `w-max` sized the 1fr tracks to the widest card (442px measured), not to the floor.
    expect(html).not.toContain("w-max");
  });
});

describe("the lane that cannot be folded", () => {
  test("has no fold control at all", () => {
    // Not a disabled one: a control that is drawn and refuses is a control
    // somebody presses twice before believing it.
    const html = column(render({ review: [pr(9)], total: 9 }), ALWAYS_OPEN);
    expect(html).not.toContain("aria-expanded=\"true\"");
  });

  test("folds like any other when it is EMPTY", () => {
    /* The half the first version got wrong. The argument for never folding this
       lane is entirely about a lane that is asking you for something; at zero it
       asks nothing, and it was still taking 268px of a board that does not fit
       five columns — a lane that cannot be folded under a heading reading
       `0 NEEDS YOUR REVIEW`. */
    const empty = { mine: [pr(1)], review: [], total: 40 };
    /* Counted rather than matched on one attribute: `column()` cuts from this
       lane's marker to the next one's, and what distinguishes "offers a fold"
       from "does not" is whether that slice holds the control at all. */
    const controls = (html: string) => (column(html, ALWAYS_OPEN).match(/<button/g) ?? []).length;
    expect(controls(render(empty)), "an empty review lane offers the fold").toBeGreaterThan(0);

    cell.set("agentglass.pr.lanes", JSON.stringify([ALWAYS_OPEN]));
    expect(render(empty)).toContain("44px");
  });

  test("but reopens the moment a review lands in it", () => {
    /* A fold stored while it was empty must not survive the arrival of work:
       a 44px strip with a review behind it is the harm ALWAYS_OPEN exists to
       prevent, reached by another route. */
    cell.set("agentglass.pr.lanes", JSON.stringify([ALWAYS_OPEN]));
    expect(drawn(render({ review: [pr(9)], total: 9 }), ALWAYS_OPEN)).toBe(1);
  });

  test("and a stored fold for it is ignored while it holds something", () => {
    // The board exists for this lane. Folding it hides the only column that is
    // asking for something — the same reason Docker reopens a broken stack and
    // the tool feed refuses to fold a failure.
    cell.set("agentglass.pr.lanes", JSON.stringify([ALWAYS_OPEN]));
    expect(drawn(render({ review: [pr(9)], total: 9 }), ALWAYS_OPEN)).toBe(1);
  });
});

describe("what the find walks", () => {
  /*
   * The half a render cannot show, and the half that had no test at all: a
   * cursor on a card behind a 44px strip looks exactly like a cursor on a
   * card. Deleting the guard left every other assertion in this file green,
   * which is how a hole this shape stays open.
   */
  const cards = [1, 2, 3, 4, 5, 6, 7, 8];

  test("nothing, when the lane is folded", () => {
    expect(walkable(cards, { folded: true, opened: false, cap: 6 })).toEqual([]);
  });

  test("even when the lane was opened past its cap first", () => {
    // Folding beats opening: the cards are on screen in neither case.
    expect(walkable(cards, { folded: true, opened: true, cap: 6 })).toEqual([]);
  });

  test("the capped rows when it is open", () => {
    expect(walkable(cards, { folded: false, opened: false, cap: 6 })).toHaveLength(6);
  });

  test("and all of them when the lane is opened", () => {
    expect(walkable(cards, { folded: false, opened: true, cap: 6 })).toHaveLength(8);
  });
});

/*
 * One size, and the same shape in both states.
 *
 * The card's header drew three controls side by side at three sizes: the copy
 * mark inside the number chip at `fontSize: 9`, the link at 14px of vector two
 * lines below it, and the pin at `fontSize: 15`. Reported as "some icons are
 * very big, others very small", and this row is where it shows worst — a
 * character paints about 60% of what its size promises, so the nine landed near
 * five against the fourteen. Written as a 1.56× difference; seen as about 2.5×.
 *
 * The second half is quieter and worse: each of the three swapped one CHARACTER
 * for a different one when it changed state — `⧉`→`✓`, `☆`→`★` — and two
 * characters are not the same width. The card moved at the exact moment you
 * pressed it, which is the moment you are looking at it.
 */
describe("the card's header", () => {
  const card = () => render({ mine: [pr(7)], total: 1 });

  test("draws no typographic glyphs where an icon belongs", () => {
    const html = card();
    for (const glyph of ["⧉", "☆", "★"]) {
      expect(html, `still drawing ${glyph}`).not.toContain(glyph);
    }
  });

  test("and no hand-set font sizes in place of an icon size", () => {
    // `fontSize: 9` and `fontSize: 15` were the two ends of the spread. Neither
    // is on the app's ladder, and neither is a size anybody chose twice.
    const html = card();
    expect(html).not.toContain("font-size:9px");
    expect(html).not.toContain("font-size:15px");
  });

  test("the pin and the link are the same size as each other", () => {
    /*
     * Scoped to the two controls that sit side by side in the footer's last slot, and not
     * to every icon on the card — the first draft of this assertion counted
     * the whole card, saw 12, 14 and 16, and failed on a difference that is
     * the design: the mark inside the number chip is 12 because it sits beside
     * 10px type, and 16 belongs to a control in another row entirely.
     *
     * What reads as carelessness is not a spread across a card. It is two
     * ADJACENT controls, in identical boxes, drawn at different sizes.
     */
    const boxes = [...card().matchAll(/<button[^>]*aria-label="(?:Copy the link to|Pin|Unpin)[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    expect(boxes.length, "the pin and the link, in their one square").toBe(2);
    const sizes = boxes.map((b) => b.match(/width="(\d+)"/)?.[1]);
    expect(new Set(sizes).size, `drawn at ${sizes.join(" and ")}`).toBe(1);
  });
});

/*
 * THE CARD SAYS WHAT A PERSON DECIDED.
 *
 * A card for a pull request approved sixteen hours earlier once read as
 * `2 failing -> master` and nothing else: it led with the checks and had no
 * review state on it at all. The board already carried `reviewDecision` in the
 * list it draws from, and the answer has to be on screen.
 *
 * Both directions are locked. An approval that is not drawn is the bug; a
 * "changes asked" that is not drawn is the same bug pointing the other way,
 * and the more expensive one, because it is the state where the pull request
 * is waiting on YOU rather than on CI.
 *
 * The card (direction "Facet") says it in three places: one sentence in the
 * verdict strip, one word in the Review cell, and a face per person whose
 * tooltip says what that person did. The decisions are walked in
 * pr-card-view.test.ts; this is that they reach the screen.
 */
const V = (kind: string, o: Record<string, unknown> = {}) =>
  ({ kind, who: ["okoro"], ...o }) as unknown as PrSummary["humanReview"];

/** One card, from its own marker to the next one's. */
const cardHtml = (o: Partial<PrSummary>, props: Record<string, unknown> = {}, n = 7): string => {
  const html = render({ mine: [pr(n, o)], total: 1, hasTaskProvider: true, ...props });
  const i = html.indexOf(`data-pr="${n}"`);
  return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i));
};
const strip = (html: string): string => html.match(/<span class="agx-cd-v">([^<]*)</)?.[1] ?? "";
const cellOf = (html: string, label: string): { word: string; tone: string } => {
  const at = html.indexOf(`<span class="agx-cd-lb">${label}</span>`);
  const open = html.lastIndexOf("data-tone=\"", at);
  return {
    word: html.slice(at).match(/<span class="agx-cd-vl">([^<]*)</)?.[1] ?? "",
    tone: html.slice(open + 11, html.indexOf('"', open + 11)),
  };
};
/** Every tooltip on the card, as the tooltip reads it. */
const tips = (html: string): { name: string; text?: string; detail?: string }[] =>
  [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => readTip(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x27;/g, "'")));

describe("the verdict a card leads with", () => {
  test("approved: the Review cell says approved in green and the face says who", () => {
    const html = cardHtml({ humanReview: V("approved") });
    expect(cellOf(html, "Review")).toEqual({ word: "approved", tone: "ok" });
    expect(tips(html)).toContainEqual({ name: "okoro", text: "approved" });
  });

  test("changes requested: the same weight as an approval, in red", () => {
    // Both are a word with a name behind it. One was a band and the other a grey
    // line, which is the inconsistency that was reported.
    const html = cardHtml({ humanReview: V("changes") });
    expect(cellOf(html, "Review")).toEqual({ word: "changes", tone: "bad" });
    expect(tips(html)).toContainEqual({ name: "okoro", text: "changes requested" });
  });

  test("warns when the approval no longer covers the code", () => {
    /* The dangerous state: the row says approved and the reviewer approved
       something else. GitHub says so on the PR's own page; the board did not. */
    const html = cardHtml({ humanReview: V("approved", { stale: true }), reviewDecision: "REVIEW_REQUIRED" } as Partial<PrSummary>);
    expect(strip(html)).toBe("Approved \u00b7 new commits since");
    expect(cellOf(html, "Review")).toEqual({ word: "stale", tone: "run" });
  });

  test("but stays green while GitHub still counts it and nobody has been asked again", () => {
    const html = cardHtml({ humanReview: V("approved", { stale: true }), reviewDecision: "APPROVED" } as Partial<PrSummary>);
    expect(strip(html)).toBe("Approved \u00b7 new commits since");
    expect(cellOf(html, "Review")).toEqual({ word: "approved", tone: "ok" });
  });

  test("a stale approval that was asked again is amber, and says so on the face", () => {
    const people = [{ login: "okoro", state: "again" }];
    const html = cardHtml({ humanReview: V("approved", { stale: true, askedAgain: true, people }), reviewDecision: "APPROVED" } as Partial<PrSummary>);
    expect(cellOf(html, "Review").tone).toBe("run");
    expect(tips(html)).toContainEqual({ name: "okoro", text: "re-review requested" });
  });

  test("speaks of YOU when the review is asked of you", () => {
    const asked = pr(7, { author: "mara-k", humanReview: V("awaiting", { mine: true, people: [{ login: "someone", state: "await" }] }) });
    const html = render({ review: [asked], total: 1 });
    expect(strip(html.slice(html.indexOf('data-pr="7"')))).toBe("mara-k wants your review");
  });

  test("two people owe an answer: the sentence counts them and each has a face with its ring", () => {
    // One asked again after changes, one never answered: the case the strip used to name one of.
    const html = cardHtml({ humanReview: V("changes", { cleared: true, askedAgain: true, who: ["tlindqvist"],
      people: [{ login: "tlindqvist", state: "again" }, { login: "rnakamura", state: "await" }] }) });
    expect(strip(html)).toBe("Waiting on 2 reviewers");
    expect(tips(html)).toContainEqual({ name: "tlindqvist", text: "re-review requested" });
    expect(tips(html)).toContainEqual({ name: "rnakamura", text: "review requested, not answered yet" });
    expect(html).toContain('data-state="again"');
    expect(html).toContain('data-state="await"');
  });

  test("one person owing an answer keeps the sentence that names them", () => {
    expect(strip(cardHtml({ humanReview: V("awaiting", { who: ["mkovac"], people: [{ login: "mkovac", state: "await" }] }) }))).toBe("Waiting on mkovac");
  });

  test("changes requested keeps its sentence while the others still get their faces", () => {
    const html = cardHtml({ humanReview: V("changes", { who: ["tlindqvist"], people: [
      { login: "tlindqvist", state: "changes" }, { login: "rnakamura", state: "await" }, { login: "ofarah", state: "approved" }] }) });
    expect(strip(html)).not.toContain("Waiting on 2 reviewers");
    expect(html.match(/data-state="(changes|await|approved)"/g)).toHaveLength(3);
    expect(tips(html).filter((t) => ["tlindqvist", "rnakamura", "ofarah"].includes(t.name)).length).toBeGreaterThanOrEqual(3);
  });

  test("five waiting: one face and a +4 in the Review cell, two and a +3 in the strip, every name in the tooltip", () => {
    const people = ["a1", "b2", "c3", "d4", "e5"].map((login) => ({ login, state: "await" }));
    const html = cardHtml({ humanReview: V("awaiting", { who: people.map((x) => x.login), people }) });
    expect(strip(html)).toBe("Waiting on 5 reviewers");
    expect(html).toContain(">+4<");
    expect(html).toContain(">+3<");
    expect(cellOf(html, "Review")).toEqual({ word: "5 waiting", tone: "run" });
  });

  test("a row from before `people` existed still draws the faces it did", () => {
    const html = cardHtml({ humanReview: V("awaiting", { who: ["a1", "b2"] }) });
    expect(html.match(/data-state="await"/g)).toHaveLength(4);
    expect(strip(html)).toBe("Waiting on 2 reviewers");
  });

  test("says when a follow-up round has already been asked for", () => {
    /*
     * Applying a review and pressing "Re-request review" used to leave this
     * card reading exactly as it had before either happened as if nothing had
     * moved. The review still blocks, same as GitHub's own page; the face says
     * the other half GitHub's page ALSO shows: their own re-request mark.
     */
    const people = [{ login: "okoro", state: "again" }];
    expect(tips(cardHtml({ humanReview: V("changes", { askedAgain: true, people }) }))).toContainEqual({ name: "okoro", text: "re-review requested" });
    expect(tips(cardHtml({ humanReview: V("changes") }))).not.toContainEqual({ name: "okoro", text: "re-review requested" });
  });

  test("a draft says nobody has been asked", () => {
    // It was a label lost among the others; a draft is waiting on no one.
    expect(strip(cardHtml({ isDraft: true }))).toBe("Draft \u00b7 not asked yet");
    expect(cellOf(cardHtml({ isDraft: true }), "Review").word).toBe("nobody asked");
  });

  test("says nobody has been asked, rather than drawing nothing", () => {
    /*
     * This drew no header at all, on the argument that one saying "nothing"
     * steals weight from the ones that say something. Right about weight, wrong
     * about the card: the row came out visibly shorter than every other in the
     * lane, and a column of two shapes is a column you re-read. It states the
     * real state rather than a placeholder.
     */
    const html = cardHtml({ humanReview: null });
    expect(strip(html)).toBe("Open · nobody asked yet");
    expect(cellOf(html, "Review").word).toBe("nobody asked");
    for (const word of ["Approved", "Changes requested", "Waiting on"]) {
      expect(strip(html), `claimed "${word}" over an unreviewed pull request`).not.toContain(word);
    }
  });

  test("every state carries a glyph, not colour alone", () => {
    // The strip's icon is a shape: each state leaves a different drawing on the card.
    const icon = (o: Partial<PrSummary>) => {
      const html = cardHtml(o);
      return html.slice(html.indexOf('class="agx-cd-h"'), html.indexOf('<span class="agx-cd-v">')).match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
    };
    const shapes = [icon({ humanReview: V("approved"), reviewDecision: "APPROVED" } as Partial<PrSummary>), icon({ humanReview: V("changes"), reviewDecision: "CHANGES_REQUESTED" } as Partial<PrSummary>), icon({ humanReview: V("awaiting", { people: [{ login: "okoro", state: "await" }] }) })];
    for (const sh of shapes) expect(sh.length).toBeGreaterThan(0);
    expect(new Set(shapes).size).toBe(3);
  });

  test("an approved card still shows its failing checks", () => {
    /* Approved does not mean mergeable, and a card that dropped the red to
       celebrate the tick would be the same lie in the other direction. */
    const html = cardHtml({
      humanReview: V("approved"),
      checks: { total: 3, success: 1, failure: 2, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [] },
    } as Partial<PrSummary>);
    expect(strip(html)).toBe("2 checks failing");
    expect(cellOf(html, "Review").word).toBe("approved");
  });
});

/*
 * WHAT ELSE THE ROW HAS TO SAY.
 *
 * Two facts the board had in hand and did not draw: a green pull request that
 * conflicts with its base reads as ready to merge, and the tracker card's own
 * state lived three clicks away in another view.
 */
describe("the rest of the card's row", () => {
  test("says when it conflicts with the base", () => {
    /* `mergeable` was put on the summary precisely because the board files by
       what a row NEEDS, and then the card never drew it. */
    const html = cardHtml({ mergeable: "CONFLICTING" } as Partial<PrSummary>);
    expect(strip(html)).toBe("Conflicts with main");
    expect(cellOf(html, "Branch")).toEqual({ word: "conflict", tone: "bad" });
  });

  test("but not while GitHub is still working it out", () => {
    // `UNKNOWN` is "not computed yet". A conflict warning that flashes on and
    // off is worse than none.
    expect(strip(cardHtml({ mergeable: "UNKNOWN" } as Partial<PrSummary>))).not.toContain("Conflicts");
    expect(cellOf(cardHtml({ mergeable: "UNKNOWN" } as Partial<PrSummary>), "Branch").word).not.toBe("conflict");
    expect(cellOf(cardHtml({ mergeable: "MERGEABLE" } as Partial<PrSummary>), "Branch").word).not.toBe("conflict");
  });

  test("shows the tracker card's state in the ticket row", () => {
    const html = cardHtml({
      headRefName: "ORBIT-1042-a-thing",
      card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "ready for qa", priority: "high" },
    } as Partial<PrSummary>);
    expect(html).toContain("<span>ready for qa</span>");
  });

  test("and draws nothing about it when the boards have not seen it", () => {
    /* Absent is "we have not seen this card", which is not "it has no status" —
       the difference between honest and inventing one. */
    expect(cardHtml({ headRefName: "ORBIT-9999-a-thing" } as Partial<PrSummary>)).not.toContain("ready for qa");
  });
});

/*
 * A ROW FROM THE OTHER SIDE OF AN INSTALL STILL DRAWS.
 *
 * `humanReview` changed from a bare string to an object, and the card read
 * `v.who.slice(...)` straight off it. A page held open across the install got a
 * row with the old shape and the whole view died:
 *
 *     Pull requests stopped drawing.
 *     Cannot read properties of undefined (reading 'slice')
 *
 * The board is the wrong place to learn that a field changed shape. Anything
 * that crossed a wire is checked rather than assumed.
 */
describe("a verdict in a shape this build did not write", () => {
  test("the old string still draws, without a name", () => {
    const html = cardHtml({ humanReview: "approved" } as unknown as Partial<PrSummary>);
    expect(html).toContain('data-pr="7"');
    expect(strip(html)).not.toBe("");
    expect(tips(html).filter((t) => t.text === "approved"), "no name to give, so none is invented").toEqual([]);
  });

  test("an object with no `who` does not take the view down", () => {
    expect(cardHtml({ humanReview: { kind: "changes" } } as unknown as Partial<PrSummary>)).toContain('data-pr="7"');
  });

  test("and something unrecognisable draws the card rather than throwing", () => {
    expect(() => cardHtml({ humanReview: { who: ["a"] } } as unknown as Partial<PrSummary>)).not.toThrow();
    expect(() => cardHtml({ humanReview: 42 } as unknown as Partial<PrSummary>)).not.toThrow();
  });
});

/*
 * THE LAST FIVE OF THE TWENTY-ONE.
 *
 * Facts the board had in hand and threw away, and one gesture that worked in
 * the pull request panel and did nothing here.
 */
describe("what the card finally says", () => {
  const withCard = (extra: Record<string, unknown>) => ({
    headRefName: "ORBIT-1042-a-thing",
    card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "ready for qa", priority: "high", ...extra },
  } as unknown as Partial<PrSummary>);

  test("marks a card that says done under a pull request still open", () => {
    /* The pair that starts a conversation, and reading it meant crossing two
       screens by hand. */
    const html = cardHtml(withCard({ status: "closed", statusKind: "done" }));
    expect(html).toContain('class="agx-cd-odd"');
    expect(tips(html)).toContainEqual({ name: "closed", text: "The card says this while the pull request is still open." });
  });

  test("and says nothing when the two agree", () => {
    expect(cardHtml(withCard({ statusKind: "open" }))).not.toContain("agx-cd-odd");
  });

  test("names who the card is on in the ticket's tooltip", () => {
    /* ClickUp's people, not GitHub logins: a name on a tracker board is not a
       username on a forge, and `<Avatar login="Grace Hopper">` draws a blank
       circle. */
    const html = cardHtml(withCard({ people: [{ name: "Antonio", initials: "AG", color: "#7b68ee" }] }));
    expect(tips(html).some((t) => t.name === "ORBIT-1042" && t.text?.includes("On Antonio."))).toBe(true);
  });

  test("says so in words when nothing has moved in over a week", () => {
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    expect(tips(cardHtml({ updatedAt: old, humanReview: V("awaiting", { people: [{ login: "okoro", state: "await" }] }) }))
      .some((t) => t.name === "Last activity" && !!t.text?.includes("9 days without activity"))).toBe(true);
  });

  test("but not on one that moved yesterday", () => {
    const fresh = new Date(Date.now() - 86_400_000).toISOString();
    expect(tips(cardHtml({ updatedAt: fresh })).some((t) => t.text?.includes("days without activity"))).toBe(false);
  });

  test("the card's id is a button that opens it", () => {
    expect(cardHtml(withCard({}))).toContain("Open ORBIT-1042 in Tasks");
  });
});

describe("the card's own line", () => {
  const withCard = (extra: Record<string, unknown>) => ({
    headRefName: "ORBIT-1042-a-thing",
    card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "code review", priority: "normal", ...extra },
  } as unknown as Partial<PrSummary>);

  test("carries the id, the state and the three copy buttons together", () => {
    const html = cardHtml(withCard({ url: "https://tracker.example/ORBIT-1042" }));
    expect(html).toContain("ORBIT-1042");
    expect(html).toContain("<span>code review</span>");
    for (const label of ["Copy card ID", "Copy card name", "Copy card link"]) expect(html, label).toContain(`aria-label="${label} for ORBIT-1042"`);
  });

  test("and a way straight into the card", () => {
    expect(cardHtml(withCard({}))).toContain("Open ORBIT-1042 in Tasks");
  });

  test("the flag is not welded to the number", () => {
    /* Reported looking at it: the flag sat against the id with nothing between
       them. The stylesheet's gap on the id button is what puts the air back. */
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.agx-cd-tk \{[^}]*gap: \d+px/);
  });
});

/*
 * ONE CHIP PER CARD, NOT TWO.
 *
 * The card's id was drawn twice, four lines apart on the same card. The ticket
 * row wins: it has the state and the copy buttons too.
 */
describe("the card id is not drawn twice", () => {
  test("once, when the card is known", () => {
    const html = cardHtml({
      headRefName: "ORBIT-1042-a-thing",
      card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "in development", priority: "normal" },
    } as unknown as Partial<PrSummary>);
    expect((html.match(/class="agx-cd-tk"/g) ?? []).length, "one id button for the card, not two").toBe(1);
    expect(html).toContain("<span>in development</span>");
  });

  test("and the row still shows the id when the boards have never seen the card", () => {
    /* A branch naming a card nobody has cached: the id is all there is, and it
       is still worth showing. */
    const html = cardHtml({ headRefName: "ORBIT-9999-a-thing" } as Partial<PrSummary>);
    expect(html).toContain("ORBIT-9999");
    expect(html).toContain("<span>not found</span>");
  });
});

/*
 * A CACHED STATUS SAYS HOW OLD IT IS.
 *
 * The boards this reads are refreshed when somebody opens the tasks view, not
 * on a timer, so a row can be hours stale. It showed a card as "in development,
 * assigned to him" while the tracker had it in "code review" on somebody else —
 * a wrong status is not a smaller version of no status, it is a different fact,
 * and it was drawn on a row that gets glanced at.
 *
 * Not hidden: a reading from this morning is still useful. Just never presented
 * as current when it is not.
 */
describe("how fresh the card's status is", () => {
  const card = (at?: number) => ({
    headRefName: "ORBIT-1042-a-thing",
    card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "code review", priority: "normal", at },
  } as unknown as Partial<PrSummary>);

  test("a fresh reading is stated plainly", () => {
    const html = cardHtml(card(Date.now() - 5 * 60_000));
    expect(html).toContain("<span>code review</span>");
    expect(html, "nothing to warn about").not.toContain("data-stale");
  });

  test("an old one dims and says when it was read", () => {
    const html = cardHtml(card(Date.now() - 5 * 60 * 60_000));
    expect(html).toContain('data-stale="1"');
    expect(tips(html).some((t) => t.name === "code review" && !!t.text?.includes("5h ago"))).toBe(true);
  });

  test("and the tooltip never claims it is current", () => {
    /* "was in ... when this board was read" rather than "is in". The wording is
       the whole guarantee. */
    expect(tips(cardHtml(card(Date.now() - 3 * 60 * 60_000))).some((t) => t.text?.startsWith("The card was in"))).toBe(true);
  });
});

/*
 * THE TRACKER BLOCK IS DRAWN PER REPOSITORY.
 *
 * In a repository that links work items, a pull request with no card still
 * holds the block's place — the honest answer to what the line asks is "no
 * card", not silence — so a lane does not hold two heights. In a repository
 * that never links one, nothing is drawn and nothing is held: the card is the
 * pull request. The rule is prCardBlock.ts; this is that it reaches the screen.
 */
describe("the tracker block is there in a tracker repository, and only there", () => {
  const TRACKED = pr(8, { headRefName: "ORBIT-1042-a-thing" });
  const inCard = (o: Partial<PrSummary>, others: PrSummary[] = [TRACKED]) => {
    const html = render({ mine: [pr(7, o), ...others], total: 2, hasTaskProvider: true });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf('data-pr="8"', i) > 0 ? html.indexOf('data-pr="8"', i) : undefined);
  };

  test("says so when this pull request names no card but its repository links them", () => {
    expect(inCard({ headRefName: "chore/release-notes" })).toContain("No card");
    expect(tips(inCard({ headRefName: "chore/release-notes" }))).toContainEqual({ name: "No card linked", text: "Nothing in Tasks points to this pull request yet." });
  });

  test("and tells that apart from a card nobody has cached", () => {
    /* Two different facts: "this work has no card" and "we have not seen the
       card this names". Drawing both as silence loses the second. */
    const html = inCard({ headRefName: "ORBIT-9999-a-thing" });
    expect(html).toContain("<span>not found</span>");
    expect(tips(html).some((t) => t.name === "Card not found")).toBe(true);
  });

  test("but says neither while the row is still arriving", () => {
    // That is the skeleton's job; a card mid-flight has not failed to find
    // anything yet.
    const html = inCard({ headRefName: "ORBIT-9999-a-thing", checksLoaded: false } as Partial<PrSummary>);
    expect(html).not.toContain("<span>not found</span>");
    expect(html).not.toContain("No card");
  });

  test("draws nothing, and holds no place, in a repository that links no cards", () => {
    const html = inCard({ headRefName: "chore/release-notes" }, [pr(8, { headRefName: "fix/retry-worker" })]);
    expect(html).not.toContain("agx-cd-tk");
    expect(html).not.toContain("No card");
  });

  test("and not when nothing is connected, whatever the branches say", () => {
    const html = render({ mine: [pr(7, { headRefName: "ORBIT-1042-a-thing" })], total: 1, hasTaskProvider: false });
    /* It says so, in a dashed slot of the same height, instead of drawing a card, an id or a hint it cannot back. */
    expect(html).toContain("No tracker");
    expect(html).not.toContain("<span>not found</span>");
    expect(html).not.toContain("Open ORBIT-1042 in Tasks");
  });
});

/*
 * `undefined` IS NOT `false`.
 *
 * `checksLoaded` has three states and they mean different things: `false` is
 * "the second pass is still coming", `true` is "it arrived", and `undefined` is
 * "this row was never built in two passes at all". A guard written `!== true`
 * folds the last two together and leaves a skeleton on screen for ever on any
 * caller that fetches in one go.
 */
describe("the three states of a half-built row", () => {
  test("still coming: a skeleton, claiming nothing", () => {
    const html = cardHtml({ humanReview: null, checksLoaded: false } as Partial<PrSummary>);
    expect(html).not.toContain("No review asked for yet");
    expect(html).toContain('class="agx-cd-sk"');
  });

  test("never two-passed: the real answer, not a skeleton for ever", () => {
    expect(strip(cardHtml({ humanReview: null }))).toBe("Open · nobody asked yet");
  });

  test("arrived with nothing: the real answer too", () => {
    expect(strip(cardHtml({ humanReview: null, checksLoaded: true } as Partial<PrSummary>))).toBe("Open · nobody asked yet");
  });
});

/*
 * THE STRIP CANNOT DISAPPEAR.
 *
 * Reported five times in one afternoon, each time as "it loses the header on
 * reload", and each time the answer was a different missing piece: a field
 * dropped by the client's merge, a verdict that fell outside the ten reviews
 * fetched, a guard that mistook `undefined` for "still loading". Every one of
 * them fixed, and the sixth would have been another.
 *
 * So the property is stated directly rather than reached: whatever the row is,
 * the card draws a strip. Loading is a skeleton, unreviewed says so, a draft
 * says so, a malformed verdict falls back.
 */
describe("whatever the row looks like", () => {
  const shapes: [string, Partial<PrSummary>][] = [
    ["nothing at all", {}],
    ["still loading", { checksLoaded: false } as Partial<PrSummary>],
    ["loaded, nobody asked", { checksLoaded: true, humanReview: null } as Partial<PrSummary>],
    ["a draft", { isDraft: true }],
    ["approved", { humanReview: { kind: "approved", who: ["a"] } } as unknown as Partial<PrSummary>],
    ["the old string shape", { humanReview: "approved" } as unknown as Partial<PrSummary>],
    ["a verdict with no who", { humanReview: { kind: "changes" } } as unknown as Partial<PrSummary>],
    ["something unrecognisable", { humanReview: 42 } as unknown as Partial<PrSummary>],
  ];

  for (const [name, o] of shapes) {
    test(`there is a strip: ${name}`, () => {
      const html = cardHtml(o);
      const at = html.indexOf('class="agx-cd-h"');
      expect(at, `no strip for: ${name}`).toBeGreaterThan(0);
      /* The strip says a sentence, or holds its place with the skeleton while the second pass is out. */
      expect(html.slice(at, at + 600), name).toMatch(/class="agx-cd-v"|class="agx-cd-sk"/);
    });
  }
});
