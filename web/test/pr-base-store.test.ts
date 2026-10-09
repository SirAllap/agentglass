// Asking for the bases a list does not hold: one request per branch, however
// many cards sit on it, remembered, and a failure is never "no pull request".
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const calls: string[] = [];
let answer: (b: string) => Promise<{ ok: boolean; pr?: unknown }> = async () => ({ ok: true, pr: null });
const { api } = await import("../src/lib/api.ts");
const real = api.prForHead;
(api as { prForHead: unknown }).prForHead = (_r: string, b: string) => { calls.push(b); return answer(b); };
const { askBases, foundBases, resetBases } = await import("../src/lib/prBaseStore.ts");
afterAll(() => { (api as { prForHead: unknown }).prForHead = real; });
beforeEach(() => { calls.length = 0; resetBases(); answer = async () => ({ ok: true, pr: null }); });
const tick = () => new Promise((r) => setTimeout(r, 5));
const pr = (number: number, head: string) => ({ number, state: "MERGED", isDraft: false, headRefName: head, baseRefName: "main", url: "" });

describe("prBaseStore", () => {
  test("ten cards on one base cost one request, and asking again inside the window costs none", async () => {
    for (let i = 0; i < 10; i++) askBases("/r", ["feat/a"]);
    await tick();
    askBases("/r", ["feat/a"]);
    await tick();
    expect(calls).toEqual(["feat/a"]);
  });
  test("what was found is handed back by branch, and 'none ever' is null, not absent", async () => {
    answer = async (b) => ({ ok: true, pr: b === "a" ? pr(7, "a") : null });
    askBases("/r", ["a", "b"]);
    await tick(); await tick();
    const f = foundBases("/r");
    expect(f.get("a")?.number).toBe(7);
    expect(f.has("b")).toBe(true);
    expect(f.get("b")).toBeNull();
  });
  test("a failed ask is not remembered as an answer: the card stays unmarked", async () => {
    answer = async () => ({ ok: false });
    askBases("/r", ["a"]);
    await tick();
    expect(foundBases("/r").has("a")).toBe(false);
  });
  test("a request that throws is the same as one that failed", async () => {
    answer = async () => { throw new Error("offline"); };
    askBases("/r", ["a"]);
    await tick();
    expect(foundBases("/r").has("a")).toBe(false);
  });
  test("two checkouts do not share answers", async () => {
    answer = async () => ({ ok: true, pr: pr(7, "a") });
    askBases("/r1", ["a"]);
    await tick();
    expect(foundBases("/r1").has("a")).toBe(true);
    expect(foundBases("/r2").has("a")).toBe(false);
  });
  test("no checkout, no request", async () => {
    askBases("", ["a"]);
    await tick();
    expect(calls).toEqual([]);
  });
  test("never more than two in flight at once", async () => {
    let live = 0, peak = 0;
    answer = async () => { live++; peak = Math.max(peak, live); await tick(); live--; return { ok: true, pr: null }; };
    askBases("/r", ["a", "b", "c", "d", "e"]);
    for (let i = 0; i < 12; i++) await tick();
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls.length).toBe(5);
  });
});
