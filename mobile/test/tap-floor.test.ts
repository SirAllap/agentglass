/*
 * Nothing new gets to be smaller than a thumb.
 *
 * `TAP` is 44 in src/ui.tsx and the comment over it explains what the number is
 * for: "the cost of a mis-tap here is an agent stopped or a command allowed
 * that should not have been". It was a floor the shared components held and
 * the screens did not.
 *
 * Measured across the app before this file existed, the SAME gesture — switch
 * between a few views of one list — was drawn at three heights:
 *
 *   34  Review's segmented control, with a comment apologising for it
 *   36  the pull request filters, and the chat list's scopes
 *   44  the repository strip on three screens
 *
 * A thumb moving between screens met three weights of one control. They are one
 * component now (`Segmented`), at the floor, and this is what stops the fourth
 * from being written.
 *
 * ── why a source scan and not a render ───────────────────────────────────
 * The same reason keyboard-inset.test.ts scans source: there is no navigator
 * here to mount a screen in, and the property this protects is a number written
 * in a style object. A screenshot proves it for the screens that exist today;
 * this proves it for the next one somebody writes.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The floor, restated rather than imported: importing src/ui.tsx here would
 *  pull react-native into a test that only wants to read text — the same
 *  reason theme.ts requires its native modules lazily. If TAP moves, this
 *  number is meant to be looked at rather than to follow silently. */
const TAP = 44;

/**
 * The two that were already under it, each with the argument that put it there.
 *
 * Named as `file:line` is deliberately NOT the shape — a line number moves the
 * moment anything above it does, and a lock that fails on an unrelated edit is
 * a lock people delete. It is the file and the value, which is what actually
 * has to be argued for.
 */
const ALLOWED: { file: string; height: number; because: string }[] = [
  {
    file: "app/(tabs)/terminal.tsx",
    height: 40,
    because:
      "the accessory key bar. Sixteen keys have to reach the fold on a 360dp "
      + "phone, and the measured trade is written over it: below 40 the seventh "
      + "key goes behind a swipe, which is where Ctrl+C would end up.",
  },
  {
    file: "app/(tabs)/terminal.tsx",
    height: 32,
    because:
      "the tmux session strip, which appears only on a machine running more "
      + "than one session and sits above the window tabs — a second row of "
      + "chrome over a screen whose whole point is the pane below it.",
  },
  {
    file: "app/pr/diff.tsx",
    height: 22,
    because:
      "a line of the diff. This is the one exception with a real argument "
      + "rather than a saving: a line of code is a line of code, and at 44 a "
      + "twenty-line hunk is 880 points — longer than the screen — so a diff "
      + "nobody can read would be the price of a target nobody misses. "
      + "It is 393 wide, so the miss is always onto the line above or below, "
      + "and the cost of that miss is bounded by design: the box that opens "
      + "names the line it is for, so a wrong one is visible before a word is "
      + "typed and Cancel is beside it.",
  },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "web-shims") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry) && !/\.generated\./.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Code only. Every number this file is about is also discussed in prose
 *  somewhere — including in the comments right above the two exceptions — and
 *  a scan that read those would fail on the explanations for the things it
 *  allows. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const root = join(import.meta.dir, "..");
const files = [...sources(join(root, "app")), ...sources(join(root, "src"))]
  .map((path) => ({ path: path.slice(root.length + 1), source: code(readFileSync(path, "utf8")) }));

/** Every `minHeight: <n>` written as a literal, with the file it is in. A
 *  height computed from `TAP` is not a literal and does not appear here, which
 *  is the point: the components that take the floor from one place are exactly
 *  the ones this does not need to check. */
const heights = files.flatMap(({ path, source }) =>
  [...source.matchAll(/minHeight:\s*(\d+)/g)].map((m) => ({ path, height: Number(m[1]) })));

describe("the tap floor", () => {
  test("there are heights to check at all", () => {
    // A regex that stops matching is a test that passes for the wrong reason.
    expect(heights.length).toBeGreaterThan(0);
  });

  test("nothing is under 44 without an argument for it", () => {
    const under = heights.filter((h) => h.height < TAP);
    const unexplained = under.filter(
      (h) => !ALLOWED.some((a) => a.file === h.path && a.height === h.height),
    );
    expect(
      unexplained.map((u) => `${u.path} at ${u.height}`),
      "under the 44 floor and not in ALLOWED. Either raise it, or add it there "
      + "with the reason — a smaller target is a decision, not an oversight.",
    ).toEqual([]);
  });

  test("every exception still exists, and says why", () => {
    // The other direction. An allowance kept after the code it excused has
    // gone is how the next under-height control gets in unnoticed.
    for (const allowed of ALLOWED) {
      expect(
        heights.some((h) => h.path === allowed.file && h.height === allowed.height),
        `${allowed.file} no longer has a ${allowed.height} — drop it from ALLOWED`,
      ).toBe(true);
      expect(allowed.because.length, `${allowed.file} has no reason written`).toBeGreaterThan(40);
    }
  });

  test("the control that replaced three of them takes the floor from TAP", () => {
    // `Segmented` is the one this file was written around. It must read the
    // constant rather than repeat the number, or the two drift the day TAP
    // moves and this test goes on passing.
    const ui = files.find((f) => f.path === "src/ui.tsx");
    expect(ui, "src/ui.tsx is gone").toBeTruthy();
    expect(ui!.source).toMatch(/minHeight:\s*TAP/);
  });
});
