/*
 * What the review menu preselects as the status to move the card to.
 *
 * Status names are per list ("Code Review", "In review", "PR up"), so the rule
 * is: the workspace's own names first, else any open status with "review" in
 * it, else leave the card alone. A status that closes the card is never the
 * answer, and neither is the one it is already in.
 */
import { describe, expect, test } from "bun:test";
import type { ListStatus } from "../../shared/providers.ts";
import type { ReviewRecipeContext } from "../../shared/types.ts";
import { cardNoteText, reviewStatus } from "../src/lib/cardMove.ts";

const st = (status: string, type = "custom", orderindex = 0): ListStatus => ({ status, type, orderindex });
const board = [st("Open", "open"), st("In Progress"), st("PR up"), st("Code Review"), st("Reviewed", "done"), st("Closed", "closed")];

describe("reviewStatus", () => {
  test("names win, in the order written, whatever the regex would have picked", () => {
    expect(reviewStatus(board, "In Progress", ["pr up", "Code Review"])).toBe("PR up");
    expect(reviewStatus(board, "In Progress", ["Nope", "code review"])).toBe("Code Review");
  });
  test("no names: the first open status with review in its name", () => {
    expect(reviewStatus(board, "In Progress", [])).toBe("Code Review");
  });
  test("names written and none on the list: leave it alone, do not guess past them", () => {
    expect(reviewStatus(board, "In Progress", ["Peer check"])).toBe("");
  });
  test("no match at all: leave it alone", () => {
    expect(reviewStatus([st("Open", "open"), st("Doing")], "Doing", [])).toBe("");
  });
  test("a done-typed Reviewed is never chosen, by regex or by name", () => {
    const b = [st("Open", "open"), st("Reviewed", "done")];
    expect(reviewStatus(b, "Open", [])).toBe("");
    expect(reviewStatus(b, "Open", ["Reviewed"])).toBe("");
  });
  test("the status the card is in is not offered", () => {
    expect(reviewStatus(board, "Code Review", [])).toBe("");
    expect(reviewStatus(board, "code review", ["Code Review"])).toBe("");
  });
});

const ctx: ReviewRecipeContext = { number: 17, repo: "acme/orbit", head: "a1b2c3d", branch: "fix/total", title: "Fix the total", author: "ada", url: "https://git.example/acme/orbit/pull/17", who: "@Grace" };
const SHIPPED = "{who} PR ready to review — #{number} {title}\n{url}";

describe("cardNoteText", () => {
  test("the shipped wording, with the mention", () => {
    expect(cardNoteText(undefined, SHIPPED, ctx)).toBe("@Grace PR ready to review — #17 Fix the total\nhttps://git.example/acme/orbit/pull/17");
  });
  test("nobody on the card: no gap where the mention was", () => {
    expect(cardNoteText(SHIPPED, "x", { ...ctx, who: "" })).toBe("PR ready to review — #17 Fix the total\nhttps://git.example/acme/orbit/pull/17");
  });
  test("an edited wording replaces the shipped one", () => {
    expect(cardNoteText("{who} look at #{number}", SHIPPED, ctx)).toBe("@Grace look at #17");
  });
  test("an empty body falls back", () => {
    expect(cardNoteText("  ", "fallback {number}", ctx)).toBe("fallback 17");
  });
});

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname).text();
const slice = (open: string, close: string) => { const a = src.indexOf(open); return src.slice(a, src.indexOf(close, a)); };

describe("the sidebar gates on the settings", () => {
  test("the review preselect is reviewStatus with the saved names, not an inline regex", () => {
    const body = slice("function ClickUpSide(", "\ntype Facets");
    expect(body).toContain("reviewStatus(st, t.status, prefs.review.statusNames)");
    expect(body).not.toContain("/review/i");
  });
  test("the move item is a step: preselected only when added, its Status block absent otherwise", () => {
    const body = slice("function ClickUpSide(", "\ntype Facets");
    expect(body).toContain('prefs?.review.enabled ? reviewStatus(');
    expect(body).toContain("const moveOn = reviewPrefs?.enabled === true;");
    expect(body).toContain("{moveOn && (");
    expect(body).toContain("if (!ref || (!moveOn && !assignReviewer)) return null;");
  });
  test("putting people on the card needs assignReviewer, and unknown reads as off", () => {
    const body = slice("function ClickUpSide(", "\ntype Facets");
    expect(body).toContain("reviewPrefs?.assignReviewer === true");
    expect(body).toContain("on: assignReviewer ? on : was");
    expect(body).toContain("{assignReviewer && <>");
  });
  test("the note button needs noteOnCard, and unknown reads as off", () => {
    const body = slice("function CardFacts(", "\n/** Who the note is for");
    expect(body).toContain("useClickupPrefs()?.flows.noteOnCard === true");
    expect(body).toContain("{noteOnCard && (");
  });
});
