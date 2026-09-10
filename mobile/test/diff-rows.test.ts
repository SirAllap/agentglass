/*
 * The diff as a flat list of rows, which is what lets it be windowed.
 *
 * Two things can go wrong here and both are invisible in a screenshot: a row
 * missing (a hunk header, the expander for the tail of the file) and a key
 * repeated. The second is the nastier one — a virtualised list with two rows
 * under one key draws one of them twice, so a comment box opened on line 40
 * appears on line 12 as well.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowsOf } from "../src/model/diffRows.ts";
import { parseDiff } from "../src/model/diffLines.ts";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@ function one() {",
  " keep",
  "-was",
  "+is",
  "+added",
  "@@ -80,2 +81,2 @@ function two() {",
  " context",
  "-gone",
  "+here",
].join("\n");

const file = parseDiff(DIFF)[0]!;
const rows = rowsOf(file);

describe("the order things are read in", () => {
  test("a gap, its hunk, then that hunk's lines", () => {
    expect(rows.slice(0, 3).map((r) => r.t)).toEqual(["gap", "hunk", "line"]);
  });

  test("every line of every hunk is a row, and nothing else is", () => {
    const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(rows.filter((r) => r.t === "line")).toHaveLength(lines);
    expect(rows.filter((r) => r.t === "hunk")).toHaveLength(2);
  });

  test("the gap between two hunks is between them", () => {
    const at = rows.findIndex((r) => r.t === "gap" && r.before === 1);
    const second = rows.findIndex((r) => r.t === "hunk" && r.at === 1);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(second);
  });

  test("the tail of the file gets the gap that belongs to no hunk", () => {
    // Numbered `hunks.length` for exactly this reason — the code after the
    // last hunk is still code somebody may want to see.
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({ t: "gap", before: 2 });
  });

  test("a line row carries where it is, not what it says", () => {
    const row = rows.find((r) => r.t === "line")!;
    expect(row).toMatchObject({ t: "line", h: 0, i: 0 });
  });
});

describe("keys", () => {
  test("no two rows share one", () => {
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("two identical lines are still two rows", () => {
    // A key made of the text would make them one, and a windowed list would
    // then draw the same row twice.
    const twice = parseDiff([
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      "-same",
      "-same",
      "+same",
      "+same",
    ].join("\n"))[0]!;
    const keys = rowsOf(twice).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("files with nothing to draw", () => {
  test("a binary file has no rows — the screen says why instead", () => {
    expect(rowsOf({ hunks: [], binary: true })).toEqual([]);
  });

  test("a file with no hunks has no rows, and no tail gap either", () => {
    // A rename with no content change. There is no code to expand into.
    expect(rowsOf({ hunks: [], binary: false })).toEqual([]);
  });

  test("no file at all is no rows rather than a crash", () => {
    expect(rowsOf(undefined)).toEqual([]);
  });
});

describe("a hunk that starts at line 1", () => {
  test("has no gap above it, so no row draws an empty expander", () => {
    const top = parseDiff([
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
    ].join("\n"))[0]!;
    const first = rowsOf(top)[0]!;
    expect(first.t).toBe("hunk");
  });
});

/*
 * Two things about the screen that no assertion about data can reach, and both
 * of which put back the defect this file exists for.
 *
 * Source, not render: there is no renderer in this project, and both of these
 * are facts about how the screen is written. Same technique, and the same
 * reason, as mirror.test.ts and tap-floor.test.ts.
 */
describe("the pane actually windows it", () => {
  const screen = readFileSync(join(import.meta.dir, "..", "src", "review", "FilesPane.tsx"), "utf8");

  test("the diff is a list, not a column of everything", () => {
    expect(screen).toContain("<FlatList");
    expect(screen).toContain("data={rows}");
    expect(screen).toContain("keyExtractor={(row) => row.key}");
    // The whole point: a ScrollView here mounts every row before the first is
    // on screen, which is what this replaced.
    expect(screen).not.toContain("<ScrollView contentContainerStyle={{ paddingBottom: SPACE.xl }}>");
  });

  test("a row is CALLED, never declared as a component in the render", () => {
    /*
     * A component declared inside a render is a new type on every repaint, and
     * React unmounts a subtree whose type changed. The row holds the comment
     * box, so that costs the keyboard its focus on the keystroke that opened
     * it — every time, and invisibly to every test that reads data.
     */
    expect(screen).toContain("lineRow(item.h, item.i, item.line)");
    expect(screen).not.toMatch(/const [A-Z]\w+ = \(\{[^}]*\}: \{[^}]*\}\): React\.ReactNode =>/);
  });

  test("taps still land while the keyboard is up", () => {
    // The comment box is inside a row; without this a tap is spent dismissing
    // the keyboard instead of reaching the control under the thumb.
    expect(screen).toContain('keyboardShouldPersistTaps="handled"');
  });
});
