/*
 * After "Update · 7" the card said "checking" and "Up to date" while the page said 7 behind.
 * One store, one value: a refresh drops what the page holds, discards an answer asked for
 * before the update, and the footer never claims "Up to date" over an unknown count.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { api } from "../src/lib/api.ts";
import { behindAnswer, behindOf, forgetBehind, onBehind, refreshBehind } from "../src/lib/prBehindStore.ts";
import { secondaryFor } from "../src/lib/prCardView.ts";

const ROOT = "/work/orbit";
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => forgetBehind());

describe("refresh after an update", () => {
  it("an answer asked before the refresh is dropped and asked again: the new count wins", async () => {
    const answers: Array<(v: unknown) => void> = [];
    (api as any).prBehind = () => new Promise((res) => answers.push(res));
    behindOf(ROOT, 1042);                       // asked before the update
    refreshBehind(ROOT, 1042);                  // Update branch finished
    answers[0]!({ ok: true, behind: 7 });       // the old answer lands late
    await flush();
    expect(behindAnswer(ROOT, 1042).behind).toBeNull(); // not kept
    answers[1]!({ ok: true, behind: 0 });
    await flush();
    expect(behindAnswer(ROOT, 1042).behind).toBe(0);
  });

  it("readers are told the moment the count is dropped, so the page cannot keep saying 7", async () => {
    const answers: Array<(v: unknown) => void> = [];
    (api as any).prBehind = () => new Promise((res) => answers.push(res));
    let told = 0;
    const off = onBehind(() => told++);
    refreshBehind(ROOT, 1042);
    off();
    expect(told).toBeGreaterThan(0);
    // Answer the read it started: a read left pending would keep the store's running-read slot for the next test.
    for (const a of answers) a({ ok: true, behind: 0 });
    await flush();
  });
});

describe("the footer and the Branch cell share one unknown", () => {
  const p = { isDraft: false, mergeable: "MERGEABLE", baseRefName: "main", headRefName: "feat/thing" } as never;
  it("unknown count: no 'Up to date' claim", () => {
    expect(secondaryFor(p, "open" as never, null, false, "open" as never, true).upToDate).toBe(false);
  });
  it("known zero: 'Up to date'; known 7: 'Update · 7'", () => {
    expect(secondaryFor(p, "open" as never, 0, false, "open" as never).label).toBe("Up to date");
    expect(secondaryFor(p, "open" as never, 7, false, "open" as never).label).toBe("Update · 7");
  });
});
