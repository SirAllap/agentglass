/*
 * The Review cell has three states, not one: a review a person gave opens the
 * Conversation under "All", a bot's under "Bots", and a review that was only
 * asked for opens nothing at all — not even GitHub. The decision is one pure
 * function; the card is drawn with the real board, and the click is read from
 * source because a handler does not run under renderToStaticMarkup.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard } from "../src/components/TriageBoard.tsx";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import { reviewTarget } from "../src/lib/reviewTarget.ts";
import type { PrSummary } from "../../shared/types.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const board = read("../src/components/TriageBoard.tsx");
const cardSrc = read("../src/components/PrCard.tsx");
const panel = read("../src/components/PrPanel.tsx");

const day = 86_400_000;
const pr = (number: number, o: Record<string, unknown> = {}): PrSummary => ({
  number, title: `pull request ${number}`, author: "mara-k", state: "OPEN", isDraft: false,
  headRefName: `h${number}`, baseRefName: "main", url: "", updatedAt: new Date(Date.now() - day).toISOString(),
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
}) as unknown as PrSummary;

const render = (p: Partial<React.ComponentProps<typeof TriageBoard>>): string =>
  renderToStaticMarkup(React.createElement(TriageBoard, {
    mine: [], review: [], total: 0, hasTaskProvider: false, pinned: () => false, onOpen: () => {}, onTogglePin: () => {},
    onShowTable: () => {}, onAct: () => {}, onlyUnread: false, onOnlyUnread: () => {}, ...p,
  }));
const card = (html: string, n: number): string => {
  const at = html.indexOf(`data-pr="${n}"`);
  return at < 0 ? "" : html.slice(at, html.indexOf("data-pr=", at + 10) < 0 ? undefined : html.indexOf("data-pr=", at + 10));
};
const REVIEW_URL = "https://github.example/acme/orbit/pull/1#pullrequestreview-1";
const human = (kind: "approved" | "changes" | "commented" | "awaiting", n = 1) =>
  pr(n, { humanReview: { kind, who: ["theo-w"], at: new Date(Date.now() - day).toISOString(), url: REVIEW_URL } });
const botOnly = (n = 1) => pr(n, { reviewDecision: "APPROVED", mergeable: "MERGEABLE" });

describe("the cell's state is one decision", () => {
  it("a review asked for and not answered goes nowhere", () => {
    expect(reviewTarget(cardReviewers({ kind: "awaiting", who: ["theo-w"], url: REVIEW_URL }), undefined)).toBeNull();
  });

  it("a pull request nobody has been asked about goes nowhere", () => {
    expect(reviewTarget(cardReviewers(undefined), undefined)).toBeNull();
  });

  it("a person's review is the Conversation, unfiltered", () => {
    for (const kind of ["approved", "changes", "commented"] as const) {
      expect(reviewTarget(cardReviewers({ kind, who: ["theo-w"] }), undefined)?.lane).toBe("all");
    }
    // Re-review requested: a review was given and a push sent it back.
    expect(reviewTarget(cardReviewers({ kind: "approved", who: ["theo-w"], cleared: true }), undefined)?.lane).toBe("all");
  });

  it("a bot's approval is the same place, filtered to Bots", () => {
    expect(reviewTarget(cardReviewers(undefined), true)).toEqual({ lane: "bot" });
  });

  /* The difference between opening the tab and landing on the review: without
     an address the press scrolls nowhere and the reader hunts. */
  it("carries the row of the review the cell is about", () => {
    expect(reviewTarget(cardReviewers({ kind: "changes", who: ["theo-w"] }), undefined, { human: "PRR_human" }))
      .toEqual({ lane: "all", node: "PRR_human" });
    expect(reviewTarget(cardReviewers(undefined), true, { bot: "PRR_bot" }))
      .toEqual({ lane: "bot", node: "PRR_bot" });
  });

  /* A server older than the field sends no id: the press must still open the
     lane, and must not invent an address to look for. */
  it("with no address in hand, the lane alone", () => {
    expect(reviewTarget(cardReviewers({ kind: "approved", who: ["theo-w"] }), undefined, {})).toEqual({ lane: "all" });
    expect(reviewTarget(cardReviewers(undefined), true, { human: "PRR_human" })).toEqual({ lane: "bot" });
  });
});

describe("the Review cell draws those three states", () => {
  it("requested and not answered: no button, no GitHub, even with an address in hand", () => {
    const c = card(render({ review: [human("awaiting")] }), 1);
    expect(c).toContain("1 waiting");
    expect(c).not.toContain('aria-label="Review:');
    expect(c).not.toContain("Open the review in the conversation");
    expect(c).not.toContain("Open the bot");
    expect(c).not.toContain("github.example");
  });

  it("a bot's approval: the Conversation under Bots", () => {
    const c = card(render({ mine: [botOnly()] }), 1);
    expect(c).toContain("bot approved");
    expect(c).toContain("Open the bot&#x27;s review under Bots");
    expect(c).not.toContain("Open the review in the conversation");
  });

  it("a person's review: the Conversation under All", () => {
    const c = card(render({ review: [human("changes")] }), 1);
    expect(c).toContain("Open the review in the conversation");
  });

  it("GitHub is only what a board with no handler falls back to", () => {
    const click = cardSrc.slice(cardSrc.indexOf("const canOpenReview ="), cardSrc.indexOf("const b = cv.branch;"));
    expect(click).toContain("!!target && !!(props.onOpenReview || props.reviewUrl)");
    expect(click).toContain("if (props.onOpenReview) props.onOpenReview(target!)");
    expect(click).toContain("openExternal(props.reviewUrl");
    expect(click).not.toContain("onClick={stop(() => window.open(");
  });
});

describe("where the press lands", () => {
  it("the lane turns the target into a filter, and the panel sets it", () => {
    expect(board).toContain('onOpenReview={(target) => onOpen(p.number, target.lane === "bot" ? "bots" : "review", undefined, target.node)}');
    expect(board).toContain("const reviewGo = reviewTarget(reviewers, cv.review.bot, { human: p.humanReview?.nodeId, bot: p.botReview?.nodeId });");
    expect(board).toContain("reviewTarget={reviewGo} onOpenReview={onOpenReview}");
    const open = panel.slice(panel.indexOf("const openPr = useCallback("), panel.indexOf("/** A pin from another repository"));
    expect(open).toMatch(/to === "review"\) \{ setConvWho\("all"\); setTab\("conversation"\); \}/);
    expect(open).toMatch(/to === "bots"\) \{ setConvWho\("bot"\); setTab\("conversation"\); \}/);
    // The address rides through the dock call: a lane without it is the tab.
    expect(open).toContain('if (node && (to === "review" || to === "bots")) setWantReviewRow({ number: n, node });');
  });

  /* The row is waited for rather than read once: the detail may still be on its
     way, and a page that finds nothing on the first frame looks like a no-op. */
  it("the panel lands on the row, retrying a bounded number of frames", () => {
    expect(panel).toContain('landOn(`[data-node="${CSS.escape(want.node)}"]`');
    expect(panel).toContain("if (++tries < 90) { requestAnimationFrame(look); return; }");
    expect(panel).toContain("el.scrollIntoView({ block: \"center\", behavior: \"smooth\" });\n    flashElement(el);");
    // And says so when the review genuinely has no row, rather than nothing.
    expect(panel).toContain("That review is not in the conversation of #${want.number} — showing all of it");
  });

  it("a review with nothing to say is still a row to land on", () => {
    // The card inside is drawn only when the review has a body; the plain
    // approval — the case this whole cell is about — draws none.
    expect(panel).toContain("nodeId: r.nodeId ?? undefined,");
    expect(panel).toContain('data-node={e.nodeId}');
  });
});
