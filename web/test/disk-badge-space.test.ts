import { describe, expect, test } from "bun:test";
import { badgeSpace } from "../src/lib/diskWarnPref.ts";

const low = { state: "low", free: 12e9, total: 200e9 } as const;
const crit = { state: "critical", free: 4e9, total: 200e9 } as const;
const ok = { state: "ok", free: 90e9, total: 200e9 } as const;

describe("badgeSpace", () => {
  test("the peek wins over the scan's reading", () => expect(badgeSpace(crit, low)).toBe(crit));
  test("falls back to the scan when the peek has none", () => { expect(badgeSpace(null, low)).toBe(low); expect(badgeSpace(undefined, low)).toBe(low); });
  test("ok or unknown shows no badge", () => { expect(badgeSpace(ok, low)).toBeNull(); expect(badgeSpace(null, null)).toBeNull(); });
});
