/*
 * When an idle board asks again, and when it does not wait.
 *
 * A focused list board asked every two minutes against a 60 s server clock:
 * 60 reads an hour for a view nobody was touching. The floor is five minutes
 * now; coming back to the window still refreshes rows a minute old, and the
 * source is pinned so the screen keeps using the rule.
 */
import { describe, expect, test } from "bun:test";
import { BOARD_POLL_MS, BOARD_TICK_MS, boardDue } from "../src/lib/boardPoll.ts";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const T0 = 1_800_000_000_000;

describe("boardDue", () => {
  test("a tick leaves rows younger than five minutes alone", () => {
    expect(boardDue(T0 + 4 * 60_000, T0, "tick")).toBe(false);
  });
  test("a tick asks once the rows are five minutes old", () => {
    expect(boardDue(T0 + BOARD_POLL_MS, T0, "tick")).toBe(true);
  });
  test("coming back to the window asks at one minute", () => {
    expect(boardDue(T0 + 30_000, T0, "focus")).toBe(false);
    expect(boardDue(T0 + 61_000, T0, "focus")).toBe(true);
  });
  test("a board with no rows yet asks at once", () => {
    expect(boardDue(T0, undefined, "tick")).toBe(true);
  });
  test("idle cost: at most 12 asks an hour", () => {
    let at = T0, asks = 0;
    for (let now = T0; now < T0 + 3_600_000; now += BOARD_TICK_MS) {
      if (boardDue(now, at, "tick")) { asks++; at = now; }
    }
    expect(asks).toBeLessThanOrEqual(12);
  });
});

describe("the screen", () => {
  test("the focus listener uses the focus cause and the timer the tick one", () => {
    expect(panel).toContain('addEventListener("focus", onFocus)');
    expect(panel).toContain('const onFocus = () => ask("focus")');
    expect(panel).toContain("setInterval(tick, BOARD_TICK_MS)");
  });
  test("an edit still forces a read behind it", () => {
    expect(panel).toMatch(/setTimeout\(\(\) => \{ void load\(data\?\.view\?\.id, true\); \}, 1200\)/);
  });
});
