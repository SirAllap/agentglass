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
 * `scrollIntoView` on a find step is effect-borne and cannot be seen from
 * here. It is not asserted, rather than asserted emptily.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard } from "../src/components/TriageBoard.tsx";
import { LANES, LANE_CAP } from "../src/lib/prLanes.ts";
import { CHIP_H } from "../src/lib/priority.tsx";

const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const faces = await Bun.file(new URL("../src/components/CardFaces.tsx", import.meta.url)).text();
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
    onlyUnread: false, onOnlyUnread: () => {},
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
    /* Built from LANE_CAP rather than from a number typed here: the cap moved
       once (six hid seven cards there was room for), and a test that spells the
       old number out goes red for the change instead of for the bug. */
    const long = Array.from({ length: LANE_CAP + 3 }, (_, i) => pr(400 + i));
    const html = full({ review: long });
    expect(drawn(html, "review")).toBe(LANE_CAP);
    expect(heading(html, "review")).toBe(String(LANE_CAP + 3));
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
    /* Against the SAME board not refreshing, rather than against a number: what
       this holds is that a refresh changes nothing on screen. The literal six
       here was the old cap and went red when the cap moved, and counting the
       fixture instead is no better — its rows are split across lanes, so its
       length was never what this lane draws. */
    expect(drawn(full({ loading: true }), "review")).toBe(drawn(full(), "review"));
    expect(drawn(full({ loading: true }), "review")).toBeGreaterThan(0);
    expect(full({ loading: true })).not.toContain("Reading the two lists");
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

  it("filters by LIGHTING a lane, and never by removing a card", () => {
    /*
     * This row used to forbid buttons outright, and the note behind that was
     * half right: "a row of buttons up here would read as filters that shrink
     * the board". Shrinking is the harm — eight printed numbers derive from the
     * flattened partition, so a card that stops being drawn makes the counts
     * above disagree with what is under them.
     *
     * Pressing one is not shrinking. The find box and the unread toggle on this
     * same screen already narrow the honest way: the cards that answer keep
     * their colour, the rest go quiet, nothing moves and nothing leaves. Asked
     * for looking at a board whose only row naming all five lanes did nothing —
     * "it should do something, like a button to filter".
     *
     * So the claim changes from "not pressable" to the property that was ever
     * worth holding: every card still drawn, in the same lane, after a press.
     */
    const html = full();
    const before = (html.match(/data-pr="/g) ?? []).length;
    expect(before, "a board with cards to keep").toBeGreaterThan(0);

    /* The chips are buttons now — the empty ones deliberately are not, because
       lighting a lane with nothing in it leaves a board where every card is
       quiet and the way out is the chip you just pressed. */
    const row = html.slice(html.indexOf('data-seg="review"'), html.indexOf('data-lane="review"'));
    expect(row, "a lane with cards is pressable").toContain("<button");
    expect(row).toContain('data-seg="land"');
  });

  it("and an empty lane is not one of those buttons", () => {
    // `review` is empty in this fixture; `land` is not.
    const html = render({ mine: [pr(1)], review: [], total: 40 });
    const seg = (id: string) => {
      const i = html.indexOf(`data-seg="${id}"`);
      return html.slice(html.lastIndexOf("<", i), i);
    };
    expect(seg("review"), "nothing to light").not.toContain("button");
  });

  it("is not drawn while the lists are still arriving", () => {
    expect(render({ loading: true, total: 388 })).not.toContain("data-seg=");
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
    //
    // Every lane DRAWN, which is not every lane declared: `others` opts out of
    // being shown empty, and on this board it is empty. Asserting over all five
    // would be asserting that a column nobody can see explains itself.
    const html = render({ mine: [pr(1)] });
    for (const l of LANES) {
      if (l.hideWhenEmpty) continue;
      expect(html).toContain(l.why);
    }
    // And with something in it, it is a column again, ⓘ and all.
    const withOthers = render({ review: [pr(9, { isDraft: true })] });
    for (const l of LANES) expect(withOthers).toContain(l.why);
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
    expect(render({ mine: [pr(4, { ok: 2, fail: 1 })] })).toContain("1 check failing");
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

  it("is the number chip's height with a mouse and at least 26px square on a touch screen", () => {
    // The size is two custom properties on the group and a class on the button:
    // a media query for a coarse pointer cannot be written in an inline style.
    const html = render({ mine: [pr(1)] });
    const card = html.slice(html.indexOf('data-pr="1"'));
    const at = card.indexOf('aria-label="Pin');
    const pin = card.slice(card.lastIndexOf("<button", at), card.indexOf(">", at));
    expect(pin).toContain("agx-prc-ib");
    expect(Number(card.match(/--ib:\s*([0-9]+)px/)?.[1] ?? 0)).toBe(CHIP_H + 2);
    expect(Number(card.match(/--ib-hit:\s*([0-9]+)px/)?.[1] ?? 0)).toBeGreaterThanOrEqual(26);
  });

  it("sits on the identity line beside the number, where every card has one", () => {
    // Before the title and before the action, so its position cannot depend
    // on how long either of them is.
    const html = render({ mine: [pr(1)] });
    const card = html.slice(html.indexOf('data-pr="1"'));
    expect(card.indexOf('aria-label="Pin')).toBeLessThan(card.indexOf("agx-prc-title"));
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

/*
 * Find, inside the board.
 *
 * The bar at the top of the panel asks GitHub, and pressing return in it leaves
 * the board for a table of every pull request in the repository. This is the
 * other question — "which of THESE twelve" — asked in the space the summary
 * leaves empty.
 */
describe("finding a card on the board", () => {
  it("has a box, once there is something to look through", () => {
    expect(full()).toContain("Find in these");
    // Nothing to search on an empty board, and nothing to search while the two
    // lists are still arriving.
    expect(render({ mine: [], review: [], total: 0 })).not.toContain("Find in these");
  });

  it("quietens what does not match rather than removing it", () => {
    /*
     * A card that stops being drawn takes its lane's shape with it, and the
     * counts above start disagreeing with what is under them — and the shape is
     * the reason this is a board and not a list.
     *
     * Read from the source, because nothing is dimmed until somebody types and
     * there is no typing in `renderToStaticMarkup`.
     *
     * By SHAPE and not by an exact line. The first version pinned the literal
     * `dim={!matches(p)}` and went red the day a second way of lighting the
     * board — one lane, from the counts row — was added beside the first: the
     * expression is now two conditions across two lines and means exactly the
     * same thing. A lock that fails when a line is reformatted is one somebody
     * deletes. What has to hold is that `dim` is COMPUTED per card and that
     * every card is still rendered.
     */
    const call = board.slice(board.indexOf("dim={"), board.indexOf("root={root}", board.indexOf("dim={")));
    expect(call, "dim is derived from the search, per card").toContain("matches(p)");
    expect(board).toContain('...(dim ? { opacity: 0.32, filter: "saturate(0.25)" } : null),');
    // Never a filtered list: every card is still rendered.
    expect(board).not.toContain(".filter(matches)</");
    expect(board).not.toContain(".filter(matches).map");
  });

  it("searches by the rule the app's find bar uses, not one of its own", () => {
    /*
     * The rule itself moved to prBoardFind.ts and has a suite of its own —
     * because the app's find bar drives the SAME one now, and two searches on
     * one screen answering differently is what this was. What is checked here
     * is the wiring: the board asks that module, and it hands the bar an engine
     * so Ctrl+F dims cards instead of painting words.
     */
    expect(board).toContain('from "../lib/prBoardFind.ts"');
    expect(board).toContain("return prMatches(p, needle)");
    expect(board).toContain("registerEngine(");
    // And only while this board is what is on screen — the panel keeps it
    // mounted behind other views.
    expect(board).toContain("const scope = topScope();");
  });
});

describe("who is on it", () => {
  it("is drawn as faces, not as two letters", () => {
    /*
     * Two letters is a puzzle on a board where the same pair belongs to two
     * people, and every other surface in the panel draws a person as a picture.
     * `Avatar` keeps initials as its own fallback, so nothing is lost where
     * there is no face.
     */
    expect(faces).toContain("<Avatar login={f.login} size={ICON.md} />");
    expect(board).not.toContain("r.login.slice(0, 2).toUpperCase()");
  });

  it("the author leads the identity line; everyone the band waits on is a face on its right", () => {
    expect(board).toContain("<Avatar login={p.author} size={20} />");
    expect(board).toContain("<CardFaces r={reviewers} />");
    expect(board).not.toContain("headerPeople");
    expect(board).not.toContain("agx-prc-foot");
  });
});

describe("a board is for pointing at, not for pressing", () => {
  it("opens the pull request from the card itself: no button row, nothing that performs the lane's action", () => {
    /*
     * A Re-run pressed by accident on a card under the pointer for another
     * reason, and then an Open button nobody used. The whole card is the
     * button; the lane and its sentence say what wants doing.
     */
    expect(board).toContain('<div onClick={onOpen} role="button"');
    expect(board).not.toContain("onAct(p, act)");
    expect(board).not.toContain('onAct(p, "open")');
  });
});

describe("the number on a card", () => {
  it("copies when pressed, without opening the card underneath", () => {
    expect(board).toContain("copyNumber(p.number)");
    expect(board).toContain("e.stopPropagation(); copyNumber(p.number)");
  });

  it("wears the same chip the masthead does, so it reads as pressable", () => {
    /*
     * This asserted the literal `{copied === p.number ? "✓" : "⧉"}` until the
     * card's header was measured. The mark stayed; the way it is drawn did not.
     *
     * `⧉` was set at `fontSize: 9`, the smallest ink in the app, two lines
     * above a 14px vector in the same row — and a character paints about 60% of
     * what its size promises, so nine landed near five against fourteen.
     * Reported as "some icons are very big, others very small". It also swapped
     * one CHARACTER for a different one on copy, and two characters are not the
     * same width, so the card moved at the moment you pressed it.
     *
     * What has to hold is the promise, not the codepoint: the chip still says
     * what it does before you try it, and still says it happened afterwards.
     */
    expect(board).toContain("copied === p.number");
    expect(board).toContain("<DoneIcon size={ICON.xs} />");
    expect(board).toContain("<CopyIcon size={ICON.xs} />");
    expect(board).toContain("border: copyEdge(copied === p.number),");
    expect(board).toContain("`1px solid color-mix(in srgb, ${done ? \"var(--success) 50%\" : \"var(--border) 55%\"}, transparent)`");
  });
});

/*
 * A card that claims failure asks whether it is true.
 *
 * The list's rollup is GitHub's aggregate counts, and those count a re-run's
 * old attempt beside the new one. Measured on a pull request their own page
 * calls "All checks have passed": counts of 45 SUCCESS, 20 SKIPPED, 1
 * CANCELLED, 1 FAILURE — and `state: FAILURE`, which their page does not use
 * either. Aggregates have no names to de-duplicate by, so the only honest fix
 * is to ask per card.
 */
describe("a red card", () => {
  it("checks itself against the latest run per name", () => {
    expect(board).toContain("const real = rollupOf(root, p.number, `${p.headSha ?? \"\"}|${JSON.stringify(p.checks)}`);");
    expect(board).toContain("return real ? { ...p, checks: real } : p;");
  });

  it("only asks when it claims red, and only with a checkout to ask from", () => {
    // Everything green is already telling the truth; asking for it would be a
    // request per card on every board paint.
    expect(board).toContain("if (!root || !p.checks || p.checks.failure === 0) return p;");
  });
});

describe("taking a card away with you", () => {
  /* The number, the link and the pin are one group on the identity line, right
     after the number and before the age. They used to be split: the number on
     the identity line, the link and the pin in a block of their own at the end
     of the title row, which took the title's width. */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const idRow = board.slice(board.indexOf('className="agx-prc-id"'), board.indexOf('<div title={p.title} className="agx-prc-title'));
  const group = idRow.slice(idRow.indexOf('className="agx-prc-grp'), idRow.indexOf("{ago(p.updatedAt)}"));

  it("copies its link, beside the number and the pin", () => {
    /* The number copies the number — what goes in a branch or a commit. This is
       the other thing a card gets taken away as: a link to paste into a
       message. */
    expect(board).toContain("copyLink()");
    expect(board).toContain('navigator.clipboard?.writeText(p.url || "")');
  });
  it("keeps the number, the link and the pin in one group on the identity line, before the age", () => {
    expect(idRow).not.toBe("");
    for (const call of ["copyNumber(p.number)", "copyLink()", "onPin()"]) {
      expect(group, call).toContain(call);
    }
    expect(group.indexOf("copyNumber(")).toBeLessThan(group.indexOf("copyLink()"));
    expect(group.indexOf("copyLink()")).toBeLessThan(group.indexOf("onPin()"));
  });
  it("keeps each control's label, pressed state and click guard", () => {
    expect(group).toContain("aria-label={`Copy the link to #${p.number}`}");
    expect(group).toContain("aria-pressed={pinned}");
    expect(group.split("e.stopPropagation()").length - 1).toBe(3);
  });
  it("has no separate action block, and the layout has no area for one", () => {
    expect(board).not.toContain("agx-prc-ac");
    expect(css).not.toContain("agx-prc-ac");
    expect(css).not.toMatch(/grid-template-areas:[^;]*\bac\b/);
  });
  it("sizes the link and the pin from the number chip, HIT on a touch screen", () => {
    expect(group).toContain("CHIP_H + 2");
    expect(group).toContain("HIT");
    expect(css).toMatch(/\.agx-prc-ib \{ width: var\(--ib\); height: var\(--ib\); \}/);
    expect(css).toMatch(/pointer: coarse\) \{\s*\.agx-prc-ib \{ width: var\(--ib-hit\)/);
  });
});

/*
 * The keyboard row under the counts advertises six shortcuts. They have to work.
 *
 * Reported: "that legend doesn't work at all, it's a lie" — the strip
 * that reads `1–4 lane · j k card · h l across · ⏎ open · a open it · p pin`.
 * It was not wrong about which keys exist; every one of them is handled in
 * `onKey`. They were UNREACHABLE. The handler hangs off a `tabIndex={0}` div
 * and NOTHING in the file ever focused it: a grep for `.focus()` on `frame`
 * returned nothing, and the ref's only other use was a `scrollIntoView`.
 * Arriving at the board left the focus wherever it had been, so six advertised
 * shortcuts answered to nobody.
 *
 * His first instinct was to delete the row and drive the board with the mouse.
 * With the measurement in front of him — not broken, unreachable — he chose
 * the other way: "better keep the row, and make them work".
 *
 * Read from the source rather than rendered, and that is not laziness: an
 * effect does not run under `renderToStaticMarkup`, which is how this file
 * renders. What has to hold is the shape — that the focus happens, and that it
 * is guarded — and a server render cannot see either.
 */
describe("the shortcuts the legend promises", () => {
  const SRC = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
  /** Comments here name the very things these assertions are about. */
  const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the frame that owns the keys actually receives focus", () => {
    expect(bare).toContain("frame.current?.focus(");
  });

  it("and does not steal it from somebody who is typing", () => {
    /* The whole risk of the fix. Taking focus from a field means the next
       character lands on a board that reads `p` as "pin this". */
    expect(bare).toMatch(/INPUT|TEXTAREA/);
    expect(bare).toContain("isContentEditable");
    expect(bare).toMatch(/if \(!typing\)/);
  });

  it("without scrolling the page to reach it", () => {
    // `focus()` scrolls its target into view by default, and the board is a
    // horizontal strip of scrollers: reaching for it would move two of them.
    expect(bare).toContain("preventScroll: true");
  });

  it("the board answers no card keys, and prints none", () => {
    // Ctrl+Alt+A closes and opens the bench; the board's `a` read it as "open
    // this card" and opened whatever the cursor rested on. The keys went.
    for (const k of ['"j"', '"k"', '"h"', '"l"', '"p"', '"a"']) {
      expect(bare, `the board still handles ${k}`).not.toContain(`k === ${k}`);
    }
    expect(SRC).not.toContain("</K> pin<");
    expect(SRC).not.toContain("</K> open it<");
  });

  it("no card paints a keyboard cursor", () => {
    // With the keys gone nothing could move it, so one card always wore a blue
    // border and a left strip that read as a pull request state.
    const html = render({ review: [pr(1), pr(2)], mine: [pr(3)], total: 3 });
    expect(drawn(html, "review")).toBeGreaterThan(0);
    expect(html).not.toContain("data-cur");
    expect(html).not.toContain("inset 2px 0 0");
    expect(SRC).not.toContain("data-cur");
    expect(SRC).not.toMatch(/\bsetCur\b/);
  });
});

describe("a stale approval on the card", () => {
  it("is green when GitHub still counts it, amber only once re-requested", () => {
    // Reported beside the merge box on the same pull request reading the
    // identical fact green ("still counts") while this card was amber for
    // commits alone.
    const fn = board.slice(board.indexOf('if (v.kind === "approved") {'), board.indexOf("function CardView("));
    expect(fn).toContain("staleApproval(p.reviewDecision).counts");
    expect(fn).toContain("if (!v.askedAgain && counts)");
  });
});

describe("the card header strip, cleared", () => {
  // Reported on the installed build: the merge box had already gone amber for
  // "every changes-requester re-asked", and this strip — the same fact, a
  // different surface — still read red. One truth, one wording, two places.
  const fn = board.slice(board.indexOf('if (v.kind === "changes") {'), board.indexOf('if (v.kind === "awaiting") {'));

  it("draws amber, not red, once every changes-requester is cleared", () => {
    expect(fn).toContain("if (v.cleared)");
    expect(fn).toContain("var(--warning)");
  });

  it("says the same thing the merge box says", () => {
    expect(fn).toContain("Waiting on review by");
    /* The header names who the ball is with; the sentence under it, in the
       card's own last-event zone, says what happened. Said twice it was one
       fact on two lines of the same card. */
    expect(fn).not.toContain("Changes applied, asked to look again.");
  });
});

describe("card assignees on a board card", () => {
  const tracker = readFileSync(new URL("../src/components/CardTracker.tsx", import.meta.url), "utf8");

  it("draws up to five faces and says the rest as +N", () => {
    expect(tracker).toContain("peopleShown(who.length)");
    expect(tracker).toContain("who.slice(0, faces)");
    expect(tracker).toContain("+{more}");
  });

  it("does not repeat the first assignee's name next to the faces", () => {
    expect(tracker).not.toContain("who[0]!.name");
  });
});

describe("the identity line of a board card", () => {
  const line = board.slice(board.indexOf("Beside the number, before the title"), board.indexOf("Everything that is only sometimes true"));

  it("does not print the author's name: the first face bottom right is the author", () => {
    expect(line).toContain("ago(p.updatedAt)");
    expect(line).not.toContain("{p.author}");
  });
});
