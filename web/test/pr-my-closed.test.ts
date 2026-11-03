/*
 * The "Closed" pill: the viewer's own merged and closed pull requests, in one list
 * under an All | Merged | Closed switch. Pinned: the pill exists, the queries are the two halves of
 * "closed" and name the viewer, typing never asks for them, and each section is
 * drawn with its own heading, count, state and Load more.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard } from "../src/components/TriageBoard.tsx";
import { CLOSED_SECTIONS } from "../src/lib/prClosed.ts";
import { personIn, singleLogin, toServerQuery } from "../src/lib/prSearch.ts";
import type { PrSummary } from "../../shared/types.ts";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const hook = await Bun.file(new URL("../src/lib/prClosed.ts", import.meta.url)).text();

const pr = (number: number, state: "MERGED" | "CLOSED"): PrSummary => ({
  number, title: `change ${number}`, author: "ana", state, isDraft: false,
  headRefName: `h${number}`, baseRefName: "main", url: "", updatedAt: new Date().toISOString(),
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { total: 1, success: 1, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
} as unknown as PrSummary);

const board = (sections: NonNullable<React.ComponentProps<typeof TriageBoard>["results"]>["sections"]) =>
  renderToStaticMarkup(React.createElement(TriageBoard, {
    mine: [], review: [], total: 0, hasTaskProvider: false,
    pinned: () => false, onOpen: () => {}, onTogglePin: () => {}, onShowTable: () => {}, onAct: () => {},
    onlyUnread: false, onOnlyUnread: () => {},
    results: { title: "t", rows: sections!.flatMap((s) => s.rows), sections, loading: false, empty: "none", onBack: () => {} },
  }));

describe("the Closed pill", () => {
  it("sits with the other pills; Open is the way back", () => {
    expect(panel).toContain('label: "Closed"');
    expect(panel).toContain("setClosedOn(true)");
  });
  it("asks for the viewer's own, merged first, as two searches", () => {
    expect(CLOSED_SECTIONS.map((s) => s.id)).toEqual(["merged", "unmerged"]);
    expect(CLOSED_SECTIONS[0].query).toBe("author:@me is:merged");
    expect(CLOSED_SECTIONS[1].query).toBe("author:@me is:closed is:unmerged");
  });
  it("sends nothing on typing: requests live only in the hook, gated by the pill", () => {
    // Fetched once the repo is known, so the pill carries its number at rest.
    expect(panel).toContain("useMyClosed(root, closedOn || (active && !!repo))");
    expect(hook).toContain("if (!on || !root) return;");
    expect(hook).not.toMatch(/setInterval/);
  });
});

describe("author:me and @me", () => {
  it("mean the viewer, never a login to open a board for", () => {
    expect(singleLogin("author:me")).toBeNull();
    expect(singleLogin("author:@me")).toBeNull();
    expect(personIn("author:me")).toBeNull();
    expect(toServerQuery("@me")).toBe("author:@me");
    expect(toServerQuery("author:me fix")).toBe("author:me fix");
  });
  it("still opens a colleague's board for a real login", () => {
    expect(singleLogin("author:meg")).toBe("meg");
  });
});

describe("the closed list", () => {
  const html = board([
    { id: "merged", label: "Merged", rows: [pr(1, "MERGED"), pr(2, "MERGED")], total: 41, loading: false, more: () => {} },
    { id: "unmerged", label: "Closed without merging", rows: [pr(3, "CLOSED")], total: 1, loading: false },
  ]);
  it("is one list under an All | Merged | Closed switch whose labels are plain words", () => {
    expect(html).toContain('aria-label="Show"');
    expect(html).toMatch(/>All</);
    expect(html).toMatch(/>Merged</);
    expect(html).toMatch(/>Closed</);
    expect(html).not.toMatch(/All <small/);
    expect(html).not.toContain("data-section=");
  });
  it("shows each card's state and gives the whole list one Load more", () => {
    expect((html.match(/data-pr="/g) ?? []).length).toBe(3);
    expect(html).toContain(". Merged");
    expect(html).toContain(". Closed · not merged");
    expect((html.match(/Load more/g) ?? []).length).toBe(1);
  });
  it("says so, with a state of its own, when nothing is closed", () => {
    const empty = board([
      { id: "merged", label: "Merged", rows: [], total: 0, loading: false },
      { id: "unmerged", label: "Closed without merging", rows: [], total: 0, loading: false },
    ]);
    expect(empty).toContain("Nothing closed");
  });
});
