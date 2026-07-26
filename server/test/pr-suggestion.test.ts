// Applying a suggested change rewrites somebody's file, so the line arithmetic
// is worth pinning. GitHub has no "apply suggestion" API — the commit is
// written here — and an off-by-one silently eats a line rather than failing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-sug-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "s.db");

const prs = await import("../src/prs.ts");
const FILE = ["one", "two", "three", "four", "five"];

describe("spliceLines", () => {
  test("a single line is replaced in place, and nothing around it moves", () => {
    expect(prs.spliceLines(FILE, 3, 3, "THREE")).toBe("one\ntwo\nTHREE\nfour\nfive");
  });

  test("a range is replaced whole, however many lines it becomes", () => {
    // Three lines in, one out.
    expect(prs.spliceLines(FILE, 2, 4, "X")).toBe("one\nX\nfive");
    // One line in, three out.
    expect(prs.spliceLines(FILE, 2, 2, "a\nb\nc")).toBe("one\na\nb\nc\nthree\nfour\nfive");
  });

  test("the first and last lines are reachable — the off-by-one cases", () => {
    expect(prs.spliceLines(FILE, 1, 1, "ONE")).toBe("ONE\ntwo\nthree\nfour\nfive");
    expect(prs.spliceLines(FILE, 5, 5, "FIVE")).toBe("one\ntwo\nthree\nfour\nFIVE");
    expect(prs.spliceLines(FILE, 1, 5, "only")).toBe("only");
  });

  test("an empty suggestion deletes the lines rather than leaving a blank", () => {
    // GitHub treats an empty suggestion as "remove these lines"; a naive splice
    // would leave an empty string behind and change the file's shape.
    expect(prs.spliceLines(FILE, 2, 3, "")).toBe("one\n\nfour\nfive");
  });

  test("the trailing newline of a file is preserved", () => {
    const withTrailing = ["a", "b", ""];
    expect(prs.spliceLines(withTrailing, 1, 1, "A")).toBe("A\nb\n");
  });
});
