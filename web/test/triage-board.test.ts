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
const cardSrc = await Bun.file(new URL("../src/components/PrCard.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
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
  column(html, lane).match(/tabular-nums[^"]*"[^>]*>([^<]+)</)?.[1] ?? null;
/** The number on the lane's count button, the one that lights the lane (the chip row it replaced is gone). */
const segment = (html: string, lane: string): string | null =>
  html.match(new RegExp(`data-seg="${lane}"[^>]*>([^<]+)</button>`))?.[1] ?? null;

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
    expect(column(html, "review")).toContain("Show the other 3");
  });

  it("leaves a lane under the cap alone", () => {
    const html = full();
    expect(drawn(html, "land")).toBe(2);
    expect(column(html, "land")).not.toContain("Show the other");
  });

  it("says an empty lane is empty, per lane, when the rest are not", () => {
    const html = render({ mine: [pr(1)], review: [], total: 9 });
    expect(column(html, "review")).toContain("Nothing here. Quiet is good.");
    expect(drawn(html, "flight")).toBe(1);
  });

  it("draws a pull request once when it is both yours and asked of you", () => {
    // The same pull request arrives as two different objects in the two lists,
    // so nothing but the number can tell they are one thing.
    const html = render({ mine: [pr(7)], review: [pr(7)], total: 3 });
    expect((html.match(/data-pr="7"/g) ?? []).length).toBe(1);
  });
});

describe("the lanes carry the whole count", () => {
  it("draws no scope sentence above the lanes: the counts on the lanes say it", () => {
    // The design has no line between the bar and the lanes. It used to read
    // "13 open · yours and asked of you · 1 can land right now", which restated
    // the five lane counts next to it.
    const html = full();
    expect(html).not.toContain("yours and asked of you");
    expect(html).not.toContain("can land right now");
    expect(html).not.toContain(`${INVOLVED}</b>`);
  });

  it("still says how much of the repository is not on the board, in the footer", () => {
    expect(full()).toContain(`${388 - INVOLVED}</b>`);
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
    // The face is skeleton cards under a busy grid, never a claim.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("agx-sk");
    expect(html).not.toContain("No open pull requests");
    expect(html).not.toContain("Quiet is good");
    // Not "0". A count nobody has counted is the whole complaint.
    expect(heading(html, "review")).toBe("\u2026");
  });

  it("says there is nothing only when both lists are in", () => {
    const html = render({ loading: false, total: 388 });
    expect(html).toContain("No open pull requests");
    expect(html).toContain("Quiet is good");
    expect(html).not.toContain("agx-sk");
    expect(html).not.toContain("aria-busy");
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
    expect(render({ loading: false, total: 388 })).toContain("Show all 388");
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

  it("draws no footer at all when nothing in it has anything to say", () => {
    // "Everything here moved in the last 30 days" was a sentence about the
    // absence of a problem; the footer now appears only with something to say.
    const html = render({ total: -1, mine: [pr(1), pr(2)], review: [] });
    expect(html).not.toContain("everything here moved");
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
    expect(html).not.toContain("not a number this view can trust");
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

    /* The lane's count is the button now — an empty lane's deliberately is not,
       because lighting a lane with nothing in it leaves a board where every
       card is quiet and the way out is the count you just pressed. */
    expect(html, "a lane with cards is pressable").toMatch(/<button data-seg="review"/);
    expect(html).toMatch(/<button data-seg="land"/);
  });

  it("and an empty lane is not one of those buttons", () => {
    // `review` is empty in this fixture; `land` is not.
    const html = render({ mine: [pr(1)], review: [], total: 40 });
    expect(html, "nothing to light").not.toContain('data-seg="review"');
    expect(html, "a lane holding the card is pressable").toContain("data-seg=");
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
    // The sentence is not inside the heading's text; it rides the info button's tip.
    for (const l of LANES) {
      const col = column(html, l.id);
      if (!col) continue;
      expect(col.slice(col.indexOf("<h3"), col.indexOf("</h3>"))).not.toContain(`>${l.why}<`);
      // No description line under the heading; the sentence is the info button's tip, so the first card starts at one Y.
      expect(col).not.toContain("agx-pl-help");
      expect(col.slice(col.indexOf("<h3"), col.indexOf("</h3>"))).toContain(`aria-label="About ${l.label}`);
    }
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
   * glance was asking you to read two numbers and divide. The bar is one
   * segment per check that reported, so what is asserted is the COUNT and the
   * colour of the segments: a bar that does not move with the rollup is worse
   * than no bar, since it looks like an answer.
   */
  const segments = (html: string, n: number): { green: number; red: number; running: number; ring: string } => {
    const card = html.slice(html.indexOf(`data-pr="${n}"`));
    const start = card.indexOf('class="agx-cd-svg"');
    const ring = card.slice(start, card.indexOf("</svg>", start));
    const count = (token: string) => ring.split(`stroke="var(--${token})"`).length - 1;
    return { green: count("success"), red: count("error"), running: count("warning"), ring };
  };

  it("fills by what has reported, not by what passed", () => {
    // 6 in of 14, nothing red: six green segments and eight still running.
    const s = segments(render({ mine: [pr(1, { ok: 6, pend: 8 })] }), 1);
    expect([s.green, s.red, s.running]).toEqual([6, 0, 8]);
  });

  it("draws a failure as a segment of its own, in a run that has finished", () => {
    // A failure is not an unfinished run. The colour says the verdict; the
    // count says the progress, and they are two different questions.
    const s = segments(render({ mine: [pr(2, { ok: 3, fail: 1 })] }), 2);
    expect([s.green, s.red, s.running]).toEqual([3, 1, 0]);
  });

  it("leaves the track empty when nothing has reported", () => {
    // Not a hidden ring — that would make the card a different shape — and not
    // a full grey one, which reads as "done".
    const s = segments(render({ mine: [pr(3, { ok: 0 })] }), 3);
    expect([s.green, s.red, s.running]).toEqual([0, 0, 0]);
    expect(s.ring).toContain('aria-label="No checks yet"');
  });

  it("still says the verdict in words", () => {
    // Colour alone cannot say "red" to somebody who cannot see red.
    expect(render({ mine: [pr(4, { ok: 2, fail: 1 })] })).toContain("1 failing");
    const running = render({ mine: [pr(5, { ok: 6, pend: 8 })] });
    expect(running).toContain(">6/14<");
    expect(running).toContain(">8 running<");
  });
});

describe("the pin is a target you can hit", () => {
  /*
   * It was a 22px glyph in the bottom corner, under a sentence whose length
   * decided where it ended up — so it moved between cards, and you aimed at it
   * rather than hitting it. It lives in the footer's third slot now, the same
   * place on every card, at the house's 26px square.
   */
  it("is the house's 26px square, a kit button, on a mouse and on a touch screen", () => {
    const html = render({ mine: [pr(1)] });
    const card = html.slice(html.indexOf('data-pr="1"'));
    const at = card.indexOf('aria-label="Pin');
    const pin = card.slice(card.lastIndexOf("<button", at), card.indexOf(">", at));
    expect(pin).toContain("width:26px");
    expect(pin).toContain("height:26px");
    expect(cardSrc).toContain('<Button size="hit" tone="quiet" square aria-pressed={props.pinned}');
  });

  it("sits in the footer's last slot, after what the card says, so its position cannot depend on how long the title is", () => {
    const html = render({ mine: [pr(1)] });
    const card = html.slice(html.indexOf('data-pr="1"'));
    expect(card.indexOf("agx-cd-t")).toBeGreaterThan(0);
    expect(card.indexOf('aria-label="Pin')).toBeGreaterThan(card.indexOf("agx-cd-t"));
    expect(card.indexOf('aria-label="Pin')).toBeGreaterThan(card.indexOf("↳"));
    expect(card.indexOf("agx-cd-icb")).toBeLessThan(card.indexOf('aria-label="Pin'));
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
    expect(css).toMatch(/\.agx-cd-t \{[^}]*-webkit-line-clamp: 2;/);
    expect(html).toContain(long.slice(0, 40)); // still there, whole in the tooltip
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
  it("draws no find button at rest, and keeps it for when something is lit", () => {
    // The design's board has no tools row; Ctrl+F still opens the find. The
    // tools float, drawn only when there is something to do with them.
    expect(full()).not.toContain("Find in these");
    expect(render({ mine: [], review: [], total: 0 })).not.toContain("Find in these");
    expect(board).toContain('aria-label="Find in these cards"');
    expect(board).toContain("(unreadCount > 0 || onlyUnread || !!find || onlyLane !== null)");
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
    expect(css).toContain(".agx-cd[data-dim] { opacity: .32; filter: saturate(.25); }");
    expect(cardSrc).toContain('data-dim={props.dim ? "1" : undefined}');
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
    expect(cardSrc).toContain("<Avatar login={f.login} size={size} />");
    expect(board).not.toContain("r.login.slice(0, 2).toUpperCase()");
  });

  it("the author is named by the strip and the event tooltip; everyone the band waits on is a face on its right", () => {
    expect(cardSrc).not.toContain("<Avatar login={p.author} size={16} />");
    expect(board).toContain("author: p.author,");
    expect(cardSrc).toContain("<Faces faces={cv.stripFaces.faces}");
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
    // `ref={props.cardRef}` sits first: the conflict resolver watches the card's visibility.
    expect(cardSrc).toContain('<div ref={props.cardRef} onClick={props.onOpen} role="button"');
    expect(board).not.toContain("onAct(p, act)");
    expect(board).not.toContain('onAct(p, "open")');
  });
});

describe("the number on a card", () => {
  it("copies when pressed, without opening the card underneath", () => {
    expect(cardSrc).toContain('copy("num", `#${p.number}`)');
    expect(cardSrc).toContain("const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };");
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
    expect(cardSrc).toContain('copied === "num"');
    expect(cardSrc).toContain("<DoneIcon size={ICON.xs} />");
    expect(cardSrc).toContain("<CopyIcon size={ICON.xs} />");
    /* The green after a copy is the stylesheet's, keyed on the number's own flag. */
    expect(cardSrc).toContain('data-copied={copied === "num" ? "1" : undefined}');
    expect(css).toMatch(/\.agx-cd-n\[data-copied\] \{[^}]*var\(--success\)/);
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
  /* The number copies on the title, before the words. The link and the pin are
     the footer's last slot, beside "more actions": the same place on every
     card, where they used to follow the title's width. */
  const slot = cardSrc.slice(cardSrc.indexOf('<div className="agx-cd-icb">'), cardSrc.indexOf("/* ---- stack popover ---- */"));

  it("copies its link, beside the number and the pin", () => {
    /* The number copies the number — what goes in a branch or a commit. This is
       the other thing a card gets taken away as: a link to paste into a
       message. */
    expect(cardSrc).toContain('copy("link", p.url || "")');
    expect(cardSrc).toContain("void navigator.clipboard?.writeText(text)");
  });
  it("keeps the number on the title, and the link and the pin in the footer's last slot", () => {
    expect(slot).not.toBe("");
    const title = cardSrc.slice(cardSrc.indexOf('<div className="agx-cd-t"'), cardSrc.indexOf("/* ---- ticket row ---- */"));
    expect(title).toContain('copy("num"');
    for (const call of ['copy("link"', "props.onPin()"]) expect(slot, call).toContain(call);
    expect(slot.indexOf('copy("link"')).toBeLessThan(slot.indexOf("props.onPin()"));
  });
  it("keeps each control's label, pressed state and click guard", () => {
    expect(slot).toContain("`Copy the link to #${p.number}`");
    expect(slot).toContain("aria-pressed={props.pinned}");
    expect(slot).toContain("More actions for #${p.number}");
    expect(slot.split("e.stopPropagation()").length - 1).toBe(3);
  });
  it("has no separate action block, and the stylesheet has no area for one", () => {
    expect(board).not.toContain("agx-prc-ac");
    expect(css).not.toContain("agx-prc-ac");
    expect(css).not.toMatch(/grid-template-areas:[^;]*\bac\b/);
  });
  it("sizes the footer's buttons from the kit: HIT, which is also what a touch screen needs", () => {
    const footer = cardSrc.slice(cardSrc.indexOf('<div className="agx-cd-f"'), cardSrc.indexOf("/* ---- stack popover ---- */"));
    expect(footer.split('size="hit"').length - 1).toBe(5);
    expect(readFileSync(new URL("../src/components/workspace/Chrome.tsx", import.meta.url), "utf8")).toContain("hit: HIT");
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
describe("what the board still does with the keyboard", () => {
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

  it("the board has no keyboard cursor: no j/k, no arrow walk, no painted card", () => {
    // The board is mouse-driven. Cards are buttons and links; Tab reaches them.
    expect(bare).not.toMatch(/k === "[jk]"/);
    expect(bare).not.toContain('"ArrowDown"');
    expect(bare).not.toContain('"ArrowUp"');
    expect(bare).not.toContain("data-cursor");
    expect(bare).not.toContain("const walk");
    expect(bare).not.toContain("setCur(");
    // ⌃F, the app's find, is the one key the board still answers.
    expect(bare).toContain('e.key.toLowerCase() === "f"');
    const html = render({ review: [pr(1), pr(2)], mine: [pr(3)], total: 3 });
    expect(drawn(html, "review")).toBeGreaterThan(0);
    expect(html).not.toContain('data-cursor');
  });
});

describe("a stale approval on the card", () => {
  it("is green when GitHub still counts it, amber only once re-requested", () => {
    // Reported beside the merge box on the same pull request reading the
    // identical fact green ("still counts") while this card was amber for
    // commits alone. The decision is in prCardView.ts and walked in pr-card-view.test.ts.
    const view = readFileSync(new URL("../src/lib/prCardView.ts", import.meta.url), "utf8");
    expect(view).toContain("staleApproval(p.reviewDecision).counts");
    expect(view).toContain("o.staleCounts && !o.askedAgain");
  });
});

describe("card assignees on a board card", () => {
  it("are named in the ticket's tooltip, once, with the status and priority", () => {
    expect(cardSrc).toContain('(card.people ?? []).map((x) => x.name).join(", ")');
    expect(cardSrc).toContain("On ${who}.");
    expect(cardSrc).not.toContain("who[0]!.name");
  });
});

describe("the identity of a board card", () => {
  it("says who opened it in the tooltip, and how long since anything moved at the end of the event line", () => {
    expect(cardSrc).toContain('<span className="agx-cd-eta">· {age}</span>');
    expect(board).toContain("ago(p.updatedAt)");
  });
});

describe("the repository on the board, and results as cards", () => {
  const theirs = (n: number, o: Parameters<typeof pr>[1] = {}) => pr(n, { author: "other", ...o });

  it("the two queues ignore the repository's page", () => {
    const html = render({ mine: [pr(1)], review: [], others: [theirs(10, { fail: 2 })], total: -1 });
    expect(html).toContain('data-pr="1"');
    expect(html).not.toContain('data-pr="10"');
  });

  it("the default view holds only the viewer's stake: no repository page, no lane for others, no pager", () => {
    const html = render({ mine: [pr(1)], review: [], others: [theirs(10)], total: -1 });
    expect(html).toContain('data-pr="1"');
    expect(html).not.toContain('data-pr="10"');
    expect(html).not.toContain("on this page of the repository");
    expect(html).not.toContain("Load more pull requests");
    // The lane for what others owe is always drawn, but holds none of the page.
    expect(column(html, "others")).not.toContain("data-pr=");
  });

  it("results are rows, merged ones included, never cards in a lane and never filed under Blocked", () => {
    const html = render({
      results: {
        title: "closed and merged pull requests", loading: false, empty: "none", onBack: () => {},
        rows: [theirs(20, { state: "MERGED", fail: 1 }), theirs(21, { state: "CLOSED" }), theirs(22)],
      },
    });
    expect(html).toContain('data-results');
    expect((html.match(/data-pr="/g) ?? []).length).toBe(3);
    expect(html).toContain('class="agx-srow"');
    expect((html.match(/class="agx-srow"/g) ?? []).length).toBe(3);
    expect(html).not.toContain("agx-prc");
    // In a search the state is a tag on the right, not a word in the meta line.
    expect(html).toMatch(/agx-pc-tag[^>]*>merged</);
    expect(html).toMatch(/agx-pc-tag[^>]*>closed</);
    expect(html).not.toContain("data-lane=");
    expect(html).not.toContain("Blocked");
    expect(html).toContain("Back to the board");
  });

  it("an empty result says why", () => {
    const html = render({ results: { title: "x", loading: false, empty: "No pull requests match this search.", onBack: () => {}, rows: [] } });
    expect(html).toContain("No pull requests match this search.");
  });
});
