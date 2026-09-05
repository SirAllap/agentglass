/*
 * A backtick inside a page script ends the template literal that builds it.
 *
 * Three times in one evening — once by the clone, twice by hand — a comment
 * written INSIDE one of these template literals quoted an identifier with
 * backticks, the way every other comment in this repo does, and silently
 * closed the string. What comes back is a parse error tens of lines away
 * about a word from the middle of an English sentence.
 *
 * THE HISTORY OF THIS LOCK, because it is the point:
 *
 *   1. Counting backticks across the file. Passed while the file was broken —
 *      an even number is not the same fact as a correct one.
 *   2. Importing the module to see whether it parsed. HUNG rather than
 *      failing, which is worse than no check: a hang reads as a slow suite.
 *   3. Hand-tracking which characters sit inside a template. Reported THIRTY
 *      FIVE violations in a file that compiled cleanly — every ordinary
 *      TypeScript comment that quoted an identifier desynchronised it. A lock
 *      with false positives is worse than no lock, because it asks people to
 *      "fix" healthy code and teaches them to ignore it.
 *
 * So it asks the transpiler, which is the only thing here that actually knows
 * where a template starts and ends. It cannot name the line — the parse error
 * never points at the real one anyway — but it is never wrong about whether
 * the file is broken, and the comment above tells whoever hits it what to
 * look for.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const FILES = ["browserObserve.ts", "browserDrive.ts"];

describe("the scripts that get built as strings", () => {
  for (const name of FILES) {
    test(`${name} parses — a backtick in a page-script comment is what breaks it`, () => {
      const src = readFileSync(new URL(`../src/lib/${name}`, import.meta.url), "utf8");
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      expect(
        () => transpiler.transformSync(src),
        `${name} does not parse. If you just added a comment INSIDE one of the template literals that build page JavaScript, a backtick in it ended the template — remove the backticks from that comment.`,
      ).not.toThrow();
    });
  }
});

describe("escapes that survive the template literal", () => {
  /*
   * The other half of the same trap. Inside a template literal `\s` is not a
   * regex escape — the backslash is consumed and the page receives `/s+/`,
   * which matches the LETTER s. A whitespace collapse quietly became a
   * letter-s collapse, and the only symptom is text that looks slightly wrong
   * in an error message nobody reads twice.
   *
   * Measured: it reached the "selector matched N elements" samples, where it
   * turned "Save changes" into "Save change" and nobody noticed, because the
   * sentence still read fine.
   *
   * The escapes that need doubling are the ones whose single form is also a
   * valid (different) pattern, so nothing throws.
   */
  /* `\n` and `\t` are here for a reason that cost an evening: a "\n" inside one
     of these page scripts arrives at the page as a REAL newline inside a string
     literal. That does not parse, so NOTHING runs — and every eval, `1+1`
     included, failed with an opaque bridge error. The regex escapes below fail
     quietly (matching the wrong thing); these two fail loudly, and much later. */
  const RISKY = ["\\s", "\\d", "\\w", "\\b", "\\S", "\\D", "\\W", "\\n", "\\t"];

  for (const name of ["browserObserve.ts", "browserDrive.ts"]) {
    test(`${name} doubles its regex escapes inside page scripts`, () => {
      const src = readFileSync(new URL(`../src/lib/${name}`, import.meta.url), "utf8");
      const bad: string[] = [];
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        /* Lines that build a regex, and lines that put an escape inside a
           STRING the page will parse — the second is where \n bites. */
        if (!/replace\(|match\(|test\(|split\(|join\(/.test(line)) continue;
        for (const esc of RISKY) {
          // A single backslash before the letter, not preceded by another.
          const single = new RegExp(`[^\\\\\\\\]\\\\${esc[1]}`);
          if (single.test(line) && !line.includes(`\\\\${esc[1]}`)) {
            bad.push(`${name}:${i + 1} — ${esc} needs to be \\${esc}`);
          }
        }
      }
      expect(bad, bad.join("; ")).toEqual([]);
    });
  }
});
