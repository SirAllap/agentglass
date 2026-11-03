/*
 * THE JIRA CARD ON THE PULL REQUEST BOARD.
 *
 * The server now hands a row its Jira card (`card.tracker === "jira"`) even for
 * a key no saved board holds. What the board owes it: draw it with the SAME
 * chip row a ClickUp card gets, and never ask ClickUp about a key that is
 * Jira's. A second chip component for Jira is the drift this file exists to stop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PrSummary } from "../../shared/types.ts";
import { withCard } from "../src/lib/prCardStore.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const pr = (card: PrSummary["card"], title = "ORBIT-1042: Retry the export"): PrSummary => ({
  number: 7, title, headRefName: "feat/orbit-1042-retry", card,
} as PrSummary);

describe("a Jira card on the board", () => {
  test("is drawn by the one ticket row, and the board has no second one", () => {
    const board = read("src/components/TriageBoard.tsx");
    const card = read("src/components/PrCard.tsx");
    expect(board).toContain("withCard(p, hasTaskProvider).card");
    expect(board).toContain("<PrCard ");
    expect(card, "the ticket row reads the card's own id, whichever tracker it is").toContain("cv.tracker === \"card\"");
    expect(board.includes("tracker === \"jira\""), "no Jira-only chip on the board").toBe(false);
    expect(card.includes("tracker === \"jira\""), "no Jira-only chip on the card").toBe(false);
  });

  test("is left as the server drew it, with no request to ClickUp", () => {
    const card = { id: "10042", customId: "ORBIT-1042", title: "Retry the export", url: "https://acme.atlassian.net/browse/ORBIT-1042",
      status: "In Review", statusKind: "open" as const, tracker: "jira" as const, at: Date.now() };
    const row = pr(card as PrSummary["card"]);
    expect(withCard(row, true)).toBe(row);
  });
});
