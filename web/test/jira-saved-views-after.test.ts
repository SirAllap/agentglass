/*
 * A saved view removed from the tab strip also left the sidebar's "Starred filters" list: the strip and the sidebar each
 * hold their own copy of the saved views, and only the strip's copy was re-read after the removal. The stale sidebar row
 * pointed at a view the server no longer had, so a click opened nothing. Every change that succeeds now tells the sidebar.
 */
import { describe, expect, test } from "bun:test";
import { afterChange } from "../src/lib/useJiraSavedViews.ts";

describe("afterChange", () => {
  test("a removal that worked re-reads the strip, then tells the sidebar", async () => {
    const calls: string[] = [];
    const r = await afterChange(Promise.resolve({ ok: true }), async () => { calls.push("strip"); }, () => calls.push("sidebar"));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["strip", "sidebar"]);
  });
  test("a removal that failed changes nothing", async () => {
    const calls: string[] = [];
    await afterChange(Promise.resolve({ ok: false }), async () => { calls.push("strip"); }, () => calls.push("sidebar"));
    expect(calls).toEqual([]);
  });
});
