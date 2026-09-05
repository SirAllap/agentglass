/*
 * THE CARRY-OVER LIST HAS TO NAME EVERY FIELD THE SECOND PASS FILLS.
 *
 * A pull request row arrives in two passes: the bare row, then the checks, the
 * review verdict, the tracker card and the rest. `keepLoadedChecks` carries the
 * second pass across a refresh so a card does not blank back to its first pass
 * while the new one lands.
 *
 * It carries the fields named in `SECOND_PASS`, and nothing else. A field added
 * to the server's second pass and forgotten there vanishes on every poll and
 * returns a second later — the board losing its verdict header and its tracker
 * line over and over, which is what "they stay like that until they load" was.
 *
 * Nothing failed. Nothing logged. Two lists that have to agree, and no reason
 * for anyone to look at the second one when adding to the first — so the check
 * is derived from the server's own type rather than from anybody's memory.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/** The keys of the `SecondPass` type in prs.ts — the server's own answer to
 *  "what does the second pass fill". */
function serverFields(): string[] {
  /* The `Pick<...>` union, not "up to the first semicolon": the type has
     semicolons INSIDE it, and cutting at the first one read three characters
     and reported an empty list — which two empty lists then agree about
     perfectly. Same cut this repository keeps getting wrong. */
  const src = read("../server/src/prs.ts");
  const i = src.indexOf("type SecondPass =");
  const from = src.indexOf("Pick<PrSummary,", i);
  const decl = src.slice(from, src.indexOf(">", from));
  return [...decl.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!);
}

/** The list the client carries across a refresh. */
function clientFields(): string[] {
  const src = read("src/lib/prMerge.ts");
  const i = src.indexOf("const SECOND_PASS =");
  const decl = src.slice(i, src.indexOf("] as const", i));
  return [...decl.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!);
}

describe("what survives a refresh", () => {
  test("the scan reads both lists", () => {
    // The guard on the guard: two empty lists agree perfectly.
    expect(serverFields().length, "server SecondPass").toBeGreaterThan(5);
    expect(clientFields().length, "client SECOND_PASS").toBeGreaterThan(5);
  });

  test("every field the server fills is carried across", () => {
    const missing = serverFields().filter((f) => !clientFields().includes(f));
    expect(missing, "these blank out on every refresh and come back a second later").toEqual([]);
  });

  test("and `checksLoaded` is carried too, since it gates the carry itself", () => {
    /* It is not in the server's `stats` — it is set beside them — so the
       derived check above cannot catch it. Without it a carried row would
       still claim to be waiting. */
    expect(clientFields()).toContain("checksLoaded");
  });
});
