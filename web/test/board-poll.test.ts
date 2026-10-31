/*
 * When an idle board asks again, and when it does not wait.
 *
 * A focused list board asked every two minutes against a 60 s server clock:
 * 60 reads an hour for a view nobody was touching. The floor is five minutes
 * now; coming back to the window still refreshes rows a minute old, and the
 * source is pinned so the screen keeps using the rule.
 */
import { describe, expect, test } from "bun:test";
import { BOARD_FOCUS_MS, boardDue } from "../src/lib/boardPoll.ts";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const T0 = 1_800_000_000_000;

describe("boardDue", () => {
  test("coming back to the window leaves rows younger than a minute alone", () => {
    expect(boardDue(T0 + 30_000, T0)).toBe(false);
  });
  test("coming back to the window asks once the rows are a minute old", () => {
    expect(boardDue(T0 + BOARD_FOCUS_MS, T0)).toBe(true);
  });
  test("a board with no rows yet asks at once", () => {
    expect(boardDue(T0, undefined)).toBe(true);
  });
});

describe("the screen", () => {
  test("the only event that asks is the window's focus; no timer is set", () => {
    expect(panel).toContain('addEventListener("focus", onFocus)');
    expect(panel).toContain("boardDue(Date.now(), data?.at)");
    expect(panel).not.toContain("setInterval(tick");
  });
  test("an edit still forces a read behind it", () => {
    expect(panel).toMatch(/setTimeout\(\(\) => \{ void load\(data\?\.view\?\.id, true\); \}, 1200\)/);
  });
});
