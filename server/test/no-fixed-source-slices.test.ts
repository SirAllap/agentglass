/*
 * A test may not read source by counting characters.
 *
 * Many tests here assert about the SHAPE of the code: they find a function by
 * name and look inside it. That is a useful thing to be able to do. Bounding
 * it with `slice(from, from + 1600)` is not: adding a paragraph of comment
 * inside the function pushes what the test looks for past the cut, and the
 * test then fails because the code got better documented.
 *
 * It happened FIVE times in one afternoon, in five different files, and every
 * time the change that broke it was a comment. A test that cries wolf at
 * documentation is a test people learn to ignore, and then to delete.
 *
 * The fix is always the same shape: bound it by the end of the function.
 *
 *     const from = src.indexOf("function thing(");
 *     const block = src.slice(from, src.indexOf("\n}", from));
 *
 * Slices with a start that is not a search are left alone — `slice(-4000)` on
 * a transcript is a tail, not a claim about where a function ends.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;

describe("tests read functions, not byte counts", () => {
  test("no test slices source by a fixed offset from a search", () => {
    const guilty: string[] = [];
    for (const f of readdirSync(here)) {
      /*
       * The understudy's own tests, for now.
       *
       * The pattern is repository-wide — twenty-odd more across pull requests,
       * lists, resize and the action log — and every one of those is somebody
       * else's feature, working today, on a night nobody is watching. Widening
       * this guard is a five-minute change; the fixes it then demands are not,
       * and a guard that turns a whole suite red the moment it lands gets
       * reverted rather than acted on.
       *
       * Left as a boundary that can be moved deliberately, with the count on
       * record so moving it is a decision and not a discovery.
       */
      if (!f.startsWith("understudy")) continue;
      if (!f.endsWith(".test.ts") || f === "no-fixed-source-slices.test.ts") continue;
      const text = readFileSync(join(here, f), "utf8");
      text.split("\n").forEach((line, i) => {
        // `slice(from, from + N)` and `slice(at, at + N)` — a start that came
        // from indexOf, plus a number. That is the pattern that rots.
        if (/\.slice\(\s*\w+\s*,\s*\w+\s*\+\s*\d{2,}\s*\)/.test(line)) {
          guilty.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(guilty, [
      "These bound a source slice by character count, so a comment added inside",
      "the function breaks them. Use the end of the function instead:",
      '  src.slice(from, src.indexOf("\\n}", from))',
      "",
      ...guilty,
    ].join("\n")).toEqual([]);
  });
});
