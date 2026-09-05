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
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrSummary } from "../../shared/types.ts";

const priorStorage = (globalThis as { localStorage?: unknown }).localStorage;
const cell = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, String(v)); },
  removeItem: (k: string) => { cell.delete(k); },
};
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = priorStorage; });

const { TriageBoard } = await import("../src/components/TriageBoard.tsx");
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

beforeEach(() => cell.clear());

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

  test("takes 44px instead of 268", () => {
    cell.set("agentglass.pr.lanes", JSON.stringify(["flight"]));
    const html = render(withCards);
    expect(html).toContain("44px");
    // And the open ones keep their floor: 268 is where a title stops wrapping.
    expect(html).toContain("minmax(268px, 1fr)");
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
       five columns. Reported looking straight at it: "no puedo plegar la primera
       columna", under a heading reading `0 NEEDS YOUR REVIEW`. */
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

describe("what the keyboard walks", () => {
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
     * Scoped to the two controls that sit side by side in 26×26 boxes, and not
     * to every icon on the card — the first draft of this assertion counted
     * the whole card, saw 12, 14 and 16, and failed on a difference that is
     * the design: the mark inside the number chip is 12 because it sits beside
     * 10px type, and 16 belongs to a control in another row entirely.
     *
     * What reads as carelessness is not a spread across a card. It is two
     * ADJACENT controls, in identical boxes, drawn at different sizes.
     */
    const boxes = [...card().matchAll(/<button[^>]*width:26px[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    expect(boxes.length, "the pin and the link, in their 26×26 boxes").toBe(2);
    const sizes = boxes.map((b) => b.match(/width="(\d+)"/)?.[1]);
    expect(new Set(sizes).size, `drawn at ${sizes.join(" and ")}`).toBe(1);
  });
});

/*
 * THE CARD SAYS WHAT A PERSON DECIDED.
 *
 * A card for a pull request approved sixteen hours earlier read as
 * `2 failing → master` and nothing else: this row led with the checks and had
 * no review state on it at all. The board already carried `reviewDecision` in
 * the list it draws from — the answer was in hand and not on screen.
 *
 * Both directions are locked. An approval that is not drawn is the bug; a
 * "changes asked" that is not drawn is the same bug pointing the other way,
 * and the more expensive one, because it is the state where the pull request
 * is waiting on YOU rather than on CI.
 */
describe("the verdict a card leads with", () => {
  const V = (kind: string, o: Record<string, unknown> = {}) =>
    ({ kind, who: ["okoro"], ...o }) as unknown as PrSummary["humanReview"];
  /* The CARD, not the page: the lane headings carry words like "Approved" in
     their own explanations, and an assertion over the whole board matches
     those instead. */
  const drawnIn = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1 });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };

  test("says Approved, capitalised and with the name", () => {
    /* Capitalised because GitHub's own badge is, and the two sit on one screen:
       "improve the chips with a capital letter, not all lowercase". */
    const html = drawnIn({ humanReview: V("approved") });
    expect(html).toContain("Approved by okoro");
  });

  test("says Changes requested with the same weight as an approval", () => {
    // Both are a band with a name in it. One was a band and the other a grey
    // line, which is the inconsistency that was reported.
    expect(drawnIn({ humanReview: V("changes") })).toContain("Changes requested by okoro");
  });

  test("warns when the approval no longer covers the code", () => {
    /* The dangerous state: the row says approved and the reviewer approved
       something else. GitHub says so on the PR's own page; the board did not. */
    const html = drawnIn({ humanReview: V("approved", { stale: true }) });
    expect(html).toContain("it has moved since");
    expect(html, "and not as a plain approval").not.toContain(">Approved by okoro<");
  });

  test("speaks in the second person when the verdict is yours", () => {
    expect(drawnIn({ humanReview: V("approved", { mine: true }) })).toContain("You approved");
    expect(drawnIn({ humanReview: V("changes", { mine: true }) })).toContain("You asked for changes");
    expect(drawnIn({ humanReview: V("awaiting", { mine: true }) })).toContain("Waiting on you");
  });

  test("counts the people on the other side rather than hiding them", () => {
    // One approval and one rejection is not "changes requested" alone.
    expect(drawnIn({ humanReview: V("changes", { others: 1 }) })).toContain("1 approval");
  });

  test("says when a follow-up round has already been asked for", () => {
    /*
     * Applying a review and pressing "Re-request review" used to leave this
     * card reading exactly as it had before either happened — "Changes
     * requested by okoro", full stop — as if nothing had moved. The
     * review still blocks, same as GitHub's own page; this is the other
     * half GitHub's page ALSO shows: their own ↻.
     */
    const html = drawnIn({ humanReview: V("changes", { askedAgain: true }) });
    expect(html).toContain("asked to look again");
    expect(drawnIn({ humanReview: V("changes") })).not.toContain("asked to look again");
  });

  test("and in the second person when the re-request is yours to answer", () => {
    // The viewer is the one who was re-asked — their own move, not somebody
    // else's threads to watch.
    const html = drawnIn({ humanReview: V("changes", { mine: true, askedAgain: true }) });
    expect(html).toContain("You were asked to look again");
  });

  test("a draft says nobody has been asked", () => {
    // It was a label lost among the others; a draft is waiting on no one.
    expect(drawnIn({ isDraft: true })).toContain("nobody has been asked");
  });

  test("says nobody has been asked, rather than drawing nothing", () => {
    /*
     * This drew no header at all, on the argument that one saying "nothing"
     * steals weight from the ones that say something. Right about weight, wrong
     * about the card: the row came out visibly shorter than every other in the
     * lane, and a column of two shapes is a column you re-read. Drawn in the
     * quietest colour there is — it holds the shape without asking for
     * attention — and it states the real state rather than a placeholder.
     */
    const html = drawnIn({ humanReview: null });
    expect(html).toContain("No review asked for yet");
    for (const word of ["Approved", "Changes requested", "Waiting on"]) {
      expect(html, `claimed "${word}" over an unreviewed pull request`).not.toContain(word);
    }
  });

  test("every state carries a glyph, not colour alone", () => {
    // The board's own rule for check state, and this is the first thing read.
    for (const [kind, glyph] of [["approved", "\u2713"], ["changes", "\u2715"], ["awaiting", "\u25EF"]] as const) {
      expect(drawnIn({ humanReview: V(kind) }), kind).toContain(glyph);
    }
  });

  test("an approved card still shows its failing checks", () => {
    /* Approved does not mean mergeable, and a card that dropped the red to
       celebrate the tick would be the same lie in the other direction. */
    const html = drawnIn({
      humanReview: V("approved"),
      checks: { total: 3, success: 1, failure: 2, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [] },
    } as Partial<PrSummary>);
    expect(html).toContain("Approved");
    expect(html).toContain("2 failing");
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
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1 });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };

  test("says when it conflicts with the base", () => {
    /* `mergeable` was put on the summary precisely because the board files by
       what a row NEEDS, and then the card never drew it. */
    expect(inCard({ mergeable: "CONFLICTING" } as Partial<PrSummary>)).toContain("conflicts");
  });

  test("but not while GitHub is still working it out", () => {
    // `UNKNOWN` is "not computed yet". A conflict warning that flashes on and
    // off is worse than none.
    expect(inCard({ mergeable: "UNKNOWN" } as Partial<PrSummary>)).not.toContain("conflicts");
    expect(inCard({ mergeable: "MERGEABLE" } as Partial<PrSummary>)).not.toContain("conflicts");
  });

  test("shows the tracker card's state on a line of its own", () => {
    const html = inCard({
      headRefName: "ORBIT-1042-a-thing",
      card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "ready for qa", priority: "high" },
    } as Partial<PrSummary>);
    expect(html).toContain("ready for qa");
  });

  test("and draws nothing about it when the boards have not seen it", () => {
    /* Absent is "we have not seen this card", which is not "it has no status" —
       the difference between honest and inventing one. */
    const html = inCard({ headRefName: "ORBIT-9999-a-thing" } as Partial<PrSummary>);
    expect(html).not.toContain("ready for qa");
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
 * Not a hypothetical — it happened on his screen, and the board is the wrong
 * place to learn that a field changed shape. Anything that crossed a wire is
 * checked rather than assumed.
 */
describe("a verdict in a shape this build did not write", () => {
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1 });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };

  test("the old string still draws, without a name", () => {
    const html = inCard({ humanReview: "approved" } as unknown as Partial<PrSummary>);
    expect(html).toContain("Approved");
    expect(html, "no name to give, so none is invented").not.toContain("Approved by");
  });

  test("an object with no `who` does not take the view down", () => {
    const html = inCard({ humanReview: { kind: "changes" } } as unknown as Partial<PrSummary>);
    expect(html).toContain("Changes requested");
  });

  test("and something unrecognisable draws no header rather than throwing", () => {
    expect(() => inCard({ humanReview: { who: ["a"] } } as unknown as Partial<PrSummary>)).not.toThrow();
    expect(() => inCard({ humanReview: 42 } as unknown as Partial<PrSummary>)).not.toThrow();
  });
});

/*
 * THE LAST FIVE OF THE TWENTY-ONE.
 *
 * Facts the board had in hand and threw away, and one gesture that worked in
 * the pull request panel and did nothing here.
 */
describe("what the card finally says", () => {
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1 });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };
  const withCard = (extra: Record<string, unknown>) => ({
    headRefName: "ORBIT-1042-a-thing",
    card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "ready for qa", priority: "high", ...extra },
  } as unknown as Partial<PrSummary>);

  test("marks a card that says done under a pull request still open", () => {
    /* The pair that starts a conversation, and reading it meant crossing two
       screens by hand. */
    const html = inCard(withCard({ status: "closed", statusKind: "done" }));
    expect(html).toContain("while this pull request is still open");
  });

  test("and says nothing when the two agree", () => {
    expect(inCard(withCard({ statusKind: "open" }))).not.toContain("while this pull request is still open");
  });

  test("shows who the card is on, with the tracker's own face", () => {
    /* ClickUp's people, not GitHub logins: a name on a tracker board is not a
       username on a forge, and `<Avatar login="Antonio García">` draws a blank
       circle. The tracker hands over the photo, the initials and the colour. */
    const html = inCard(withCard({ people: [{ name: "Antonio", initials: "AG", color: "#7b68ee" }] }));
    expect(html).toContain("Card assigned to Antonio");
    expect(html, "the initials stand in when there is no photo").toContain("AG");
  });

  test("goes amber when nothing has moved in over a week", () => {
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    expect(inCard({ updatedAt: old })).toContain("Nothing has moved here in over a week");
  });

  test("but not on one that moved yesterday", () => {
    const fresh = new Date(Date.now() - 86_400_000).toISOString();
    expect(inCard({ updatedAt: fresh })).not.toContain("Nothing has moved here in over a week");
  });

  test("the card's id is a button that opens it, with room around the flag", () => {
    /* Asked for twice: id, status, assignee and a way in, on their own line.
       The first attempt put them in the tag row beside the labels — not where
       he said, and it read as one more label. */
    const html = inCard(withCard({}));
    expect(html).toContain("Open ORBIT-1042 in Tasks");
  });
});

describe("the card's own line", () => {
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1, hasTaskProvider: true });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };
  const withCard = (extra: Record<string, unknown>) => ({
    headRefName: "ORBIT-1042-a-thing",
    card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "code review", priority: "normal", ...extra },
  } as unknown as Partial<PrSummary>);

  test("carries the id, the state and the assignee together", () => {
    const html = inCard(withCard({ people: [{ name: "someone", initials: "SO" }] }));
    expect(html).toContain("ORBIT-1042");
    expect(html).toContain("code review");
    expect(html).toContain("Card assigned to someone");
  });

  test("and a way straight into the card", () => {
    expect(inCard(withCard({}))).toContain("Open ORBIT-1042 in Tasks");
  });

  test("the flag is not welded to the number", () => {
    /* Reported looking at it: the flag sat against the id with nothing between
       them. `gap-1.5` on the button is what puts the air back. */
    const html = inCard(withCard({}));
    const i = html.indexOf("ORBIT-1042");
    const btn = html.slice(html.lastIndexOf("<button", i), i);
    expect(btn, "the id button spaces its contents").toContain("gap-1.5");
  });
});

/*
 * ONE CHIP PER CARD, NOT TWO.
 *
 * The tag row carried the card's id and so did the card's own line, four lines
 * apart on the same card — "don't repeat the clickup card, leave only the new one".
 * The line wins: it has the state and the assignee too. The tag row keeps it
 * only for the case the line cannot cover.
 */
describe("the card id is not drawn twice", () => {
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1, hasTaskProvider: true });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };

  test("once, when the card is known", () => {
    const html = inCard({
      headRefName: "ORBIT-1042-a-thing",
      card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "in development", priority: "normal" },
    } as unknown as Partial<PrSummary>);
    /* CHIPS, not mentions: the id also appears inside its own `title`, and
       counting strings would make this pass or fail on a tooltip. */
    /* By marker, not by class list: the first version of this matched the exact
       classes and went red the day a padding changed. */
    const chips = (html.match(/data-card-chip/g) ?? []).length;
    expect(chips, "one chip for the card, not two").toBe(1);
    expect(html).toContain("in development");
  });

  test("and the tag row still shows it when the boards have never seen the card", () => {
    /* A branch naming a card nobody has cached: the id is all there is, and it
       is still worth showing. */
    const html = inCard({ headRefName: "ORBIT-9999-a-thing" } as Partial<PrSummary>);
    expect(html).toContain("ORBIT-9999");
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
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1, hasTaskProvider: true });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };
  const card = (at?: number) => ({
    headRefName: "ORBIT-1042-a-thing",
    card: { id: "x", customId: "ORBIT-1042", title: "A thing", status: "code review", priority: "normal", at },
  } as unknown as Partial<PrSummary>);

  test("a fresh reading is stated plainly", () => {
    const html = inCard(card(Date.now() - 5 * 60_000));
    expect(html).toContain("code review");
    expect(html, "nothing to warn about").not.toContain("h ago");
  });

  test("an old one says when it was read", () => {
    const html = inCard(card(Date.now() - 5 * 60 * 60_000));
    expect(html).toContain("code review");
    expect(html).toContain("5h ago");
  });

  test("and the tooltip never claims it is current", () => {
    /* "was in ... when this board was read" rather than "is in". The wording is
       the whole guarantee. */
    expect(inCard(card(Date.now() - 3 * 60 * 60_000))).toContain("was in");
  });
});

/*
 * EVERY CARD IS THE SAME SHAPE.
 *
 * A pull request with no tracker card was a row shorter than one with it, so a
 * lane held two heights and the eye had to re-find its place on every card.
 * "at least show something so the cards always have the same layout."
 *
 * What goes in that line is the honest answer to what the line asks — for a
 * release branch or a chore, "no card" is the answer, not silence.
 */
describe("the card line is always there", () => {
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1, hasTaskProvider: true });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };

  test("says so when the branch names no card at all", () => {
    expect(inCard({ headRefName: "chore/release-notes" })).toContain("no linked card");
  });

  test("and tells that apart from a card nobody has cached", () => {
    /* Two different facts: "this work has no card" and "we have not seen the
       card this names". Drawing both as silence loses the second. */
    expect(inCard({ headRefName: "ORBIT-9999-a-thing" })).toContain("card not found on your boards");
  });

  test("but says neither while the row is still arriving", () => {
    // That is the skeleton's job; a card mid-flight has not failed to find
    // anything yet.
    const html = inCard({ headRefName: "ORBIT-9999-a-thing", checksLoaded: false } as Partial<PrSummary>);
    expect(html).not.toContain("card not found");
    expect(html).not.toContain("no linked card");
  });
});

/*
 * `undefined` IS NOT `false`.
 *
 * `checksLoaded` has three states and they mean different things: `false` is
 * "the second pass is still coming", `true` is "it arrived", and `undefined` is
 * "this row was never built in two passes at all". A guard written `!== true`
 * folds the last two together and leaves a skeleton on screen for ever on any
 * caller that fetches in one go — which is exactly what it did, hiding the
 * header this test is about.
 */
describe("the three states of a half-built row", () => {
  const inCard = (o: Partial<PrSummary>) => {
    const html = render({ mine: [pr(7, o)], total: 1, hasTaskProvider: true });
    const i = html.indexOf('data-pr="7"');
    return i < 0 ? "" : html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
  };

  test("still coming: a skeleton", () => {
    const html = inCard({ humanReview: null, checksLoaded: false } as Partial<PrSummary>);
    expect(html).not.toContain("No review asked for yet");
  });

  test("never two-passed: the real answer, not a skeleton for ever", () => {
    expect(inCard({ humanReview: null })).toContain("No review asked for yet");
  });

  test("arrived with nothing: the real answer too", () => {
    expect(inCard({ humanReview: null, checksLoaded: true } as Partial<PrSummary>))
      .toContain("No review asked for yet");
  });
});

/*
 * THE HEADER CANNOT DISAPPEAR.
 *
 * Reported five times in one afternoon, each time as "it loses the header on
 * reload", and each time the answer was a different missing piece: a field
 * dropped by the client's merge, a verdict that fell outside the ten reviews
 * fetched, a guard that mistook `undefined` for "still loading". Every one of
 * them fixed, and the sixth would have been another.
 *
 * So the property is stated directly rather than reached: whatever the row is,
 * `cardVerdict` returns a header. Loading is a skeleton, unreviewed says so, a
 * draft says so, a malformed verdict falls back. The card's shape stops being a
 * consequence of the data arriving and becomes a thing the component
 * guarantees.
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
    test(`there is a header: ${name}`, () => {
      const html = render({ mine: [pr(7, o)], total: 1, hasTaskProvider: true });
      const i = html.indexOf('data-pr="7"');
      const card = html.slice(html.lastIndexOf("<div", i), html.indexOf("</div></div></div></div>", i));
      /* The header is the only `role="note"` inside a card. */
      expect(card, `no header for: ${name}`).toContain('role="note"');
    });
  }
});
