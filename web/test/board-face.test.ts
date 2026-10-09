/*
 * The Board's empty state is an answer, and an answer is only given when both
 * lists are in.
 *
 * Measured on a merge: every write drops the server's cached lists, so the first
 * read after it is `{ prs: [], loading: true, fetchedAt: 0 }` while the real
 * read runs behind it. The board took that for an answer, replaced the rows on
 * screen with nothing and said "this is an answer, not a wait" for the seconds
 * the read took — under a masthead still reading "Loading pull requests…".
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageBoard } from "../src/components/TriageBoard.tsx";
import { boardFace, listOutcome } from "../src/lib/boardFace.ts";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const none = { reading: false, settling: false, involved: 0, failed: false, hidden: 0 };

describe("listOutcome: a response is an answer only when it is one", () => {
  it("rows are an answer, even while the server refreshes behind them", () => {
    expect(listOutcome({ prs: [{}], loading: true })).toBe("answered");
  });
  it("the cache dropped by a merge is NOT an answer", () => {
    expect(listOutcome({ prs: [], loading: true })).toBe("reading");
  });
  it("a finished read with no rows is the real empty answer", () => {
    expect(listOutcome({ prs: [], loading: false })).toBe("answered");
  });
  it("a read that came back with an error and no rows is a failure, not an empty list", () => {
    expect(listOutcome({ prs: [], loading: false, error: "the pull requests could not be read" })).toBe("failed");
  });
  it("a call that threw is a failure", () => {
    expect(listOutcome(null)).toBe("failed");
  });
});

describe("boardFace: what an empty board may say", () => {
  it("first load, nothing cached: waiting", () => {
    expect(boardFace({ ...none, reading: true })).toBe("waiting");
  });
  it("reload after a merge with the old rows on screen: rows, not a skeleton", () => {
    expect(boardFace({ ...none, reading: true, involved: 24 })).toBe("rows");
  });
  it("reload after a merge with nothing on screen: waiting, never empty", () => {
    expect(boardFace({ ...none, reading: true })).not.toBe("empty");
  });
  it("a failed read with nothing to show says failed, not empty", () => {
    expect(boardFace({ ...none, failed: true })).toBe("failed");
  });
  it("a failed refresh keeps the rows it has", () => {
    expect(boardFace({ ...none, failed: true, involved: 3 })).toBe("rows");
  });
  it("filters that hid everything are the filters, not the repository", () => {
    expect(boardFace({ ...none, hidden: 5 })).toBe("filtered");
  });
  it("both lists in and nothing hidden is the one real empty", () => {
    expect(boardFace(none)).toBe("empty");
  });
  it("rows whose checks are still out keep the skeleton", () => {
    expect(boardFace({ ...none, settling: true, involved: 4 })).toBe("waiting");
  });
});

const render = (props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(TriageBoard, {
    mine: [], review: [], total: -1, hasTaskProvider: false,
    pinned: () => false, onOpen: () => {}, onTogglePin: () => {},
    onShowTable: () => {}, onAct: () => {},
    onlyUnread: false, onOnlyUnread: () => {},
    ...props,
  } as never));

describe("the three empty-looking screens", () => {
  it("loading: a skeleton and no claim", () => {
    const html = render({ loading: true });
    expect(html).toContain("Reading the two lists");
    expect(html).not.toContain("Nothing wants anything");
  });
  it("failed: says it failed, offers a retry, claims no zeros", () => {
    const html = render({ failed: true, onRetry: () => {} });
    expect(html).toContain("could not be read");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Nothing wants anything");
    expect(html).not.toContain("this is an answer");
    expect(html).not.toContain("data-seg=");
  });
  it("filtered: names the filters and the number they hid", () => {
    const html = render({ hidden: 7 });
    expect(html).toContain("Your filters hide");
    expect(html).toContain("7 came in");
    expect(html).not.toContain("this is an answer");
  });
  it("empty: the answer, only when the load finished and nothing is hidden", () => {
    const html = render({});
    expect(html).toContain("Nothing wants anything from you.");
    expect(html).toContain("this is an answer, not a wait");
  });
});

describe("the panel's board fetch", () => {
  const start = panel.indexOf('api.prList(root, "mine", stateSel, force)');
  const end = panel.indexOf("}, [root, stateSel, listState.fetchedAt, boardTick]);", start);
  const fetch = panel.slice(start, end);
  it("found its own effect", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });
  it("replaces the rows only on an answer", () => {
    expect(fetch.match(/if \(live && o === "answered"\) \{/g)?.length).toBe(2);
    expect(fetch.indexOf('o === "answered"')).toBeLessThan(fetch.indexOf("setBoardMine("));
    expect(fetch.indexOf('o === "answered"', fetch.indexOf("setBoardMine("))).toBeLessThan(fetch.indexOf("setBoardReview("));
  });
  it("asks again while a list is still being read, and stays loading", () => {
    expect(fetch).toContain('outcomes.includes("reading")');
    expect(fetch).toContain("setBoardTick((n) => n + 1)");
    expect(fetch).toContain("clearTimeout(again)");
    // setBoardLoading(false) only on the branch that is not reading.
    expect(fetch.slice(fetch.indexOf("} else {"))).toContain("setBoardLoading(false)");
  });
  it("a call that threw is a failure, not an empty answer", () => {
    expect(fetch).toContain('x.status === "fulfilled" ? x.value : listOutcome(null)');
  });
});

describe("the table's list fetch", () => {
  const start = panel.indexOf("const loadList = useCallback(");
  const end = panel.indexOf("loadListRef.current = loadList;", start);
  const load = panel.slice(start, end);
  it("found its own callback", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });
  it("keeps the rows, the pager and the cursor while the server is still reading", () => {
    expect(load).toContain('const reading = listOutcome(r) === "reading";');
    expect(load).toContain("if (!reading) setPrs(");
    expect(load).toContain("if (!reading && pageRanOut(");
    expect(load).toContain("if (!reading) setRowCursor(");
  });
  it("still records the loading state, so the settle timer asks again", () => {
    expect(load).toContain("fetchedAt: reading ? st.fetchedAt : r.fetchedAt, loading: r.loading");
    expect(load).toContain("settleAfter(r, settleDelay.current)");
  });
});
