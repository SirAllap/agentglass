/*
 * Select and copy, from a pane whose lines arrive as a list.
 *
 * The mock's promise is one sentence — the copied text is the lines that were
 * selected — and the two ways it can be wrong are both here: copying rows in
 * the order they were tapped rather than the order they are read, and a bar
 * whose count is not the number of lines that went to the clipboard.
 *
 * The rows below are the shape a PTY hands up: padded to the pane's width,
 * because a terminal pads every row whether anybody typed there or not.
 */
import { describe, expect, test } from "bun:test";
import { copied, copyLine, countLine, toggle } from "../src/terminal/select.ts";

const ROWS = [
  "$ bun test web/src/settings",
  "✓ rail.test.ts 14 passed",
  "",
  "  error: cannot find module 'rail'        ",
  "    at src/settings/rail.tsx:38           ",
  "$ █                                     ",
];

describe("picking lines", () => {
  test("a tap picks one and a second tap puts it back", () => {
    const once = toggle([], 3);
    expect(once).toEqual([3]);
    expect(toggle(once, 3)).toEqual([]);
  });

  test("the picks stay in read order, whatever order the taps came in", () => {
    // Tapped bottom-up, as somebody reading a stack trace does.
    const picked = toggle(toggle(toggle([], 4), 1), 3);
    expect(picked).toEqual([1, 3, 4]);
  });

  test("a line outside the buffer, or half a line, is not picked", () => {
    // The page reports an index from a finger; a drag that ended past the last
    // row must not add a row that does not exist.
    expect(toggle([2], -1)).toEqual([2]);
    expect(toggle([2], 1.5)).toEqual([2]);
  });

  test("the bar counts what is picked, in words", () => {
    expect(countLine([])).toBe("No lines selected");
    expect(countLine([3])).toBe("1 line selected");
    expect(countLine([1, 3])).toBe("2 lines selected");
  });
});

describe("what Copy writes", () => {
  test("the selected lines, in read order, as plain text", () => {
    expect(copied(ROWS, [1, 3])).toBe(
      "✓ rail.test.ts 14 passed\n  error: cannot find module 'rail'",
    );
  });

  test("the trailing padding goes, the indentation stays", () => {
    // A row is padded to the pane's width; pasted, sixty spaces of padding reads
    // as a broken clipboard. The two leading spaces are the stack frame's.
    const text = copied(ROWS, [4]);
    expect(text.endsWith(" ")).toBe(false);
    expect(text.startsWith("    at")).toBe(true);
  });

  test("a blank line between two picked ones is part of the block", () => {
    // It was picked on purpose: a snippet without its blank line pastes as one
    // paragraph, which is exactly not what was on screen.
    expect(copied(ROWS, [1, 2, 3])).toBe(
      "✓ rail.test.ts 14 passed\n\n  error: cannot find module 'rail'",
    );
  });

  test("the count on the bar is the number of lines in the text", () => {
    const picked = [1, 3, 4];
    const text = copied(ROWS, picked);
    expect(text.split("\n").length).toBe(picked.length);
    expect(countLine(picked)).toStartWith(String(picked.length));
  });

  test("nothing picked copies nothing, and says that", () => {
    expect(copied(ROWS, [])).toBe("");
    expect(copyLine([])).toBe("Nothing to copy");
  });

  test("a pick past the end of the buffer is dropped, not copied as undefined", () => {
    // The scrollback was read when select mode started; a pane that scrolled
    // past its limit since then has fewer rows than the tap assumed.
    expect(copied(ROWS, [90])).toBe("");
    expect(copied(ROWS, [1, 90])).toBe("✓ rail.test.ts 14 passed");
  });

  test("the confirmation counts the same lines", () => {
    expect(copyLine([3])).toBe("1 line copied");
    expect(copyLine([1, 3])).toBe("2 lines copied");
  });
});
