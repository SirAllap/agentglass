/*
 * A refresh may add and it may correct. It may not un-know.
 *
 * Reported from the app: the board loads correctly, then every card turns into
 * "Still reading its checks", then it comes right on its own. The list arrives
 * in two passes — rows first, check rollups about four seconds behind — and
 * every later fetch starts at the fast pass too, so each poll replaced the real
 * answer with the empty one for a few seconds.
 */
import { describe, expect, it } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import { keepLoadedChecks } from "../src/lib/prMerge.ts";

const green = { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] };
const empty = { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] };

const row = (number: number, o: Record<string, unknown> = {}): PrSummary => ({
  number, title: `pull request ${number}`, checks: empty, additions: 0, deletions: 0, changedFiles: 0,
  ...o,
} as unknown as PrSummary);

const loaded = (number: number) =>
  row(number, { checks: green, checksLoaded: true, additions: 12, deletions: 3, changedFiles: 4 });
const fast = (number: number) => row(number, { checksLoaded: false });

describe("merging a list that has not finished loading", () => {
  it("keeps the check states the previous answer had", () => {
    const [p] = keepLoadedChecks([loaded(1)], [fast(1)]);
    expect(p!.checksLoaded).toBe(true);
    expect(p!.checks.verdict).toBe("green");
  });

  it("keeps the diff stats too — they come back in the same pass", () => {
    // Otherwise the card reads "+0 −0 · 0f" beside a real check state, which is
    // a worse lie than either half on its own.
    const [p] = keepLoadedChecks([loaded(1)], [fast(1)]);
    expect([p!.additions, p!.deletions, p!.changedFiles]).toEqual([12, 3, 4]);
  });

  it("takes a real answer over a remembered one", () => {
    const fresh = row(1, { checks: { ...green, failure: 2, verdict: "red" }, checksLoaded: true });
    expect(keepLoadedChecks([loaded(1)], [fresh])[0]!.checks.verdict).toBe("red");
  });

  it("leaves a pull request it has never seen alone", () => {
    expect(keepLoadedChecks([loaded(1)], [fast(2)])[0]!.checksLoaded).toBe(false);
  });

  it("does not patch a caller that never had two passes", () => {
    // `undefined` is "this summary was not built that way" — a demo board, a
    // fixture — and inventing a rollup for it would be worse than an empty one.
    const one = row(1);
    expect(keepLoadedChecks([loaded(1)], [one])[0]).toBe(one);
  });

  it("hands back the same array when nothing was carried over", () => {
    // A poll that changed nothing must not provoke a re-render of the board.
    const next = [loaded(1)];
    expect(keepLoadedChecks([loaded(1)], next)).toBe(next);
  });

  it("survives the first fetch, when there is no previous list", () => {
    const next = [fast(1)];
    expect(keepLoadedChecks([], next)).toBe(next);
  });
});
