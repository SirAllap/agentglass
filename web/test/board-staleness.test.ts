/*
 * When a failed read is worth interrupting somebody about.
 *
 * Written against a report, and the report was about the app crying wolf: an amber
 * strip across the board on any failed poll, saying "ClickUp did not answer in time
 * — showing what was last read". "I don't even know what it means… since everything
 * seems fine… it causes worry or confusion."
 *
 * It was true about the request and wrong about the situation, which is the failure
 * mode this file exists to prevent: the rows were minutes old and correct and the
 * next poll was seconds away. One slow request is noise; a board that has stopped
 * being read is news.
 */
import { describe, expect, it } from "bun:test";
import { STALE_FLOOR_MS, STALE_POLLS, readState, staleAfterMs } from "../src/lib/boardStaleness.ts";

const FAST = 60_000;
const SLOW = 5 * 60_000;
const NOW = 1_700_000_000_000;

describe("readState", () => {
  it("says nothing when nothing failed", () => {
    expect(readState({ at: NOW, rows: 16, pollMs: FAST, now: NOW })).toBe("fine");
  });

  // The case that was crying wolf.
  it("is a word, not a warning, when the rows are recent", () => {
    expect(readState({ error: "ClickUp did not answer in time", at: NOW - 60_000, rows: 16, pollMs: FAST, now: NOW }))
      .toBe("retrying");
  });

  it("becomes news once nothing has been read for four polls", () => {
    const at = NOW - staleAfterMs(SLOW) - 1;
    expect(readState({ error: "ClickUp did not answer in time", at, rows: 16, pollMs: SLOW, now: NOW })).toBe("stale");
  });

  // No last answer to fall back on: the failure IS the state of the panel.
  it("is news immediately when there is nothing on screen", () => {
    expect(readState({ error: "Could not reach ClickUp", at: NOW, rows: 0, pollMs: FAST, now: NOW })).toBe("stale");
  });

  it("and when we cannot say how old the answer is", () => {
    expect(readState({ error: "Could not reach ClickUp", rows: 12, pollMs: FAST, now: NOW })).toBe("stale");
    expect(readState({ error: "Could not reach ClickUp", at: 0, rows: 12, pollMs: FAST, now: NOW })).toBe("stale");
  });
});

describe("how long is too long", () => {
  it("is four polls, with a floor of ten minutes", () => {
    expect(STALE_POLLS).toBe(4);
    expect(STALE_FLOOR_MS).toBe(600_000);
    // A fast board's four polls are inside the floor, so the floor decides.
    expect(staleAfterMs(FAST)).toBe(STALE_FLOOR_MS);
  });

  // The slow built-in board is polled every five minutes on purpose. Judging it by
  // the same ten minutes as a fast one would call it stale after two polls.
  it("scales with the board's own poll rather than a constant", () => {
    expect(staleAfterMs(SLOW)).toBe(4 * SLOW);
    expect(staleAfterMs(SLOW)).toBeGreaterThan(staleAfterMs(FAST));
  });

  it("survives a nonsense poll interval rather than going negative", () => {
    expect(staleAfterMs(0)).toBe(STALE_FLOOR_MS);
    expect(staleAfterMs(-1)).toBe(STALE_FLOOR_MS);
  });
});
