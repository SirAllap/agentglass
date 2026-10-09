/*
 * A red card's checked rollup is one GraphQL request, so it is asked again
 * only when the list's reading of that card moves.
 *
 * With a one-minute answer and a Refresh that dropped every answer, each red
 * card on screen was a request a minute and one more per press. The list's
 * aggregate changes when a run finishes, re-run or not, so the same head and
 * the same aggregate are the same checks.
 */
import { afterAll, describe, expect, it } from "bun:test";

const calls: number[] = [];
const mod = await import("../src/lib/api.ts");
const api = mod.api as unknown as { prRollup: unknown };
const real = api.prRollup;
api.prRollup = async (_root: string, number: number) => {
  calls.push(number);
  return { ok: true, checks: { total: 2, success: 2, failure: 0, pending: 0 } };
};
afterAll(() => { api.prRollup = real; });

const { rollupOf } = await import("../src/lib/prRollupStore.ts");
const settle = () => new Promise((r) => setTimeout(r, 30));
const realNow = Date.now;

describe("a red card's checked rollup", () => {
  afterAll(() => { Date.now = realNow; });

  it("stands past the minute while the list says the same thing of the card", async () => {
    expect(rollupOf("/r", 7, "sha1|red")).toBeNull();
    await settle();
    expect(calls).toEqual([7]);
    const t0 = realNow();
    Date.now = () => t0 + 5 * 60_000;
    expect(rollupOf("/r", 7, "sha1|red")).not.toBeNull();
    await settle();
    expect(calls).toEqual([7]);
  });

  it("asks again the moment the head or the aggregate moves", async () => {
    rollupOf("/r", 7, "sha2|red");
    await settle();
    expect(calls).toEqual([7, 7]);
  });

  it("still asks again after ten minutes of the same reading", async () => {
    const t0 = realNow();
    Date.now = () => t0 + 16 * 60_000; // the answer above was stamped at +5
    rollupOf("/r", 7, "sha2|red");
    await settle();
    expect(calls).toEqual([7, 7, 7]);
  });
});
