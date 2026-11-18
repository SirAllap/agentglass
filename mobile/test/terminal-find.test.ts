/*
 * Searching a pane's scrollback from the phone.
 *
 * s66 asks a specific set of things and they are all here, because they are all
 * decisions: what a query matches, how the count reads, and that stepping past
 * the last hit comes back to the first rather than stopping. The empty query is
 * the one that clears the marks off the pane, so it matching NOTHING — rather
 * than every line — is a behaviour and not a vacuous case.
 *
 * A hand-built pane, the shape of the mock's: a build, an agent and a prompt.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countLine, find, next, prev } from "../src/terminal/find.ts";

const PANE = [
  "$ claude \"dark mode for the settings rail\"",
  "● Read src/settings/rail.tsx 412 lines",
  "● Read web/src/index.css 88 lines",
  "● Edit src/settings/rail.tsx +38 −12",
  "● Run bun test web/src/settings",
  "✓ rail.test.ts 14 passed",
  "",
  "● Waiting for you: 1 command",
  "$ rm -rf .next && bun run build",
  "  error: cannot find module 'rail'",
  "11 lines above",
];

describe("what a query finds", () => {
  test("the count matches, and the lines are in read order", () => {
    const hits = find(PANE, "rail");
    expect(hits.map((h) => h.line)).toEqual([0, 1, 3, 5, 9]);
    expect(countLine(PANE.length, hits.length)).toBe("11 lines · 5 matches");
  });

  test("case is not part of the query", () => {
    expect(find(PANE, "RAIL").length).toBe(find(PANE, "rail").length);
  });

  test("a query with spaces around it is the query", () => {
    // Type-ahead puts a space after a word the moment somebody starts the next
    // one, and a search that found nothing there would read as broken.
    expect(find(PANE, "  rail.tsx ").length).toBe(2);
  });

  test("one hit per line, because a line is the place you land", () => {
    // Both copies of "rail" are on line 0; jumping twice to the same row is a
    // second stop that shows nothing new.
    expect(find(["rail and rail again"], "rail").length).toBe(1);
  });

  test("an empty query restores the buffer: it matches nothing", () => {
    expect(find(PANE, "")).toEqual([]);
    expect(find(PANE, "   ")).toEqual([]);
    expect(countLine(PANE.length, 0)).toBe("11 lines · no matches");
  });

  test("and a query nothing has says so, without a hit list", () => {
    expect(find(PANE, "zsh: no such file")).toEqual([]);
  });

  test("the singular is a word, not a number and an s", () => {
    expect(countLine(1, 1)).toBe("1 line · 1 match");
    expect(countLine(11, 1)).toBe("11 lines · 1 match");
  });
});

describe("stepping through the hits", () => {
  test("next walks forward and wraps past the last", () => {
    expect(next(0, 3)).toBe(1);
    expect(next(1, 3)).toBe(2);
    expect(next(2, 3)).toBe(0);
  });

  test("previous walks back and wraps past the first", () => {
    expect(prev(2, 3)).toBe(1);
    expect(prev(0, 3)).toBe(2);
  });

  test("with nothing found, there is nowhere to step", () => {
    expect(next(0, 0)).toBe(0);
    expect(prev(0, 0)).toBe(0);
    expect(next(-1, 0)).toBe(0);
  });

  test("an index from a longer query does not point past the end", () => {
    // The list shrinks as somebody keeps typing: `rail` had five hits, `rail.`
    // has two, and the one that was current must still name a row.
    expect(next(4, 2)).toBe(0);
  });
});

describe("the sheet that draws them", () => {
  const sheet = readFileSync(join(import.meta.dir, "..", "src", "terminal", "Find.tsx"), "utf8");

  test("stands on a hit, not always on the first one", () => {
    // `current` was `hits[0]?.line`, which is why the model's stepping had no
    // screen: there was nothing on the sheet that could move it.
    expect(sheet).toContain("const standing = hits.length ? Math.min(at, hits.length - 1) : -1");
    expect(sheet).toContain("const current = standing >= 0 ? hits[standing]!.line : -1");
  });

  test("counts the matches beside the field, oldest first, and nothing the mock did not draw", () => {
    // The mock's s66: the field, one line of counts, the hits, the note, Done.
    // The two stepping buttons were the app's own; tapping a hit is the way to
    // a line, and a row of buttons over the list is not in the drawing.
    expect(sheet).toContain("countLine(shown, hits.length)");
    expect(sheet).toContain("oldest first");
    expect(sheet).not.toContain("Previous match");
    expect(sheet).not.toContain("Next match");
  });
});
