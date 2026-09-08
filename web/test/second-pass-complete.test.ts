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
import { keepLoadedChecks } from "../src/lib/prMerge.ts";
import type { PrSummary } from "../../shared/types.ts";

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

/*
 * A REFRESH MAY NOT UN-KNOW A FIELD IT DID NOT ASK ABOUT.
 *
 * The rule at the top of prMerge.ts, applied to the case that broke it: GitHub
 * answers HTTP 200 with `{data, errors}` when only part of a query fails, so a
 * row arrives complete in every respect EXCEPT the field that timed out. The
 * second pass ran — `checksLoaded: true` — and the verdict is missing, which
 * is indistinguishable on the card from "nobody has reviewed this". Every
 * header on the board reset to "No review asked for yet" after a while, and
 * again on returning to the view.
 */
describe("a partial answer does not blank a card", () => {
  const row = (n: number, extra: Record<string, unknown> = {}) =>
    ({ number: n, title: `#${n}`, checksLoaded: true, ...extra }) as unknown as PrSummary;
  const verdict = { kind: "approved" as const, who: ["reviewer-one"] };

  test("a second pass that came back without the verdict keeps the one on screen", () => {
    const prev = [row(1, { humanReview: verdict, additions: 40 })];
    /* The shape GitHub actually sends: the pass ran, one field did not. */
    const next = [row(1, { additions: 40 })];
    const [out] = keepLoadedChecks(prev, next) as unknown as Record<string, unknown>[];
    expect(out!.humanReview).toEqual(verdict);
  });

  test("but a real answer replaces it, including a real \"nobody\"", () => {
    /* `null` is GitHub saying nobody reviewed it — an answer, and it wins.
       Only an ABSENT field is "this pass did not learn it". */
    const prev = [row(1, { humanReview: verdict })];
    const next = [row(1, { humanReview: null })];
    const [out] = keepLoadedChecks(prev, next) as unknown as Record<string, unknown>[];
    expect(out!.humanReview).toBeNull();
  });

  test("a changed verdict is not held back by the old one", () => {
    const changed = { kind: "changes" as const, who: ["reviewer-two"] };
    const prev = [row(1, { humanReview: verdict })];
    const next = [row(1, { humanReview: changed })];
    const [out] = keepLoadedChecks(prev, next) as unknown as Record<string, unknown>[];
    expect(out!.humanReview).toEqual(changed);
  });

  test("a caller with one pass at all is still left alone", () => {
    /* `undefined` checksLoaded means nobody promised two passes here; patching
       such a row from history would invent data the caller never had. */
    const prev = [row(1, { humanReview: verdict })];
    const next = [{ number: 1, title: "#1" } as unknown as PrSummary];
    const [out] = keepLoadedChecks(prev, next) as unknown as Record<string, unknown>[];
    expect(out!.humanReview).toBeUndefined();
  });

  test("and the whole first-pass row is still carried as before", () => {
    const prev = [row(1, { humanReview: verdict, additions: 40, checks: { green: 1 } })];
    const next = [row(1, { checksLoaded: false })];
    const [out] = keepLoadedChecks(prev, next) as unknown as Record<string, unknown>[];
    expect(out!.humanReview).toEqual(verdict);
    expect(out!.additions).toBe(40);
  });
});
