/*
 * The diff parser, and the numbering it exists to get right.
 *
 * A unified diff states each hunk's starting line once and expects the reader
 * to count from there. Every test below is a way that count goes wrong, and
 * the cost of each is the same: a review comment posted against a line the
 * author did not write.
 */
import { describe, expect, test } from "bun:test";
import { commentableLine, fileLabel, parseDiff } from "../src/model/diffLines.ts";

/** Written as an array and joined, so the leading spaces of context lines are
 *  visible in the source rather than being something a formatter can eat. */
const diff = (...lines: string[]): string => lines.join("\n");

const SIMPLE = diff(
  "diff --git a/src/search/indexer.ts b/src/search/indexer.ts",
  "index 1111111..2222222 100644",
  "--- a/src/search/indexer.ts",
  "+++ b/src/search/indexer.ts",
  "@@ -142,4 +142,5 @@ function buildIndex() {",
  "   const row = {",
  "     id: call.id,",
  "-  };",
  "+    number: call.rawNumber,",
  "+  };",
  " ",
);

describe("files", () => {
  test("it finds one, with its path from the +++ side", () => {
    const [file] = parseDiff(SIMPLE);
    expect(file?.path).toBe("src/search/indexer.ts");
    expect(file?.status).toBe("modified");
    expect(file?.binary).toBe(false);
  });

  test("it counts what changed", () => {
    const [file] = parseDiff(SIMPLE);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
  });

  test("several files come back in order", () => {
    const two = diff(
      SIMPLE,
      "diff --git a/src/search/query.ts b/src/search/query.ts",
      "--- a/src/search/query.ts",
      "+++ b/src/search/query.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
    );
    expect(parseDiff(two).map((f) => f.path))
      .toEqual(["src/search/indexer.ts", "src/search/query.ts"]);
  });

  test("empty input is no files rather than a throw", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff(undefined as never)).toEqual([]);
  });
});

describe("line numbers", () => {
  test("they start where the hunk header says", () => {
    const [file] = parseDiff(SIMPLE);
    const first = file?.hunks[0]?.lines[0];
    expect(first?.kind).toBe("ctx");
    expect(first?.oldNo).toBe(142);
    expect(first?.newNo).toBe(142);
  });

  test("an addition advances only the new side", () => {
    const [file] = parseDiff(SIMPLE);
    const added = file!.hunks[0]!.lines.filter((l) => l.kind === "add");
    expect(added.map((l) => l.newNo)).toEqual([144, 145]);
    expect(added.every((l) => l.oldNo === null)).toBe(true);
  });

  test("a deletion advances only the old side", () => {
    const [file] = parseDiff(SIMPLE);
    const removed = file!.hunks[0]!.lines.filter((l) => l.kind === "del");
    expect(removed.map((l) => l.oldNo)).toEqual([144]);
    expect(removed.every((l) => l.newNo === null)).toBe(true);
  });

  test("the two sides diverge and stay diverged after the hunk", () => {
    const [file] = parseDiff(SIMPLE);
    const last = file!.hunks[0]!.lines.at(-1);
    // Two added and one removed, so by the last context line the new side is
    // one ahead of the old.
    expect(last?.oldNo).toBe(145);
    expect(last?.newNo).toBe(146);
  });

  test("AN EMPTY CONTEXT LINE STILL COUNTS", () => {
    // The one that silently desynchronises everything under it. Git writes a
    // blank context line as a single space, and plenty of things that touch a
    // patch write it as a completely empty string. Skipping it shifts every
    // number below by one.
    const withBlank = diff(
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,4 +1,4 @@",
      " first",
      "",
      " third",
      "-fourth",
      "+FOURTH",
    );
    const [file] = parseDiff(withBlank);
    const lines = file!.hunks[0]!.lines;
    expect(lines.map((l) => l.newNo)).toEqual([1, 2, 3, null, 4]);
    expect(lines[1]?.kind).toBe("ctx");
  });

  test("a second hunk restarts from its own header", () => {
    const twoHunks = diff(
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -80,2 +80,3 @@",
      " y",
      "+z",
    );
    const [file] = parseDiff(twoHunks);
    expect(file?.hunks).toHaveLength(2);
    expect(file!.hunks[1]!.lines[0]?.newNo).toBe(80);
    expect(file!.hunks[1]!.lines[1]?.newNo).toBe(81);
  });

  test("a one-line hunk header with no counts is legal", () => {
    const terse = diff(
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -12 +12 @@",
      "-a",
      "+b",
    );
    const [file] = parseDiff(terse);
    expect(file!.hunks[0]!.lines[0]?.oldNo).toBe(12);
    expect(file!.hunks[0]!.lines[1]?.newNo).toBe(12);
  });
});

describe("the markers are not part of the text", () => {
  test("a line keeps its content and loses its +/-/space", () => {
    const [file] = parseDiff(SIMPLE);
    const added = file!.hunks[0]!.lines.find((l) => l.kind === "add");
    expect(added?.text).toBe("    number: call.rawNumber,");
    // Keeping the marker would mean every consumer strips it — including a
    // comment body, which would then quote a `+`.
    expect(added?.text.startsWith("+")).toBe(false);
  });

  test("a line whose content starts with + or - survives", () => {
    // `++i` added, `--count` removed. Slicing one character is right; anything
    // cleverer eats real code.
    const tricky = diff(
      "diff --git a/x.c b/x.c",
      "--- a/x.c",
      "+++ b/x.c",
      "@@ -1,2 +1,2 @@",
      "---count;",
      "+++i;",
    );
    const [file] = parseDiff(tricky);
    expect(file!.hunks[0]!.lines[0]?.text).toBe("--count;");
    expect(file!.hunks[0]!.lines[1]?.text).toBe("++i;");
  });
});

describe("the shapes that are not a plain edit", () => {
  test("a new file", () => {
    const added = diff(
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
    );
    const [file] = parseDiff(added);
    expect(file?.status).toBe("added");
    expect(file?.path).toBe("new.ts");
    expect(file?.additions).toBe(2);
  });

  test("a deleted file keeps the name it had, not /dev/null", () => {
    const gone = diff(
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
    );
    const [file] = parseDiff(gone);
    expect(file?.status).toBe("deleted");
    expect(file?.path).toBe("old.ts");
    expect(file?.path).not.toContain("null");
  });

  test("a rename says both names", () => {
    const moved = diff(
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 96%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    );
    const [file] = parseDiff(moved);
    expect(file?.status).toBe("renamed");
    expect(file?.from).toBe("src/old.ts");
    expect(file?.path).toBe("src/new.ts");
    expect(fileLabel(file!)).toBe("src/old.ts → src/new.ts");
  });

  test("a rename with no content change is still an entry", () => {
    // It has a `diff --git` and no `---`/`+++` at all. Splitting on the latter
    // would make it vanish from the list.
    const moved = diff(
      "diff --git a/src/old.ts b/src/new.ts",
      "rename from src/old.ts",
      "rename to src/new.ts",
    );
    expect(parseDiff(moved)).toHaveLength(1);
  });

  test("a binary file says so and carries no lines", () => {
    const bin = diff(
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    );
    const [file] = parseDiff(bin);
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toHaveLength(0);
  });

  test("no newline at end of file is a note, not a line", () => {
    const noEol = diff(
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
    );
    const [file] = parseDiff(noEol);
    const lines = file!.hunks[0]!.lines;
    expect(lines[1]?.kind).toBe("meta");
    // It occupies no line on either side, so the addition after it is still 1.
    expect(lines[2]?.newNo).toBe(1);
  });
});

describe("what can carry a comment", () => {
  test("an added line can", () => {
    const [file] = parseDiff(SIMPLE);
    const added = file!.hunks[0]!.lines.find((l) => l.kind === "add");
    expect(commentableLine(added!)).toBe(144);
  });

  test("a context line can", () => {
    const [file] = parseDiff(SIMPLE);
    const ctx = file!.hunks[0]!.lines.find((l) => l.kind === "ctx");
    expect(commentableLine(ctx!)).toBe(142);
  });

  test("a deleted line cannot", () => {
    // GitHub anchors a review comment to the file as it is NOW. Offering the
    // box on a row with no such line is a control that fails after somebody
    // has typed into it.
    const [file] = parseDiff(SIMPLE);
    const removed = file!.hunks[0]!.lines.find((l) => l.kind === "del");
    expect(commentableLine(removed!)).toBeNull();
  });

  test("nor can the no-newline note", () => {
    const noEol = diff(
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "+b",
      "\\ No newline at end of file",
    );
    const [file] = parseDiff(noEol);
    const meta = file!.hunks[0]!.lines.find((l) => l.kind === "meta");
    expect(commentableLine(meta!)).toBeNull();
  });
});
