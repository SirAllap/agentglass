/*
 * THE WATCH KNEW CI HAD PASSED; THE OPEN PULL REQUEST DID NOT.
 *
 * The chip said "CI passed" over a detail that still said 67/68 checks in and
 * one running. The server's watch read the checks on its own clock and told
 * nobody but the chip. Now that read is a frame the detail and the board take,
 * and a "CI passed" over checks that went back to pending says Notify again.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { PrCheck, PrCheckRollup, PrChecksRead, PrDetail, PrSummary, PrWatch } from "../../shared/types.ts";
import { detailWithChecks, rowWithChecks } from "../src/lib/prRefresh.ts";

let store: typeof import("../src/lib/prWatchStore.ts");
beforeAll(async () => {
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  store = await import("../src/lib/prWatchStore.ts");
});

const roll = (pending: number): PrCheckRollup => ({ total: 68, success: 68 - pending, failure: 0, skipped: 0, pending, allDone: pending === 0, verdict: pending ? null : "green" } as PrCheckRollup);
const chk = (name: string, required?: boolean) => ({ name, workflow: "ci", required } as unknown as PrCheck);
const read = (pending: number): PrChecksRead => ({ repo: "acme/orbit", number: 1042, checks: roll(pending), all: [chk("unit"), chk("summary")] });
const detail = { number: 1042, checks: roll(1), checksAll: [chk("unit", false), chk("summary", true)] } as unknown as PrDetail;

describe("detailWithChecks", () => {
  test("a finished read replaces the running strip and keeps the required marks", () => {
    const d = detailWithChecks(detail, "Acme/Orbit", read(0))!;
    expect(d.checks.allDone).toBe(true);
    expect(d.checksAll.find((c) => c.name === "summary")?.required).toBe(true);
  });
  test("another pull request, another repo, or the same checks change nothing", () => {
    expect(detailWithChecks(detail, "acme/orbit", { ...read(0), number: 7 })).toBeNull();
    expect(detailWithChecks(detail, "acme/other", read(0))).toBeNull();
    expect(detailWithChecks(detail, "acme/orbit", read(1))).toBeNull();
  });
  test("the board row takes it too", () => {
    const rows = [{ number: 1042, checks: roll(1) }, { number: 5, checks: roll(1) }] as unknown as PrSummary[];
    const out = rowWithChecks(rows, "acme/orbit", read(0));
    expect([out[0]!.checks.allDone, out[1]!.checks.allDone]).toEqual([true, false]);
  });
});

describe("the chip over a new run", () => {
  const w = { id: "a", repo: "acme/orbit", number: 1042, rule: { type: "ci-pass" }, active: false, lastAt: 1000, lastText: "CI passed" } as unknown as PrWatch;
  test("CI passed stands while the checks are done", () => expect(store.bellState([w], 0, true).kind).toBe("fired"));
  test("checks back to pending: Notify again", () => expect(store.bellState([w], 0, false).kind).toBe("off"));
  test("a red fire is not retired by a running suite", () => {
    const red = { ...w, rule: { type: "ci-fail" }, lastText: "CI failed: unit" } as unknown as PrWatch;
    expect(store.bellState([red], 0, false).kind).toBe("fired");
  });
});
