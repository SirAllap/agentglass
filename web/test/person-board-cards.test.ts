/*
 * Somebody else's board draws the owner's cards: lazy, windowed, honest when empty.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard } from "../src/components/TriageBoard.tsx";
import { closedAt, dayGroup, groupClosed } from "../src/lib/closedList.ts";
import { closedQuery } from "../src/lib/prClosed.ts";
import type { PrSummary } from "../../shared/types.ts";

const noop = () => {};
const row = (n: number, o: Partial<PrSummary> = {}): PrSummary => ({
  number: n, title: `Change ${n}`, author: "ana-dev", state: "OPEN", isDraft: false, headRefName: `feat/thing-${n}`, baseRefName: "main",
  url: "", updatedAt: "2026-10-01T10:00:00Z", reviewDecision: null, additions: 10, deletions: 2, changedFiles: 1,
  labels: [], assignees: [], milestone: null,
  checks: { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
}) as unknown as PrSummary;
const rows = (n: number, o: Partial<PrSummary> = {}) => Array.from({ length: n }, (_, i) => row(i + 1, o));
const props = (extra: Record<string, unknown>) => ({
  mine: [], review: [], onOpen: noop, onTogglePin: noop, onShowTable: noop, onAct: noop, busy: new Set<number>(), acting: null,
  loading: false, settling: false, failed: false, hidden: 0, onRetry: noop, pinned: () => false, root: "", repoKey: "acme/orbit",
  total: -1, hasTaskProvider: false, viewer: "ana-dev", ...extra,
}) as never;
const draw = (extra: Record<string, unknown>) => renderToStaticMarkup(React.createElement(TriageBoard, props(extra)));
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const sec = (id: string, rs: PrSummary[], more?: () => void) => ({ id, label: id === "merged" ? "Merged" : "Closed without merging", rows: rs, total: rs.length, loading: false, more });

describe("an empty person's board", () => {
  it("shows the shape of the lanes, never 'Nothing open', while it is being read", () => {
    const html = draw({ loading: true, person: { onBack: noop, more: false } });
    expect(html).toContain("agx-prc-sk");
    expect(html).not.toContain("Nothing open");
  });
  it("0 open: says it was checked, and offers their closed and merged ones in one click", () => {
    const html = draw({ person: { onBack: noop, more: false, follow: { on: false, toggle: noop }, checkedAt: Date.now(), closed: { on: false, set: noop, sections: [] } } });
    expect(html).toContain("Nothing open");
    expect(html).toContain("Checked just now");
    expect(html).toContain("Show ana-dev&#x27;s closed and merged PRs");
    expect(html).toContain("Follow"); // the banner stays
  });
  it("0 closed: the Closed list's own empty state, under the banner, no open-only wording", () => {
    const html = draw({ person: { onBack: noop, more: false, follow: { on: false, toggle: noop }, closed: { on: true, set: noop, sections: [sec("merged", []), sec("unmerged", [])] } } });
    expect(html).toContain("Nothing closed");
    expect(html).toContain("Follow");
    expect(html).not.toContain("Nothing open");
  });
  it("closed, still loading: the Closed list's skeleton", () => {
    const s = [{ ...sec("merged", []), loading: true }, { ...sec("unmerged", []), loading: true }];
    const html = draw({ person: { onBack: noop, more: false, closed: { on: true, set: noop, sections: s } } });
    expect(html).toContain("animate-pulse");
  });
});

describe("a long person's board is the board's own columns", () => {
  it("150 open pull requests: lane columns, each capped like yours, the rest one press away", () => {
    const html = draw({ mine: rows(150), person: { onBack: noop, more: false } });
    const n = count(html, /data-pr="/g);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(150);
    expect(html).toContain("data-lane=");
    expect(html).toContain("Show the other");
    expect(html).not.toContain("data-person-section");
    expect(html).toContain("data-person-banner");
  });
  it("125 closed ones: the Closed list, a chunk of 60, one fixed row height", () => {
    const merged = rows(125, { state: "MERGED" } as never);
    const html = draw({ person: { onBack: noop, more: false, closed: { on: true, set: noop, sections: [sec("merged", merged), sec("unmerged", [])] } } });
    expect(count(html, /data-pr="/g)).toBe(30);
    expect(html).toContain("data-closed-more");
    expect(html).toContain("data-closed-list");
    expect(html).toContain("data-person-banner");
  });
  it("every lane is a column, empty or not, as on your board", () => {
    const html = draw({ mine: rows(2), person: { onBack: noop, more: false } });
    expect(count(html, /data-lane="/g)).toBeGreaterThanOrEqual(4);
  });
});

describe("the closed query for a person", () => {
  it("is the same two searches with their login, and nothing else gets in", () => {
    expect(closedQuery("merged", "ana-dev")).toBe("author:ana-dev is:merged");
    expect(closedQuery("unmerged", "ana-dev")).toBe("author:ana-dev is:closed is:unmerged");
    expect(closedQuery("merged")).toBe("author:@me is:merged");
    expect(closedQuery("merged", "x is:open")).toBe("author:xisopen is:merged");
  });
});

describe("the sources behind the numbers", async () => {
  const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  const person = await Bun.file(new URL("../src/lib/personBoard.ts", import.meta.url)).text();
  const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
  it("the counter counts the person's board, not the owner's Open list", () => {
    expect(panel).toContain("total={personLogin != null ? personCount ?? null");
  });
  it("the Closed tab drives the person's closed view", () => {
    expect(panel).toContain("const personClosedOn = personLogin != null && closedOn;");
  });
  it("no row is handed to the tracker before its card is on screen", () => {
    const start = panel.indexOf("const personLists = useMemo(");
    const body = panel.slice(start, panel.indexOf("}, [person.state, personFilled", start));
    expect(body).not.toContain("withCard(");
    expect(board).toContain("lazyCard && !everOn.current ? p.card");
  });
  it("another person's cards are never drawn for this one", () => {
    expect(person).toContain("held.key === key ? held.state : { kind: \"loading\" }");
  });
});

describe("the Closed list", () => {
  const closedRow = (n: number, o: Record<string, unknown> = {}) => row(n, { state: "MERGED", closed: {
    at: "2026-10-29T09:00:00Z", openedAt: "2026-10-27T09:00:00Z", by: "bo-dev", method: "squash",
    checks: { total: 4, success: 4, failure: 0, skipped: 0, failing: [] }, commits: 1,
    reviews: { approved: ["bo-dev"], changes: [], rounds: 1, comments: 0 }, why: null, ...o } } as never);
  it("a card is grouped by when it ended: the finished facts, else the list's own stamp", () => {
    expect(closedAt(closedRow(2))).toBe("2026-10-29T09:00:00Z");
    expect(closedAt(row(3, { state: "CLOSED", updatedAt: "2026-10-28T08:00:00Z" } as never))).toBe("2026-10-28T08:00:00Z");
  });
  it("groups by the day it ended, newest first", () => {
    const now = new Date("2026-10-30T12:00:00");
    expect(dayGroup("2026-10-30T01:00:00", now)).toBe("Today");
    expect(dayGroup("2026-10-29T23:00:00", now)).toBe("Yesterday");
    expect(dayGroup("2026-10-26T10:00:00", now)).toBe("This week");
    expect(dayGroup("2026-10-20T10:00:00", now)).toBe("Last week");
    expect(dayGroup("2026-08-02T10:00:00", now)).toContain("2026");
    const g = groupClosed([{ at: "2026-10-30T01:00:00" }, { at: "2026-10-30T00:30:00" }, { at: "2026-10-29T10:00:00" }], now);
    expect(g.map((x) => [x.label, x.rows.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });
  it("550 cards mount a chunk of 30", () => {
    const html = draw({ viewer: undefined, results: { title: "t", rows: [], sections: [sec("merged", rows(550, { state: "MERGED" } as never))], loading: false, empty: "", onBack: noop } });
    expect(count(html, /data-pr="/g)).toBe(30);
    expect(html).toContain("data-closed-more");
    expect(html).toContain("October 2026");
  });
});
