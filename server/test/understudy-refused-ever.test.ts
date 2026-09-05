/*
 * The privacy gate's own evidence has to be readable.
 *
 * `understudy_quarantine` records every passage refused for holding a private
 * term — a hash and a term INDEX, never the term itself, because a table of
 * the exact strings we promised not to keep would be the worst possible shape
 * for the table whose whole purpose is that promise.
 *
 * FOUND BY AUDIT: eight rows on this machine, one writer, and NOT ONE READER.
 * Meanwhile the Teach tab showed "refused 0" — a different number entirely,
 * counted in memory during the last read and discarded with it.
 *
 * A zero there reads as "the gate has never had to stop anything". That is the
 * opposite of what eight rows mean, and it is the direction a privacy figure
 * must never be wrong in.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/understudy.ts", import.meta.url)).text();
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const teach = await Bun.file(new URL("../../web/src/components/understudy/Teach.tsx", import.meta.url)).text();

describe("what was refused is not write-only", () => {
  test("the count can be read at all", () => {
    expect(src).toContain("export function quarantinedEver()");
    expect(src).toContain("SELECT COUNT(*) AS n FROM understudy_quarantine");
  });

  test("and it reaches the screen that claims to report it", () => {
    const from = index.indexOf('pathname === "/understudy/sources"');
    const next = index.indexOf("if (pathname ===", from + 20);
    expect(index.slice(from, next)).toContain("refusedEver: quarantinedEver()");
  });

  test("the figure shown is the total, not the last read's", () => {
    const code = teach.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    // The big number is the persistent one…
    expect(code).toContain("data.refusedEver ?? 0");
    expect(code).toContain('color: data.refusedEver ?');
    // …and the pass-scoped number keeps its place in the sentence that says
    // which pass it means, where it is not misleading.
    expect(code).toContain("data.learned.quarantined > 0");
  });

  test("the term itself is still never stored", () => {
    /*
     * The reason this table is defensible at all. Reading it must not create a
     * reason to start keeping what it deliberately does not keep.
     */
    const at = src.indexOf("INSERT INTO understudy_quarantine");
    const cols = src.slice(at, src.indexOf(")", at));
    // A position in the list, never the string at that position.
    expect(cols).toContain("term_index");
    expect(cols).not.toContain("term_text");
    expect(cols).not.toContain("passage");
    // And the binding says so too: `$term` invites the day somebody passes the
    // term itself into a column that promised to hold an index.
    expect(src).toContain("$termIndex");
    expect(src).not.toContain("$term:");
  });
});
