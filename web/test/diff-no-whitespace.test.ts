/*
 * Reading a formatting pass.
 *
 * A prettier run deletes and re-adds every line of a file, with one real change
 * somewhere in it. What matters in these tests is not that the noise goes — it is
 * that the SIGNAL cannot go with it, and there is one specific way for that to
 * happen: fold a whitespace-only pair out of the middle of a replacement run and
 * every pairing after it is off by one, so a real change gets drawn against the wrong
 * line. That is the last test in the first block.
 */
import { describe, expect, it } from "bun:test";
import type { ParsedFile, ParsedHunk } from "../src/lib/prBody.ts";
import { hunkChanges, hunkWithoutWhitespace, withoutWhitespace } from "../src/lib/diffNoWhitespace.ts";

const hunk = (lines: string[]): ParsedHunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines });
const file = (path: string, hunks: ParsedHunk[]): ParsedFile => ({ path, additions: 0, deletions: 0, hunks });

describe("a hunk, whitespace-blind", () => {
  it("folds a re-indent into context", () => {
    const h = hunkWithoutWhitespace(hunk(["-  const x = 1;", "+    const x = 1;"]));
    expect(h.lines).toEqual(["     const x = 1;"]);
    expect(hunkChanges(h)).toBe(false);
  });

  it("folds tabs against spaces", () => {
    const h = hunkWithoutWhitespace(hunk(["-\tif (a) {", "+  if (a) {"]));
    expect(hunkChanges(h)).toBe(false);
  });

  it("keeps a change that is not only whitespace", () => {
    const h = hunkWithoutWhitespace(hunk(["-const x = 1;", "+const x = 2;"]));
    expect(h.lines).toEqual(["-const x = 1;", "+const x = 2;"]);
    expect(hunkChanges(h)).toBe(true);
  });

  it("keeps context and git's no-newline note exactly as they were", () => {
    const src = [" untouched", "-a", "+ a", "\\ No newline at end of file"];
    // `-a` against `+ a` folds to a context line: one space for the marker, then the
    // addition's own text — which already begins with the space it gained.
    expect(hunkWithoutWhitespace(hunk(src)).lines).toEqual([" untouched", "  a", "\\ No newline at end of file"]);
  });

  // The one that would turn noise-removal into a wrong diff.
  it("stops folding at the first real difference, so nothing gets paired off by one", () => {
    const h = hunkWithoutWhitespace(hunk([
      "-  a",      // whitespace only
      "-  b",      // REAL change
      "-  c",
      "+    a",
      "+    B",
      "+    c",
    ]));
    // The first pair folds; b/B and c stay as the pair they are, in order.
    expect(h.lines).toEqual(["     a", "-  b", "-  c", "+    B", "+    c"]);
    expect(hunkChanges(h)).toBe(true);
  });

  it("leaves an unbalanced run alone past the pairs it has", () => {
    const h = hunkWithoutWhitespace(hunk(["-  a", "-  extra", "+    a"]));
    expect(h.lines).toEqual(["     a", "-  extra"]);
    expect(hunkChanges(h)).toBe(true);
  });

  it("recounts the hunk's own line totals", () => {
    const h = hunkWithoutWhitespace(hunk([" ctx", "-  a", "+    a", "-real", "+new"]));
    expect(h.oldLines).toBe(3); // ctx + folded + real
    expect(h.newLines).toBe(3); // ctx + folded + new
  });

  it("a pure addition is not touched", () => {
    const h = hunkWithoutWhitespace(hunk(["+  brand new"]));
    expect(h.lines).toEqual(["+  brand new"]);
    expect(hunkChanges(h)).toBe(true);
  });
});

describe("the whole diff", () => {
  it("drops a file that was only reformatted, and names it", () => {
    const out = withoutWhitespace([
      file("src/pretty.ts", [hunk(["-  a", "+    a"])]),
      file("src/real.ts", [hunk(["-a", "+b"])]),
    ]);
    expect(out.files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(out.onlyWhitespace).toEqual(["src/pretty.ts"]);
  });

  it("recounts what is left, so the header cannot claim the noise", () => {
    const out = withoutWhitespace([file("src/mixed.ts", [hunk(["-  a", "+    a", "-x", "+y"])])]);
    expect(out.files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  // A binary file parses to zero hunks — see diffKind. It has no whitespace to
  // ignore, and calling it "only whitespace" would hide a changed PNG.
  it("leaves a file with no hunks alone", () => {
    const out = withoutWhitespace([file("logo.png", [])]);
    expect(out.files.map((f) => f.path)).toEqual(["logo.png"]);
    expect(out.onlyWhitespace).toEqual([]);
  });

  it("does nothing to a diff with no whitespace-only changes in it", () => {
    const src = [file("a.ts", [hunk(["-a", "+b"])])];
    const out = withoutWhitespace(src);
    expect(out.files[0]!.hunks[0]!.lines).toEqual(["-a", "+b"]);
    expect(out.onlyWhitespace).toEqual([]);
  });
});
