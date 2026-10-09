/*
 * Nothing new gets to be smaller than a thumb.
 *
 * `TAP` is 48 in src/ui.tsx and the comment over it explains what the number is
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
const TAP = 48;

/** What a literal `minHeight:` is held to: the full TAP. */
const LITERAL_FLOOR = TAP;

/** The one file still written against 44: the pull request screens, with one
 *  literal at that height (`app/pr/[number].tsx`), which belongs to another
 *  branch. It is held to 44 here until that branch follows, and nothing else is
 *  — a new control at 44 elsewhere (the diff's expander was one) fails. */
const STILL_44 = "app/pr/[number].tsx";
const floorOf = (path: string): number => (path === STILL_44 ? 44 : LITERAL_FLOOR);

/**
 * The ones that were already under it, each with the argument that put it there.
 *
 * Named as `file:line` is deliberately NOT the shape — a line number moves the
 * moment anything above it does, and a lock that fails on an unrelated edit is
 * a lock people delete. It is the file and the value, which is what actually
 * has to be argued for.
 */
const ALLOWED: { file: string; height: number; because: string }[] = [
  {
    file: "src/review/FilesPane.tsx",
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

/** Body of `export function <name>(` up to its own closing brace at column 0,
 *  never a fixed window. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `${name} is gone from src/ui.tsx`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

describe("the shared controls", () => {
  // `heights` above reads literals only, and Btn / Row / SheetRow write theirs
  // as `TAP` or as a ternary (`sub ? 56 : 48`), so that scan never saw them —
  // which is how Btn sat at 44 while the audit measured it as the floor.
  const ui = files.find((f) => f.path === "src/ui.tsx")!.source;
  const declared = Number(/export const TAP = (\d+)/.exec(ui)?.[1]);

  test("TAP itself is the floor", () => {
    expect(declared).toBeGreaterThanOrEqual(TAP);
  });

  for (const name of ["Btn", "Row", "SheetRow"]) {
    test(`${name} is never drawn under ${TAP}`, () => {
      const expressions = [...bodyOf(ui, name).matchAll(/minHeight:\s*([^,}\n]+)/g)].map((m) => m[1]!);
      expect(expressions.length, `${name} has no minHeight to check`).toBeGreaterThan(0);
      for (const expression of expressions) {
        // Every value the expression can take: a ternary's two arms both count.
        const values = [...expression.matchAll(/TAP|\d+/g)].map((m) => (m[0] === "TAP" ? declared : Number(m[0])));
        expect(values.length, `minHeight: ${expression} in ${name} is not a number or TAP`).toBeGreaterThan(0);
        expect(Math.min(...values), `${name}: minHeight: ${expression}`).toBeGreaterThanOrEqual(TAP);
      }
    });
  }
});

describe("what a press says back", () => {
  const terminal = files.find((f) => f.path === "app/(tabs)/terminal.tsx")!.source;
  const issue = files.find((f) => f.path === "app/issue/[number].tsx")!.source;
  const ui = files.find((f) => f.path === "src/ui.tsx")!.source;

  test("the comment sheet closes only when the post went through", () => {
    // `act` used to return nothing, so `.then(() => setCommenting(false))` ran
    // after a refusal too and the red line was left on the screen behind.
    expect(issue).not.toMatch(/act\("(?:comment|claim)"\)\.then\(\(\) =>/);
    expect(issue).toMatch(/act\("comment"\)\.then\(\(ok\) => \{ if \(ok\) setCommenting\(false\)/);
  });

  test("a row that cannot be used is disabled, not a silent no-op", () => {
    expect(bodyOf(ui, "SheetRow")).toMatch(/disabled/);
    expect(terminal).toMatch(/disabled=\{!a\.installed\}/);
    expect(terminal).not.toMatch(/if \(a\.installed\) openAgent/);
  });

  test("Push waits for something to push", () => {
    const repos = files.find((f) => f.path === "app/(tabs)/repos.tsx")!.source;
    // Not `repo.ahead`: a never-pushed branch reads 0 there. See model/gitReview.ts.
    expect(repos).toMatch(/disabled=\{!push\.canPush\}/);
  });

  test("the copy buttons say they copied", () => {
    expect(files.find((f) => f.path === "app/files.tsx")!.source).toMatch(/Path copied/);
    expect(bodyOf(ui, "CommandLine")).toMatch(/Copied/);
  });
});

describe("the tap floor", () => {
  test("there are heights to check at all", () => {
    // A regex that stops matching is a test that passes for the wrong reason.
    expect(heights.length).toBeGreaterThan(0);
  });

  test("nothing is under the floor without an argument for it", () => {
    const under = heights.filter((h) => h.height < floorOf(h.path));
    const unexplained = under.filter(
      (h) => !ALLOWED.some((a) => a.file === h.path && a.height === h.height),
    );
    expect(
      unexplained.map((u) => `${u.path} at ${u.height}`),
      "under the floor (TAP, or 44 in STILL_44) and not in ALLOWED. Either raise it, or add it there "
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
