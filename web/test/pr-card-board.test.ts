/*
 * The board's card as the redesign draws it: the band, the three fixed slots of
 * the footer, the right-click menu and where each of them is wired. Drawn with
 * the real board through renderToStaticMarkup, and the wiring asserted against
 * source because there is no renderer for a keypress.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard, medianAge } from "../src/components/TriageBoard.tsx";
import { Button, CTRL_H } from "../src/components/workspace/Chrome.tsx";
import { HIT } from "../src/lib/iconSize.ts";
import type { PrSummary } from "../../shared/types.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const board = read("../src/components/TriageBoard.tsx");
const panel = read("../src/components/PrPanel.tsx");
const menuSrc = read("../src/components/PrCardMenu.tsx");
const css = read("../src/index.css");

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

describe("the footer has one row: the primary, the secondary slot, and the three small buttons", () => {
  it("draws them in that order on every card", () => {
    const c = card(render({ mine: [pr(1)] }), 1);
    const f = c.indexOf('class="agx-cd-f"');
    const l = c.indexOf("agx-cd-f-l"), icb = c.indexOf("agx-cd-icb");
    expect(f).toBeGreaterThan(0);
    expect(l).toBeGreaterThan(f);
    expect(icb).toBeGreaterThan(l);
    expect(c).toContain('aria-label="More actions for #1"');
    expect(c).toContain('aria-label="Copy the link to #1"');
    expect(c).toContain('aria-label="Pin #1"');
  });
  it("a branch that is level says so as quiet text and offers nothing to press", () => {
    const c = card(render({ mine: [pr(1)] }), 1);
    expect(c).toContain('class="agx-cd-utd"');
    expect(c).toContain("Up to date");
  });
  it("a conflict turns the slot into Resolve conflicts and puts the tag beside the route", () => {
    const c = card(render({ mine: [pr(2, { mergeable: "CONFLICTING" })] }), 2);
    expect(c).toContain("Resolve conflicts");
    expect(c).not.toContain("Up to date");
    expect(c).toContain(">conflict<");
  });
  it("the primary is Review in your review lane and Merge on a card that can land", () => {
    expect(card(render({ review: [pr(3, { author: "theo-w" })] }), 3)).toContain(">Review<");
    expect(card(render({ mine: [pr(4, { reviewDecision: "APPROVED", mergeable: "MERGEABLE" })] }), 4)).toContain(">Merge<");
  });
  it("is Rerun failed on a red card with no conflict", () => {
    const red = pr(5, { mergeable: "MERGEABLE", checks: { total: 3, success: 2, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [] } });
    expect(card(render({ mine: [red] }), 5)).toContain("Rerun failed");
  });
});

describe("the card is reachable and opens its menu without a right button", () => {
  const cardSrc = read("../src/components/PrCard.tsx");
  it("is a tab stop that names its menu", () => {
    expect(card(render({ mine: [pr(1)] }), 1)).toBeTruthy();
    const open = cardSrc.slice(cardSrc.indexOf("<div ref={props.cardRef} onClick={props.onOpen}"), cardSrc.indexOf('className="agx-cd">'));
    expect(open).toContain("tabIndex={0}");
    expect(open).toContain('aria-haspopup="menu"');
  });
  it("opens at the pointer on a right press, and at the card's corner on Shift+F10 or the menu key", () => {
    expect(cardSrc).toContain("props.onMenu({ x: e.clientX, y: e.clientY })");
    expect(cardSrc).toContain('e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")');
    expect(cardSrc).toContain("menuAt(e.currentTarget, 24, 24)");
  });
  it("opens below the dots button, six pixels under it", () => {
    expect(cardSrc).toContain("menuAt(e.currentTarget, 0, e.currentTarget.getBoundingClientRect().height + 6)");
  });
  it("the unread mark is a dot that carries the count in its tooltip", () => {
    expect(cardSrc).toContain('className="agx-cd-unread"');
    expect(cardSrc).toContain("data-tip={tip(props.unread)}");
    expect(cardSrc).not.toContain("<UnreadBadge");
    expect(board).toContain("unread={unread ? unreadTitle(unread) : null}");
  });
});

describe("the menu walks like a menu", () => {
  it("wraps the arrows, jumps with Home and End, and skips what is off", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End"]) expect(menuSrc).toContain(`"${k}"`);
    expect(menuSrc).toContain("(at + 1) % order.length");
    expect(menuSrc).toContain("walkIds(menu, more)");
  });
  it("an entry that is off is announced as off, says why, and presses nothing", () => {
    expect(menuSrc).toContain("aria-disabled={it.why ? true : undefined}");
    expect(menuSrc).toContain("if (it.why) return;");
  });
  it("prints the count it computed, not one written down", () => {
    expect(menuSrc).toContain("{menu.more.length} more");
    expect(menuSrc).not.toMatch(/\b1[123] more\b/);
  });
  it("is 268 wide", () => {
    expect(menuSrc).toContain("export const MENU_WIDTH = 268;");
    expect(menuSrc).toContain("width={MENU_WIDTH}");
  });
});

describe("a card never merges by itself", () => {
  const onAct = panel.slice(panel.indexOf("onAct={(p, what) => {"), panel.indexOf("}} />", panel.indexOf("onAct={(p, what) => {")));
  it("sends no merge from the board: it opens the page and the page's dialog runs", () => {
    expect(onAct).not.toContain("api.prMerge");
    expect(onAct).toContain('case "merge": case "squash": case "rebase": case "close":');
    expect(panel).toContain('case "merge": void doMerge(mergeMethod); break;');
  });
  it("the intent is dropped when you go somewhere else, and after the same window an agent's request gets", () => {
    expect(panel).toContain("selected !== wantAct.n || Date.now() - wantAct.at > UNSTICK_TTL_MS");
  });
  it("a re-run and an update of the branch need only a number, so they run from the card", () => {
    expect(onAct).toContain('api.prRerun(root, p.number)');
    expect(onAct).toContain("doUpdateBranch(false, {");
  });
});

describe("the lane around the cards", () => {
  it("has a tile, its sentence under the name, and says how old the middle one is", () => {
    const html = render({ mine: [pr(1), pr(2)] });
    expect(html).toContain('class="agx-pl-tile"');
    expect(html).not.toContain("agx-pl-help");
    expect(html).toContain("data-tip=");
    expect(html).toContain("Median age");
  });
  it("an empty lane says it is quiet, and a lane that is only hidden says so", () => {
    expect(render({ mine: [pr(1)] })).toContain("Nothing here. Quiet is good.");
  });
  it("medianAge is the middle one, in hours, and days past two of them", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    const at = (h: number) => ({ updatedAt: new Date(now - h * 3_600_000).toISOString() }) as PrSummary;
    expect(medianAge([at(1), at(3), at(10)], now)).toBe("3 h");
    expect(medianAge([at(2), at(4)], now)).toBe("3 h");
    expect(medianAge([at(100)], now)).toBe("4 d");
    expect(medianAge([], now)).toBeNull();
  });
});

describe("the kit's 26px button", () => {
  it("is the house's square target, and a card button gives a little under the finger", () => {
    expect(CTRL_H.hit).toBe(HIT);
    const html = renderToStaticMarkup(React.createElement(Button, { size: "hit", tone: "quiet", square: true, label: "x", children: "y" }));
    expect(html).toContain("height:26px");
    expect(css).toMatch(/\.agx-cd-f \.agx-btn:active:not\(:disabled\) \{ transform: scale\(\.97\); \}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.agx-cd, \.agx-cd::after \{ transition: none; \}/);
  });
});
