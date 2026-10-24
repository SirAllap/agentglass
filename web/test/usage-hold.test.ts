/*
 * After a switch the old login's numbers are gone from the server and the new
 * login's are not in yet. Measured on a fixture with no credentials file: the
 * plan strip disappeared altogether and stayed gone until the five-minute poll,
 * because the row came back unavailable and the busiest-provider rule skips
 * unavailable rows. A meter that vanishes reads as "nothing used". So the last
 * strip stays, marked as old, and the window asks again a few times quickly.
 * Pure decisions only: the timers and the fetch live in usageStore.
 */
import { describe, expect, it } from "bun:test";
import type { ProviderUsage } from "../../shared/types.ts";
import { HOLD_MAX_MS, RETRY_MS, heldAgeLabel, retryDelay, settleHold, startHold, stripRow } from "../src/lib/usageHold.ts";

const row = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider: "anthropic", label: "Claude", available: true, observedAt: 1_000,
  windows: [{ label: "5h", minutes: 300, usedPercent: 41, resetsAt: null }],
  account: { label: "Acme A", plan: "max", active: true }, ...over,
});
const none = (over: Partial<ProviderUsage> = {}) => row({ available: false, windows: [], observedAt: undefined, ...over });
const T = 100_000;

describe("startHold", () => {
  it("keeps the available rows of the login in use, by provider", () => {
    const h = startHold([row(), row({ provider: "codex", label: "Codex", account: undefined }), none({ provider: "antigravity" }),
      row({ account: { label: "Acme B", plan: "pro", active: false } })], T);
    expect([...h.keys()].sort()).toEqual(["anthropic", "codex"]);
    expect(h.get("anthropic")?.row.account?.label).toBe("Acme A");
  });
  it("is empty when nothing was on screen", () => {
    expect(startHold(null, T).size).toBe(0);
    expect(startHold([none()], T).size).toBe(0);
  });
});

describe("settleHold", () => {
  const h = () => startHold([row()], T);
  it("holds while the new login has no reading", () => {
    expect(settleHold(h(), [none()], T + 5_000).size).toBe(1);
  });
  it("lets go once the new login's own row is available", () => {
    expect(settleHold(h(), [row({ account: { label: "Acme B", plan: "pro", active: true } })], T + 5_000).size).toBe(0);
  });
  it("an inactive login's reading does not settle it", () => {
    expect(settleHold(h(), [row({ account: { label: "Acme B", plan: "pro", active: false } })], T + 5_000).size).toBe(1);
  });
  it("lets go after the cap, so an old login's numbers are not shown forever", () => {
    expect(settleHold(h(), [none()], T + HOLD_MAX_MS).size).toBe(0);
    expect(settleHold(h(), [none()], T + HOLD_MAX_MS - 1).size).toBe(1);
  });
});

describe("retryDelay", () => {
  it("asks again at 2 s, 4 s, 8 s and then stops: a few attempts, not a poll", () => {
    expect([0, 1, 2, 3, 4].map((n) => retryDelay(startHold([row()], T), n))).toEqual([2_000, 4_000, 8_000, null, null]);
    expect(RETRY_MS).toEqual([2_000, 4_000, 8_000]);
  });
  it("does not ask when there is nothing held", () => {
    expect(retryDelay(new Map(), 0)).toBeNull();
  });
});

describe("stripRow", () => {
  const held = () => [startHold([row()], T).get("anthropic")!.row];
  it("a live row wins and nothing is marked", () => {
    const live = row({ account: { label: "Acme B", plan: "pro", active: true } });
    expect(stripRow(live, held())).toEqual({ u: live, held: false });
  });
  it("no row at all: the held one is drawn, marked held", () => {
    const r = stripRow(null, held());
    expect(r.held).toBe(true);
    expect(r.u?.windows[0]?.usedPercent).toBe(41);
  });
  it("an unavailable row (no reading yet) does not hide the held strip", () => {
    expect(stripRow(none(), held()).held).toBe(true);
  });
  it("nothing held and nothing live: nothing", () => {
    expect(stripRow(null, [])).toEqual({ u: null, held: false });
    const n = none();
    expect(stripRow(n, [])).toEqual({ u: n, held: false });
  });
  it("of several held providers, the busiest is drawn", () => {
    const a = row();
    const b = row({ provider: "codex", label: "Codex", account: undefined, windows: [{ label: "5h", minutes: 300, usedPercent: 77, resetsAt: null }] });
    expect(stripRow(null, [a, b]).u?.provider).toBe("codex");
  });
});

describe("heldAgeLabel", () => {
  it("is always a number of minutes, at least one: the held strip is marked even when the reading is seconds old", () => {
    expect(heldAgeLabel(1_000, 1_000 + 10_000)).toBe("1m");
    expect(heldAgeLabel(1_000, 1_000 + 7 * 60_000)).toBe("7m");
    expect(heldAgeLabel(undefined, 5)).toBe("1m");
  });
});
