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
  it("review and mine read the stake, so a card that is both shows in both", () => {
    expect(viewKeeps("review", "land", asked)).toBe(true);
    expect(viewKeeps("review", "land", yours)).toBe(false);
    expect(viewKeeps("mine", "flight", yours)).toBe(true);
    expect(viewKeeps("mine", "flight", asked)).toBe(false);
    expect(viewKeeps("review", "blocked", both)).toBe(true);
    expect(viewKeeps("mine", "blocked", both)).toBe(true);
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
    expect(panel).toContain("view={boardView}");
  });
});
