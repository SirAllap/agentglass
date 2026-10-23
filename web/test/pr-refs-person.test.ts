/*
 * A card key typed into the pull request search, and a colleague's board that
 * opens by itself under a yellow bar.
 *
 * Pure parts are asserted as values; the board is drawn to markup, because a
 * rule about "the banner shows only on somebody else's board" is a rule about
 * what is on the screen.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { refKey, refsIn, refToken, refPlaces, refWhy, withBranchHits } from "../src/lib/prRefs.ts";
import { toServerQuery, singleLogin, SEARCH_HINT } from "../src/lib/prSearch.ts";
import { TriageBoard, PersonBanner } from "../src/components/TriageBoard.tsx";
import { lanesFor, LANES, board, fileInLane } from "../src/lib/prLanes.ts";
import type { PrSummary } from "../../shared/types.ts";

const row = (o: Partial<PrSummary> = {}): PrSummary => ({
  number: 1, title: "Add the thing", author: "ana-dev", state: "OPEN", isDraft: false,
  headRefName: "feat/add-thing", baseRefName: "main", url: "", updatedAt: "2026-10-01T00:00:00Z", reviewDecision: null,
  additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
}) as unknown as PrSummary;

describe("a card key is recognised", () => {
  test("any LETTERS-digits key, any case, nothing else", () => {
    expect(refKey("ORBIT-1042")).toBe("ORBIT-1042");
    expect(refKey("orbit-1042")).toBe("ORBIT-1042");
    expect(refKey("Orbit-7")).toBe("ORBIT-7");
    for (const no of ["1042", "#1042", "orbit", "orbit-", "-1042", "orbit-10x", "orbit 1042", "author:ana-dev", "a-b-1", "ana-dev", "x".repeat(12) + "-1", "ORBIT-1234567890"])
      expect(refKey(no)).toBeNull();
  });
  test("references among the free words, once each; qualifiers are not words", () => {
    expect(refsIn("orbit-1042")).toEqual(["ORBIT-1042"]);
    expect(refsIn("ORBIT-1042 acme-9 orbit-1042 fix")).toEqual(["ORBIT-1042", "ACME-9"]);
    expect(refsIn("author:ORBIT-1")).toEqual([]);
    expect(refsIn("ref:orbit-5")).toEqual(["ORBIT-5"]);
    expect(refsIn("")).toEqual([]);
  });
});

describe("the query that is sent", () => {
  test("a key becomes one ref: token, upper-cased, so one query is one cache entry", () => {
    expect(toServerQuery("orbit-1042")).toBe("ref:ORBIT-1042");
    expect(toServerQuery("ORBIT-1042")).toBe(toServerQuery("orbit-1042"));
    expect(refToken("ORBIT-1042")).toBe("ref:ORBIT-1042");
  });
  test("numbers, logins, qualifiers and title words keep working beside it", () => {
    expect(toServerQuery("#19811")).toBe("19811");
    expect(toServerQuery("PR 19811")).toBe("19811");
    expect(toServerQuery("ana-dev", new Set(["ana-dev"]))).toBe("involves:ana-dev");
    expect(toServerQuery("@ana-dev", new Set(["ana-dev"]))).toBe("involves:ana-dev");
    expect(toServerQuery("author:ana-dev reviewer:bo-dev")).toBe("author:ana-dev reviewer:bo-dev");
    expect(toServerQuery("assignee:bo-dev retry")).toBe("assignee:bo-dev retry");
    expect(toServerQuery("author:ana-dev orbit-1042 retry")).toBe("author:ana-dev ref:ORBIT-1042 retry");
  });
  test("a known login that looks like a key is a person, not a card", () => {
    expect(toServerQuery("ana-42", new Set(["ana-42"]))).toBe("involves:ana-42");
  });
  test("the box says it understands keys", () => {
    expect(SEARCH_HINT).toContain("ORBIT-1042");
  });
});

describe("why a card matched", () => {
  const keys = ["ORBIT-1042"];
  test("branch, title, or — when neither carries it — the description", () => {
    expect(refPlaces(row({ headRefName: "feat/orbit-1042-add-thing" }), "ORBIT-1042")).toEqual(["branch"]);
    expect(refPlaces(row({ title: "ORBIT-1042: add the thing" }), "ORBIT-1042")).toEqual(["title"]);
    expect(refPlaces(row({ title: "[orbit-1042] x", headRefName: "orbit-1042" }), "ORBIT-1042")).toEqual(["branch", "title"]);
    expect(refPlaces(row(), "ORBIT-1042")).toEqual(["body"]);
  });
  test("said on the card", () => {
    expect(refWhy(row({ headRefName: "feat/ORBIT-1042-x" }), keys)).toBe("ORBIT-1042 in branch");
    expect(refWhy(row(), [])).toBeNull();
  });
  test("branch-only hits are added from the cards in hand, without duplicates", () => {
    const answer = [row({ number: 5, title: "ORBIT-1042 a" })];
    const inHand = [row({ number: 5, headRefName: "orbit-1042" }), row({ number: 6, headRefName: "feat/orbit-1042-b" }), row({ number: 6, headRefName: "feat/orbit-1042-b" }), row({ number: 7 })];
    expect(withBranchHits(answer, inHand, keys).map((p) => p.number)).toEqual([5, 6]);
    expect(withBranchHits(answer, inHand, [])).toBe(answer);
  });
});

describe("a colleague's board", () => {
  test("a box that is exactly one login opens it; anything more is a search", () => {
    const known = new Set(["ana-dev"]);
    expect(singleLogin("ana-dev", known)).toBe("ana-dev");
    expect(singleLogin("@ana-dev", known)).toBe("ana-dev");
    expect(singleLogin("author:ana-dev", known)).toBe("ana-dev");
    expect(singleLogin("author:ana-dev retry", known)).toBeNull();
    expect(singleLogin("orbit-1042", known)).toBeNull();
  });
  test("four lanes, the owner's, and no 'waiting on someone else'", () => {
    expect(lanesFor("ana-dev").map((l) => l.id)).toEqual(["review", "land", "blocked", "flight"]);
    expect(lanesFor("ana-dev").map((l) => l.label.toLowerCase()).join("|")).not.toContain("someone else");
    expect(LANES.some((l) => l.id === "others")).toBe(true);
  });
  test("a draft asked of them is filed under review, not in a fifth lane", () => {
    const draft = row({ number: 9, isDraft: true });
    const filed = board([draft], () => ({ mine: false, asked: true }), undefined, "ana-dev");
    expect(filed.get("others")).toEqual([]);
    expect(filed.get("review")!.map((p) => p.number)).toEqual([9]);
    expect(fileInLane(draft, { mine: false, asked: true }).lane).toBe("others");
    const plain = board([row({ number: 10, isDraft: true })], () => ({ mine: false, asked: false }));
    expect(plain.get("others")!.length).toBe(1);
  });
});

const noop = () => {};
const props = (extra: Record<string, unknown>) => ({
  mine: [row({ number: 1 })], review: [row({ number: 2, author: "bo-dev" })], onOpen: noop, onTogglePin: noop, onShowTable: noop,
  onAct: noop, busy: new Set<number>(), acting: null, loading: false, settling: false, failed: false, hidden: 0,
  onRetry: noop, pinned: () => false, root: "", repoKey: "acme/orbit", total: 2, ...extra,
}) as never;
const draw = (extra: Record<string, unknown>) => renderToStaticMarkup(React.createElement(TriageBoard, props(extra)));

describe("the yellow bar", () => {
  test("says whose board it is, with the way back, in warning colours", () => {
    const html = renderToStaticMarkup(React.createElement(PersonBanner, { login: "ana-dev", onBack: noop }));
    expect(html).toContain("data-person-banner");
    expect(html).toContain("ana-dev");
    expect(html).toContain("s board, not yours");
    expect(html).toContain("Back to my board");
    expect(html).toContain("var(--warning)");
    expect(html).toContain("var(--warning-ink)");
  });
  test("is on a person's board and nowhere else", () => {
    const person = draw({ viewer: "ana-dev", person: { onBack: noop, more: false } });
    expect(person).toContain("data-person-banner");
    expect(person.match(/Back to my board/g)).toHaveLength(1);
    const own = draw({});
    expect(own).not.toContain("data-person-banner");
    expect(own).not.toContain("Back to my board");
    expect(own).not.toContain("not yours");
  });
  test("a person's board draws four lanes and no 'waiting on someone else'", () => {
    const html = draw({ viewer: "ana-dev", person: { onBack: noop, more: false } });
    expect(html).not.toContain("Waiting on someone else");
    for (const l of lanesFor("ana-dev")) expect(html).toContain(l.label.replace("'", "&#x27;"));
  });
  test("only what is open now: no finished pull requests on a person's board", () => {
    const html = draw({ viewer: "ana-dev", person: { onBack: noop, more: false } });
    expect(html).not.toContain("data-finished");
    expect(html).not.toContain("merged and closed");
  });
});

describe("no request on typing", async () => {
  const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  const bar = await Bun.file(new URL("../src/components/PrFilterBar.tsx", import.meta.url)).text();
  test("the reference and the person paths add no fetch of their own", () => {
    const refs = Bun.file(new URL("../src/lib/prRefs.ts", import.meta.url));
    return refs.text().then((t) => {
      expect(t).not.toMatch(/fetch\(|api\.|setInterval|setTimeout/);
    });
  });
  test("onChange only edits the box; a person opens on Enter or on the @ pick", () => {
    expect(bar).toContain("(scoped ? scoped.onChange : onQuery)(e.target.value)");
    expect(bar).toContain("onPickPerson?.(login)");
  });
  test("the person board closes the search it never needed: Enter on a login sends no list search", () => {
    const run = panel.slice(panel.indexOf("const runSearch = useCallback("));
    const body = run.slice(0, run.indexOf("}, [wanted"));
    expect(body.indexOf("setPersonLogin(who); return;")).toBeGreaterThan(-1);
    expect(body.indexOf("setPersonLogin(who); return;")).toBeLessThan(body.indexOf("setServerQuery(wanted)"));
  });
});

describe("the branch read is asked once per key", async () => {
  const { askRefBranches, __forgetRefBranches } = await import("../src/lib/refBranches.ts");
  const { api } = await import("../src/lib/api.ts");
  const real = api.prRefBranches;
  test("deduped while in flight, remembered, a failure is remembered as none", async () => {
    let calls = 0;
    (api as { prRefBranches: unknown }).prRefBranches = async (_r: string, k: string) => { calls++; return k === "ORBIT-9" ? { ok: false } : { ok: true, rows: [row({ number: 4 })] }; };
    __forgetRefBranches();
    const [a, b] = await Promise.all([askRefBranches("/r", "orbit-1042"), askRefBranches("/r", "ORBIT-1042")]);
    expect(a.map((p) => p.number)).toEqual([4]); expect(b).toBe(a);
    await askRefBranches("/r", "ORBIT-1042");
    expect(calls).toBe(1);
    expect(await askRefBranches("/r", "ORBIT-9")).toEqual([]);
    await askRefBranches("/r", "ORBIT-9");
    expect(calls).toBe(2);
    (api as { prRefBranches: typeof real }).prRefBranches = real;
    __forgetRefBranches();
  });
});

describe("the owner's board: pills and leftover copy", async () => {
  const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  test("no Mine pill and no lane pills; the Open count is over the two queues only", () => {
    expect(panel).not.toContain("const VIEWS:");
    expect(panel).not.toContain('label="Mine"');
    const counts = panel.slice(panel.indexOf("const boardOpenCount = useMemo("), panel.indexOf("}, [boardMineShown, boardReviewShown]);"));
    expect(counts).toContain("boardMineShown");
    expect(counts).toContain("boardReviewShown");
    expect(counts).not.toContain("listRows");
  });
  test("the board's own stragglers fill themselves once the settle window is over, never before", () => {
    expect(panel).toContain("useRowDetails(root, boardAll, boardWaited)");
  });
  test("the old wide-board copy is gone", async () => {
    const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
    for (const gone of ["The board never shows more than that", "not a number this view can trust"]) expect(board).not.toContain(gone);
  });
});
