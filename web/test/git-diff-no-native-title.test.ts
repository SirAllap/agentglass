/*
 * The Git and diff views carry their hints as `data-tip`, drawn by TipHost, never as a native `title`.
 * A native title is a different box on every platform and opens on its own delay, beside the house tooltip
 * that every other hint in the app uses. Asserted on the source: every file of the view, one test each.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../src/components");
const VIEW = /^(git\/|Git|diff\/|Bisect|Blame|Compare|Conflict|Checkout|BasePicker|Merge)/;

const files = (readdirSync(ROOT, { recursive: true }) as string[])
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && VIEW.test(f) && !f.startsWith("MergeJiraCard"));

/** A `title=` whose element is a lowercase DOM tag. A component's own `title` prop (<GitDialog title=…>) is not a tooltip. */
function nativeTitles(src: string): number[] {
  const lines: number[] = [];
  for (const m of src.matchAll(/\btitle=[{"']/g)) {
    const open = src.lastIndexOf("<", m.index);
    const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(open, open + 40));
    if (tag && /^[a-z]/.test(tag[1]!)) lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
}

describe("Git and diff: no native title is left", () => {
  test("the view's files are found", () => expect(files.length).toBeGreaterThan(20));
  for (const f of files) {
    test(relative(ROOT, join(ROOT, f)), () => {
      expect(nativeTitles(readFileSync(join(ROOT, f), "utf8"))).toEqual([]);
    });
  }
});
