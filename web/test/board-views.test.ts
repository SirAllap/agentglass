/*
 * The pill row's views are filters over the board, not queries to the server.
 *
 * "Failing" used to write `checks:red` into the search box, which sent the
 * panel to the table. Now each view is a question about cards already in hand,
 * judged after filing so a pull request keeps the lane it has everywhere else.
 */
import { describe, expect, it } from "bun:test";
import { viewKeeps, type Stake } from "../src/lib/prLanes.ts";

const yours: Stake = { mine: true, asked: false };
const asked: Stake = { mine: false, asked: true };
const both: Stake = { mine: true, asked: true };

describe("viewKeeps", () => {
  it("all keeps everything", () => {
    expect(viewKeeps("all", "flight", yours)).toBe(true);
    expect(viewKeeps("all", "others", asked)).toBe(true);
  });
  it("review reads the stake; there is no \"mine\" view, the board is already only theirs", () => {
    expect(viewKeeps("review", "land", asked)).toBe(true);
    expect(viewKeeps("review", "land", yours)).toBe(false);
    expect(viewKeeps("review", "blocked", both)).toBe(true);
    expect(viewKeeps("all", "flight", yours)).toBe(true);
  });
  it("failing is the blocked lane and ready is the land lane, whoever owns the card", () => {
    expect(viewKeeps("failing", "blocked", asked)).toBe(true);
    expect(viewKeeps("failing", "land", yours)).toBe(false);
    expect(viewKeeps("ready", "land", asked)).toBe(true);
    expect(viewKeeps("ready", "blocked", yours)).toBe(false);
  });
  it("is wired: the board applies it after filing and the panel passes the picked view", async () => {
    const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
    const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(board).toContain("viewKeeps(view, id,");
    // A person's board (a login search) has no view row, so it is handed "all";
    // the owner's own board gets the picked view.
    expect(panel).toContain('view={personLogin ? "all" : boardView}');
  });
});

describe("the wide views", () => {
  it("no view reaches past the viewer's two queues, so the default board holds only their stake", async () => {
    const { viewIsWide } = await import("../src/lib/prLanes.ts");
    expect(["all", "review", "failing", "ready"].some((v) => viewIsWide(v as never))).toBe(false);
  });
  it("opening the board asks the list for the queue scope, never the repository's", async () => {
    const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(panel).toContain('const scope = queuesOnlyRef.current ? "review" : filter;');
    expect(panel).toContain("api.prList(root, scope, stateSel, force, cursor, serverQuery)");
  });
  it("failing also keeps a red or conflicting pull request that is nobody's stake", () => {
    const none: Stake = { mine: false, asked: false };
    expect(viewKeeps("failing", "others", none, { checks: { failure: 1 } })).toBe(true);
    expect(viewKeeps("failing", "others", none, { checks: { failure: 0 }, mergeable: "CONFLICTING" })).toBe(true);
    expect(viewKeeps("failing", "others", none, { checks: { failure: 0 } })).toBe(false);
  });
});
