/*
 * Where a patch actually changed things.
 *
 * A diff knows a file changed at 883, 914 and 945, and then hands you the file
 * with no sign of where any of them are — "I don't know how to get to that line
 * quickly". These numbers are what the viewer opens at and what the rail down
 * its right offers, so being three lines off is not a rounding error: it is the
 * difference between a jump people trust and one they stop using.
 */
import { describe, expect, test } from "bun:test";
import { changedLines, fileSection, firstChangedLine, linesForFile } from "../src/lib/patchLines.ts";

/* A hunk that starts at 880 and changes the fourth line of it. The header says
   880; the answer is 883. */
const patch = `@@ -880,7 +880,7 @@ class Thing:
     twilio_number=G(Phone, number='20'),
     user=G(User, email='foo@example.test'),
 )
-    call = G(Call, sid='CA001')
+    call = G(Call, sid='CA001', from_number='1')
 # Check we get no errors
 self.assertListEqual(block(call), [])
@@ -911,7 +911,8 @@ class Thing:
 one
 two
-three
+three and a half
+four
 five`;

describe("the lines a patch touched", () => {
  test("the header is where the hunk starts, not where the change is", () => {
    expect(changedLines(patch)[0]).toBe(883);
    expect(firstChangedLine(patch)).toBe(883);
  });

  test("every changed place, in file order", () => {
    expect(changedLines(patch)).toEqual([883, 913, 914]);
  });

  test("a run of deletions is one jump, at the line they were taken from", () => {
    const gone = `@@ -10,6 +10,3 @@
 keep
-one
-two
-three
 keep`;
    expect(changedLines(gone)).toEqual([11]);
  });

  test("an added file counts from its first line", () => {
    const added = `@@ -0,0 +1,3 @@
+one
+two
+three`;
    expect(changedLines(added)).toEqual([1, 2, 3]);
  });

  test("nothing to say about nothing", () => {
    expect(changedLines("")).toEqual([]);
    expect(firstChangedLine("")).toBe(1);
  });

  test("capped, because a rewritten file is not a list of jumps", () => {
    const huge = `@@ -1,0 +1,500 @@\n${Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n")}`;
    expect(changedLines(huge, 12)).toHaveLength(12);
  });
});

describe("one file out of a whole diff", () => {
  const whole = `diff --git a/src/one.py b/src/one.py
index 111..222 100644
--- a/src/one.py
+++ b/src/one.py
@@ -5,3 +5,4 @@
 a
+b
 c
diff --git a/src/two.py b/src/two.py
index 333..444 100644
--- a/src/two.py
+++ b/src/two.py
@@ -40,2 +40,3 @@
 x
+y`;

  test("finds the section by its +++ line and stops at the next file", () => {
    expect(fileSection(whole, "src/one.py")).toContain("@@ -5,3 +5,4 @@");
    expect(fileSection(whole, "src/one.py")).not.toContain("@@ -40,2 +40,3 @@");
  });

  test("and the last file runs to the end", () => {
    expect(fileSection(whole, "src/two.py")).toContain("+y");
  });

  test("the lines of one file, not of its neighbours", () => {
    expect(linesForFile(whole, "src/one.py")).toEqual([6]);
    expect(linesForFile(whole, "src/two.py")).toEqual([41]);
  });

  test("a path that is not in the diff has no lines", () => {
    expect(linesForFile(whole, "src/three.py")).toEqual([]);
  });
});
