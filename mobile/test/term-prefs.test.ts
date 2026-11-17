/*
 * The terminal's text size, and the columns it comes out as.
 *
 * The ⋯ sheet has a −/+ stepper that says "12.5 pt · 53 characters across", so
 * both halves of that sentence are behaviour: the size stays inside the five
 * steps the mock draws, and the column count follows the width of the screen
 * the phone actually has. An offline phone at 360 and one at 412 must not be
 * told the same number, and 17pt must never quietly become 19.
 *
 * Pure, and importing termPrefs is safe here: the keystore is required lazily
 * and its absence is the tested path — see the module's own comment.
 */
import { describe, expect, test } from "bun:test";
import {
  CELL_RATIO, DEFAULT_COLUMNS, MIN_COLUMNS, TEXT_STEPS,
  columnsForText, setTermColumns, stepColumns, termColumns, textLabel, textSizeFor,
} from "../src/terminal/termPrefs.ts";

/** The two widths the plan verifies on. */
const NARROW = 360;
const WIDE = 412;

describe("the steps", () => {
  test("are the mock's five, in order, inside 11.5 and 17", () => {
    expect([...TEXT_STEPS]).toEqual([11.5, 12.5, 14, 15.5, 17]);
    expect(Math.min(...TEXT_STEPS)).toBe(11.5);
    expect(Math.max(...TEXT_STEPS)).toBe(17);
    for (let i = 1; i < TEXT_STEPS.length; i++) {
      expect(TEXT_STEPS[i]!).toBeGreaterThan(TEXT_STEPS[i - 1]!);
    }
  });

  test("stepping up from the largest does not leave the band", () => {
    // 17pt on a 412px phone is 39 columns; there is no bigger step.
    const at = columnsForText(WIDE, 17);
    expect(stepColumns(at, WIDE, 1)).toBe(at);
    expect(textSizeFor(at, WIDE)).toBeLessThanOrEqual(17);
  });

  test("and stepping down from the smallest does not either", () => {
    const at = columnsForText(WIDE, 11.5);
    expect(stepColumns(at, WIDE, -1)).toBe(at);
    expect(textSizeFor(at, WIDE)).toBeGreaterThanOrEqual(11.5);
  });

  test("each step lands on a size that reads back as that step", () => {
    // A column count is whole, so the size the pane gets is the step to within
    // the rounding of one column — and the label reports the real one.
    for (const size of TEXT_STEPS) {
      const cols = columnsForText(WIDE, size);
      expect(textSizeFor(cols, WIDE)).toBeGreaterThan(size - 0.3);
      expect(textSizeFor(cols, WIDE)).toBeLessThan(size + 0.3);
    }
  });

  test("a step is one step, not several", () => {
    // 11.5 → 12.5 → 14 → 15.5 → 17, and then it stays: six presses from the
    // bottom, the last of which changes nothing twice.
    let cols = columnsForText(WIDE, 11.5);
    const seen = [cols];
    for (let i = 0; i < 6; i++) {
      cols = stepColumns(cols, WIDE, 1);
      seen.push(cols);
    }
    expect(seen).toEqual([57, 53, 47, 43, 42, 39, 39]);
  });
});

describe("the columns", () => {
  test("follow the width: a wider phone holds more of them", () => {
    expect(columnsForText(WIDE, 12.5)).toBeGreaterThan(columnsForText(NARROW, 12.5));
  });

  test("and the size: bigger text is fewer columns", () => {
    expect(columnsForText(WIDE, 17)).toBeLessThan(columnsForText(WIDE, 11.5));
  });

  test("counted inside the page's own gutter, not off the glass", () => {
    // `#screen { inset: 0 8px }` — 16px of the width is not grid.
    const cols = columnsForText(WIDE, 12.5);
    expect(cols).toBe(Math.round((WIDE - 16) / (12.5 * CELL_RATIO)));
  });

  test("never fewer than a pane can be read at", () => {
    // A 200px-wide split or a watch-sized window: the floor still asks for
    // something the page can draw.
    expect(columnsForText(120, 17)).toBe(MIN_COLUMNS);
  });

  test("the label says both numbers, and the size it really got", () => {
    expect(textLabel(53, WIDE)).toBe("12.5 pt · 53 characters across");
    // The default is the drawing's own size at its own 390-wide frame (12.5 pt);
    // on the 412 test phone that same column count reads 13.2. 80 columns was
    // 8.3 pt, and 8.3 pt clipped glyphs inside their cells on the emulator.
    expect(textLabel(DEFAULT_COLUMNS, WIDE)).toBe("13.2 pt · 50 characters across");
  });
});

describe("the two-rung width control is unchanged", () => {
  test("still offers 50 and 80, and refuses anything else", () => {
    setTermColumns(80);
    expect(termColumns()).toBe(80);
    setTermColumns(57); // a text-size count is not a width choice
    expect(termColumns()).toBe(DEFAULT_COLUMNS);
    setTermColumns(DEFAULT_COLUMNS);
  });
});
