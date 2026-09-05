/*
 * Nothing written, exported and then never asked.
 *
 * This is the third bug of the same shape in two days, and it is the one this
 * feature keeps producing:
 *
 *   `isHalted()` gated whether ledger rows get written and nothing else. Press
 *   the emergency stop, watch it wind back what a shift did, then hand over
 *   again and it carried straight on acting.
 *
 *   `shouldStop()` held the shift's two stop rules — one failed act ends it,
 *   five unread drafts end it. It was called by the seal hook that drafted
 *   proposals, and when drafting moved to the scanner the call did not move
 *   with it. One rule survived by accident; the other was documented as a
 *   safeguard and enforced nowhere.
 *
 *   `standingCount()` could tell somebody how much of what happened while they
 *   were out is still standing, which is the first thing anybody asks, and no
 *   caller had ever asked it.
 *
 * None of these were missing code. All three were correct, tested code that
 * nothing consulted — which is worse than an absence, because an absence is
 * visible and a disconnected safeguard reads as a promise.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const WEB = join(here, "..", "..", "web", "src", "components", "understudy");

/*
 * COMMENTS ARE NOT CALLERS, and for a while this guard counted them as such.
 *
 * `disagreements()` lost its last caller in a refactor and the guard stayed
 * green, because the word appears in the paragraph above the function and in a
 * comment two files away. The two functions beside it were caught only because
 * nobody happened to have written their names in prose. A guard whose answer
 * depends on how chatty the surrounding comments are is not measuring anything.
 *
 * Comments ONLY, and quoted text is deliberately left alone. A single-quote
 * regex that may cross a newline swallows whole functions the moment it meets
 * an unpaired apostrophe, and this file measures a 5,000-line dispatcher where
 * that is a certainty — the first attempt reported seven live functions as
 * dead. Missing a name that only ever appears inside a string is the smaller
 * error: it keeps something alive, where the other direction deletes it.
 */
const stripProse = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const read = (d: string) =>
  readdirSync(d)
    .filter((f) => statSync(join(d, f)).isFile() && (f.endsWith(".ts") || f.endsWith(".tsx")))
    .map((f) => [f, readFileSync(join(d, f), "utf8")] as const);

describe("every exported piece of the understudy has a caller", () => {
  test("a name written in a comment is not a caller", () => {
    /*
     * The failure this was added for: `disagreements()` lost its last caller in
     * a refactor and the guard stayed green, kept alive by the paragraph
     * directly above it and by one comment two files away. The two functions
     * beside it were caught only because nobody had happened to write their
     * names in prose — so which dead code this found depended on how chatty the
     * comments were, which is not a measurement.
     */
    const both = stripProse([
      "/** calls disagreements() when it feels like it */",
      "// and mentions disagreements again here",
      "const x = disagreements();",
    ].join("\n"));
    expect([...both.matchAll(/\bdisagreements\b/g)]).toHaveLength(1);

    // A URL is not a comment, and eating one would silently delete real code.
    expect(stripProse('const u = "http://example.test/x"; // gone')).toContain("http://example.test/x");
  });

  test("nothing is written, exported, and then never asked", () => {
    const server = read(SRC);
    const web = read(WEB).map(([, s]) => s).join("\n");
    const ours = server.filter(([f]) => f.startsWith("understudy"));

    /*
     * Test-only hatches are exempt BY NAME, not by being unused — the `__`
     * prefix is the convention that says "this exists for a test", and making
     * the exemption explicit means a real function cannot slip in behind it.
     */
    const isHatch = (n: string) => n.startsWith("__");

    const orphans: string[] = [];
    for (const [file, src] of ours) {
      for (const m of src.matchAll(/^export (?:async )?function (\w+)/gm)) {
        const name = m[1]!;
        if (isHatch(name)) continue;
        const re = new RegExp(`\\b${name}\\b`, "g");
        const elsewhere = server
          .filter(([f]) => f !== file)
          .reduce((n, [, s]) => n + [...stripProse(s).matchAll(re)].length, 0);
        const inWeb = [...stripProse(web).matchAll(re)].length;
        const atHome = [...stripProse(src).matchAll(re)].length - 1;
        if (elsewhere + inWeb + atHome === 0) orphans.push(`${file}: ${name}`);
      }
    }

    expect(
      orphans,
      `exported and called by nothing — a safeguard nobody asks is a promise, not a guard:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });

  test("the guard is looking at something", () => {
    // A sweep that walks no files passes beautifully and means nothing.
    expect(read(SRC).filter(([f]) => f.startsWith("understudy")).length).toBeGreaterThan(5);
  });
});
