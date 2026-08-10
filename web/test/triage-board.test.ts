/*
 * What the board actually draws.
 *
 * prLanes.ts is already pinned down by its own suite — which lane a pull
 * request belongs in, and why. This file is about the layer above it, and about
 * the failures that layer has: the ones that are silent. A lane that quietly
 * stops counting the pull requests it is holding back, a cap that stops capping,
 * a scope sentence whose numbers drift apart from the lists they came from, and
 * a board that says "nothing here" while it is still asking — none of those
 * throw, none of them look wrong in a screenshot of a small repository, and all
 * of them are wrong in the one way this view exists to avoid: sounding certain.
 *
 * There is no DOM in these suites — bun test, no jsdom — so the component is
 * rendered to a string with `react-dom/server` and read as markup, the same way
 * server-banner-desktop.test.ts does it. That means no effects run: the keyboard
 * cursor, `scrollIntoView` and the reconciliation that keeps the cursor on
 * something are all effect-borne and cannot be seen from here. They are not
 * asserted, rather than asserted emptily.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard } from "../src/components/TriageBoard.tsx";
import { LANES } from "../src/lib/prLanes.ts";
import type { PrSummary } from "../../shared/types.ts";

const day = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();

/** A summary with everything the board reads, and nothing it does not. */
const pr = (
  number: number,
  o: Partial<PrSummary> & Partial<{ fail: number; pend: number; ok: number }> = {},
): PrSummary => {
  const { fail = 0, pend = 0, ok = 3, ...rest } = o;
  return {
    number, title: `pull request ${number}`, author: "someone", state: "OPEN", isDraft: false,
    headRefName: `h${number}`, baseRefName: "main", url: "", updatedAt: iso(1),
    reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1,
    labels: [], assignees: [], milestone: null,
    checks: {
      total: ok + fail + pend, success: ok, failure: fail, skipped: 0, pending: pend,
      allDone: pend === 0, verdict: pend ? null : fail ? "red" : "green", failing: [],
    },
    ...rest,
  } as unknown as PrSummary;
};

type Props = React.ComponentProps<typeof TriageBoard>;

/*
 * This used to end in `.replace(/<!--.*?-->/g, "")`, to drop the `<!-- -->`
 * separators React writes between adjacent text nodes — so that a sentence here
 * was not hostage to a React upgrade.
 *
 * Measured, because CodeQL asked what that pattern does to a comment with a
 * newline in it: the separators are not there. `renderToStaticMarkup` does not
 * write them — that is `renderToString`, which needs them for hydration.
 * Rendering the real board on React 18.3.1 gives 4253 characters of markup and
 * ZERO `<!--` in it, with or without cards.
 *
 * So the strip removed nothing and, being a wildcard, could only ever remove
 * something it was not aimed at. It is gone, and the guarantee it was standing
 * in for is asserted instead, once, below — loudly on the day it stops holding
 * rather than by quietly eating whatever appears.
 */
const render = (props: Partial<Props> = {}): string =>
  renderToStaticMarkup(React.createElement(TriageBoard, {
    mine: [], review: [], total: 0, hasTaskProvider: false,
    pinned: () => false, onOpen: () => {}, onTogglePin: () => {},
    onShowTable: () => {}, onAct: () => {},
    ...props,
  }));

/** One lane's column, from its own marker to the next one's. */
const column = (html: string, lane: string): string => {
  const start = html.indexOf(`data-lane="${lane}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-lane=", start + 10);
  return next < 0 ? html.slice(start) : html.slice(start, next);
};
/** How many cards a lane really drew — not how many it says it has. */
const drawn = (html: string, lane: string): number => (column(html, lane).match(/data-pr="/g) ?? []).length;
/** The number in the lane's heading. */
const heading = (html: string, lane: string): string | null =>
  column(html, lane).match(/tabular-nums">([^<]+)</)?.[1] ?? null;
/** The number in that lane's segment of the summary bar. */
const segment = (html: string, lane: string): string | null =>
  html.match(new RegExp(`data-seg="${lane}"[\\s\\S]*?<b[^>]*>([^<]+)</b>`))?.[1] ?? null;

/*
 * One board with a lane of every shape, built through the real classifier
 * rather than by naming lanes directly — if fileInLane changes its mind, these
 * counts move with it instead of asserting a fiction.
 *
 *   review  9 — asked of you, over the cap of six
 *   land    2 — yours, approved and green
 *   blocked 1 — yours, red
 *   flight  1 — yours, still running
 *   others  1 — a draft you were asked to look at: nobody's job, including yours
 *
 * #300 — asked of you, approved by somebody else, and red — is in `review`, not
 * in `others`: `asked` comes from `review-requested:@me`, which GitHub empties
 * the moment you review, so it means YOUR review is still outstanding whatever
 * anybody else has said.
 */
const ASKED = Array.from({ length: 8 }, (_, i) => pr(100 + i));
const REVIEW = [
  ...ASKED,
  pr(300, { reviewDecision: "APPROVED", fail: 1 }),
  pr(301, { isDraft: true }),
];
const MINE = [
  pr(200, { reviewDecision: "APPROVED" }),
  pr(201, { reviewDecision: "APPROVED" }),
  pr(202, { fail: 2 }),
  pr(203, { pend: 1 }),
];
const INVOLVED = REVIEW.length + MINE.length;
const full = (props: Partial<Props> = {}) => render({ mine: MINE, review: REVIEW, total: 388, ...props });

describe("the markup these tests read", () => {
  it("carries no HTML comment, so no sentence here has to step around one", () => {
    /*
     * The guarantee the old `.replace(/<!--.*?-->/g, "")` was standing in for,
     * asserted on a FULL board rather than an empty one — separators appear
     * between adjacent text nodes, and an empty board has almost none of those.
     *
     * If a React upgrade (or a move to `renderToString`) ever does start
     * writing them, this is the one line that goes red, and it says what to do:
     * strip the exact separator `<!-- -->`, never a wildcard.
     */
    expect(full()).not.toContain("<!--");
  });
});

describe("the lanes", () => {
  it("counts each lane from the two lists it was handed", () => {
    const html = full();
    expect(heading(html, "review")).toBe("9");
    expect(heading(html, "land")).toBe("2");
    expect(heading(html, "blocked")).toBe("1");
    expect(heading(html, "others")).toBe("1");
    expect(heading(html, "flight")).toBe("1");
  });

  it("caps a long lane and says what it is holding back", () => {
    /*
     * The cap is the difference between a board and a list, and it fails
     * silently in both directions: a lane that draws all forty is a scroll
     * inside a scroll, and a lane that draws six without saying so has hidden
     * two pull requests and told you it had six.
     */
    const html = full();
    expect(drawn(html, "review")).toBe(6);
    expect(heading(html, "review")).toBe("9");
    expect(column(html, "review")).toContain("+3 more in this lane");
  });

  it("leaves a lane under the cap alone", () => {
    const html = full();
    expect(drawn(html, "land")).toBe(2);
    expect(column(html, "land")).not.toContain("more in this lane");
  });

  it("says an empty lane is empty, per lane, when the rest are not", () => {
    const html = render({ mine: [pr(1)], review: [], total: 9 });
    expect(column(html, "review")).toContain("Nothing here. Good.");
    expect(drawn(html, "flight")).toBe(1);
  });

  it("draws a pull request once when it is both yours and asked of you", () => {
    // The same pull request arrives as two different objects in the two lists,
    // so nothing but the number can tell they are one thing.
    const html = render({ mine: [pr(7)], review: [pr(7)], total: 3 });
    expect((html.match(/data-pr="7"/g) ?? []).length).toBe(1);
  });
});

describe("the scope sentence", () => {
  it("states what is on the board and what is not", () => {
    const html = full();
    expect(html).toContain(`${INVOLVED}</b>`);
    expect(html).toContain("of 388 open pull requests want something from you");
    // The subtraction is the promise: the board is not hiding the rest, it is
    // pointing at them.
    expect(html).toContain(`the other ${388 - INVOLVED} are a table`);
  });

  it("drops every number built on the total when the total disagrees", () => {
    /*
     * Clamping is how "the other 0 are a table" got onto a screen with 388 open
     * pull requests behind it, and "5 of 3 want something from you" is the same
     * bad total two sentences later. The way out stays; the false counts go —
     * and they go together, or the screen contradicts itself.
     */
    const html = render({ total: 1, mine: MINE, review: REVIEW });
    expect(html).toContain("the rest are a table");
    expect(html).not.toContain("the other 0");
    expect(html).toContain("open pull requests want something from you");
    expect(html).not.toContain("of 1 open pull requests");
    expect(html).toContain(`${INVOLVED} on the board`);
  });

  it("shouts about the ones that only need a press", () => {
    expect(full()).toContain("can land right now");
  });

  it("stays quiet about landing when nothing can", () => {
    expect(render({ mine: [pr(1, { fail: 1 })], review: [], total: 4 })).not.toContain("can land right now");
  });
});

describe("waiting is not the same as empty", () => {
  /*
   * The bug this pair exists for: `mine` and `review` start as empty arrays and
   * are replaced when two list calls land, so for as long as those are in
   * flight the board rendered five confident "Nothing here. Good." columns —
   * the strongest claim it can make, at the moment it knows least.
   */
  it("says it is still reading, and puts no number on it", () => {
    const html = render({ loading: true, total: 388 });
    expect(html).toContain("Reading the two lists this board is made of");
    expect(html).not.toContain("Nothing wants anything from you");
    // Not "0 of 388". A count nobody has counted is the whole complaint.
    expect(html).not.toContain("want something from you");
    expect(heading(html, "review")).toBe("—");
  });

  it("says there is nothing only when both lists are in", () => {
    const html = render({ loading: false, total: 388 });
    expect(html).toContain("Nothing wants anything from you");
    expect(html).toContain("this is an answer, not a wait");
    expect(html).not.toContain("Reading the two lists");
  });

  it("keeps the answer on screen while it refreshes", () => {
    // A refresh with last minute's board still on screen must not blank it: the
    // old answer is a better one than a skeleton, and it is about to be right.
    const html = full({ loading: true });
    expect(drawn(html, "review")).toBe(6);
    expect(html).not.toContain("Reading the two lists");
  });

  it("offers the table from the empty state too, since that is the way out", () => {
    expect(render({ loading: false, total: 388 })).toContain("Show all 388 as a table");
  });
});

describe("the footer", () => {
  it("counts the ones that want nothing from you", () => {
    const html = full();
    expect(html).toContain(`${388 - INVOLVED}</b>`);
    expect(html).toContain("open pull requests want nothing from you right now");
  });

  it("counts the quiet ones over the board, and only from a date it can read", () => {
    /*
     * Two are genuinely old, one is old and unreadable. `updatedAt` arrives
     * empty on the first list pass, and counting an unparseable date as stale
     * would put a number on screen whose real meaning is "we could not tell".
     */
    const html = render({
      total: 20,
      mine: [pr(1, { updatedAt: iso(45) }), pr(2, { updatedAt: iso(31) }), pr(3, { updatedAt: iso(2) }), pr(4, { updatedAt: "" })],
      review: [],
    });
    expect(html).toContain("2 of these have gone 30 days without a push or a comment");
  });

  it("uses the singular for one, because a footer nobody reads twice has to read right once", () => {
    const html = render({ total: 20, mine: [pr(1, { updatedAt: iso(60) }), pr(2)], review: [] });
    expect(html).toContain("1 of these has gone 30 days without a push or a comment");
  });

  it("says so plainly when none of them is quiet", () => {
    const html = render({ total: 20, mine: [pr(1), pr(2)], review: [] });
    expect(html).toContain("everything here moved in the last 30 days");
    expect(html).not.toContain("of these have gone");
  });

  it("shrugs rather than subtract when the total disagrees with the board", () => {
    /*
     * `total` used to be the current filter's count, and the sentence built on
     * it read "the other 0" over a repository with 388 open. A total smaller
     * than the board itself cannot be corrected from in here — so it is not
     * dressed up as a number.
     */
    const html = render({ total: 1, mine: MINE, review: REVIEW });
    expect(html).toContain("not a number this view can trust");
    expect(html).not.toContain("want nothing from you right now");
  });

  it("offers no sweep, because there is nothing behind one", () => {
    // The mockup had "Sweep the stale ones". There is no API that closes or
    // pokes a batch of pull requests, and a button that looks like there is is
    // the same lie as a nudge on a card.
    expect(full().toLowerCase()).not.toContain("sweep");
  });
});

describe("the summary bar", () => {
  it("carries a segment per lane, with that lane's count", () => {
    const html = full();
    expect(segment(html, "review")).toBe("9");
    expect(segment(html, "land")).toBe("2");
    expect(segment(html, "blocked")).toBe("1");
    expect(segment(html, "others")).toBe("1");
    expect(segment(html, "flight")).toBe("1");
    // And the board against the repository, which is the same fraction the
    // scope sentence states in words.
    expect(html).toContain(`${INVOLVED} / 388`);
  });

  it("agrees with the lane headings, because two counts that can drift will", () => {
    const html = full();
    for (const lane of ["review", "land", "blocked", "others", "flight"]) {
      expect(segment(html, lane)).toBe(heading(html, lane));
    }
  });

  it("is a summary and not a second navigation", () => {
    /*
     * Nothing between the segments and the first lane may be pressable. A row
     * of buttons up there would be a second way to reach the lanes 1–5 already
     * reach, and would read as filters that shrink the board.
     */
    const html = full();
    const above = html.slice(html.indexOf('data-seg="review"'), html.indexOf('data-lane="review"'));
    expect(above).not.toContain("<button");
    expect(above).not.toContain("onclick");
  });

  it("is not drawn while the lists are still arriving", () => {
    expect(render({ loading: true, total: 388 })).not.toContain("data-seg=");
  });
});

describe("the pinned strip", () => {
  /*
   * A pin is a fact about YOU; a lane is a fact about what a pull request
   * needs. The strip exists because the two do not overlap — you can pin a
   * colleague's pull request, and no lane on this board will ever hold it.
   */
  it("is absent when nothing is pinned, rather than an empty heading", () => {
    const html = render({ pinnedList: [] });
    expect(html).not.toContain("Pinned");
  });

  it("lists what is pinned, whoever opened it", () => {
    const html = render({ pinnedList: [{ number: 17375, title: "Somebody else's work" }] });
    expect(html).toContain("#17375");
    // The apostrophe is escaped by the renderer; assert on a fragment that is
    // not, so the test is about the strip rather than about HTML entities.
    expect(html).toContain("Somebody else");
  });

  it("does not appear while the board is still reading", () => {
    // A strip over a skeleton reads as "these are your lanes", which is the one
    // thing it is not.
    const html = render({ loading: true, mine: [], review: [], pinnedList: [{ number: 1, title: "x" }] });
    expect(html).not.toContain("Pinned");
  });
});

describe("the lane headings line up", () => {
  /*
   * Reported from the app: the cards of each column started at a different
   * height and the board read as though it had been thrown together. The cause
   * was the lane's "why" sentence — one line in some lanes, two in others — so
   * the heading's height depended on how long a sentence happened to be.
   *
   * The cause is what is asserted, not the pixels: with no sentence in the flow
   * every heading is the same single row, and five columns cannot disagree
   * about where their first card begins.
   */
  it("draws no wrapping sentence in the heading", () => {
    const html = render({ mine: [pr(1, { reviewDecision: "APPROVED" })] });
    for (const l of LANES) expect(html).not.toContain(`>${l.why}<`);
  });

  it("keeps every why as something you can still read", () => {
    // Hidden, not deleted: it is what the ⓘ says, read once while you are
    // learning what a lane means rather than on every glance for ever after.
    const html = render({ mine: [pr(1)] });
    for (const l of LANES) expect(html).toContain(l.why);
  });
});

describe("the card carries the suite as a bar", () => {
  /*
   * "6/14" and "13/14" are the same shape at ten pixels — a board built for a
   * glance was asking you to read two numbers and divide. What is asserted is
   * the WIDTH, because the width is the claim: a bar that does not move with
   * the rollup is worse than no bar, since it looks like an answer.
   */
  const width = (html: string, n: number): string | null => {
    const card = html.slice(html.indexOf(`data-pr="${n}"`));
    return card.match(/width:\s*([0-9]+%)/)?.[1] ?? null;
  };

  it("fills by what has reported, not by what passed", () => {
    // 6 in of 14, nothing red: 43%. A run half in looks half in.
    const html = render({ mine: [pr(1, { ok: 6, pend: 8 })] });
    expect(width(html, 1)).toBe("43%");
  });

  it("fills a finished red run to the end", () => {
    // A failure is not an unfinished run. The colour says the verdict; the
    // length says the progress, and they are two different questions.
    const html = render({ mine: [pr(2, { ok: 3, fail: 1 })] });
    expect(width(html, 2)).toBe("100%");
  });

  it("leaves the track empty when nothing has reported", () => {
    // Not a hidden bar — that would make the card a different height — and not
    // a full grey one, which reads as "done".
    const html = render({ mine: [pr(3, { ok: 0 })] });
    expect(width(html, 3)).toBe("0%");
  });

  it("still says the verdict in words", () => {
    // Colour alone cannot say "red" to somebody who cannot see red.
    expect(render({ mine: [pr(4, { ok: 2, fail: 1 })] })).toContain("1 failing");
    expect(render({ mine: [pr(5, { ok: 6, pend: 8 })] })).toContain("6 of 14 in");
  });
});

describe("the pin is a target you can hit", () => {
  /*
   * It was a 22px glyph in the bottom corner, under a sentence whose length
   * decided where it ended up — so it moved between cards, and you aimed at it
   * rather than hitting it. Asked for explicitly.
   */
  const pinBtn = (html: string, n: number): string => {
    const card = html.slice(html.indexOf(`data-pr="${n}"`));
    const at = card.indexOf('aria-label="Pin');
    return card.slice(Math.max(0, at - 400), at + 200);
  };

  it("is at least 26px square", () => {
    const b = pinBtn(render({ mine: [pr(1)] }), 1);
    const w = Number(b.match(/width:\s*([0-9]+)px/)?.[1] ?? 0);
    const h = Number(b.match(/height:\s*([0-9]+)px/)?.[1] ?? 0);
    expect(w).toBeGreaterThanOrEqual(26);
    expect(h).toBeGreaterThanOrEqual(26);
  });

  it("sits on the title row, where every card has one", () => {
    // Before the sentence and before the action, so its position cannot depend
    // on how long either of them is.
    const html = render({ mine: [pr(1)] });
    const card = html.slice(html.indexOf('data-pr="1"'));
    expect(card.indexOf('aria-label="Pin')).toBeLessThan(card.indexOf("↳"));
  });

  it("says which state it is in for a reader who cannot see the star", () => {
    expect(render({ mine: [pr(1)], pinned: () => true })).toContain('aria-pressed="true"');
    expect(render({ mine: [pr(1)], pinned: () => false })).toContain('aria-pressed="false"');
  });
});

describe("a long title cannot decide the card's height", () => {
  it("clamps the title and keeps the whole of it reachable", () => {
    /*
     * Reported from a screenshot: a four-line title pushed the state, the
     * sentence and the button down by two rows, so the cards in one lane were
     * three different heights and the column could not be read down.
     */
    const long = "fix: " + "a very long title that nobody would ever type by hand ".repeat(4);
    const html = render({ mine: [pr(1, { title: long })] });
    expect(html).toContain("-webkit-line-clamp:2");
    expect(html).toContain(long.slice(0, 40)); // still there, still in the title attribute
  });
});
