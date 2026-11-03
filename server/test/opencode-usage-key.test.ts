import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearUsageKey, hasUsageKey, setUsageKey, usageKey, __setUsageKeyPath } from "../src/usagekey.ts";
import { FORBIDDEN, LIMITS_URL, parseUsageLimits, readUsageLimits } from "../src/opencodeapi.ts";

const dirs: string[] = [];
const store = (): string => {
  const d = mkdtempSync(join(tmpdir(), "agx-usage-key-"));
  dirs.push(d);
  return join(d, "opencode-usage-key");
};

afterEach(() => {
  __setUsageKeyPath(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the key store", () => {
  test("stores it 0600 and never hands it out through hasUsageKey", () => {
    const p = store();
    __setUsageKeyPath(p);
    expect(hasUsageKey()).toBe(false);
    setUsageKey("  sk-example\n");
    expect(usageKey()).toBe("sk-example");
    expect(hasUsageKey()).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("a file that already existed with looser permissions is tightened", () => {
    const p = store();
    writeFileSync(p, "old\n", { mode: 0o644 });
    chmodSync(p, 0o644);
    __setUsageKeyPath(p);
    setUsageKey("sk-new");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("clearing removes it, and an empty paste is refused", () => {
    __setUsageKeyPath(store());
    setUsageKey("sk-example");
    clearUsageKey();
    expect(hasUsageKey()).toBe(false);
    expect(() => setUsageKey("   ")).toThrow();
  });
});

describe("the console answer", () => {
  test("three windows, from percentages or a used/limit pair", () => {
    const w = parseUsageLimits({ limits: [
      { label: "5h", usedPercent: 41 },
      { window: "weekly", used: 9, limit: 30, resetsAt: "2026-11-02T00:00:00Z" },
      { name: "monthly", percent: 12.5 },
    ] });
    expect(w?.map((x) => [x.minutes, x.usedPercent])).toEqual([[300, 41], [10080, 30], [43200, 12.5]]);
    expect(w?.[1]?.resetsAt).toBe("2026-11-02T00:00:00Z");
  });

  test("a shape with two windows is refused rather than filled in", () => {
    expect(parseUsageLimits({ limits: [{ label: "5h", usedPercent: 10 }, { label: "weekly", usedPercent: 20 }] })).toBeNull();
    expect(parseUsageLimits({ hello: "there" })).toBeNull();
    expect(parseUsageLimits(null)).toBeNull();
  });

  test("403 is the Budgets: Read sentence and is never a reading", async () => {
    const r = await readUsageLimits("sk-example", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    expect(r).toEqual({ status: "forbidden", reason: FORBIDDEN });
    expect(FORBIDDEN).toContain("this key needs Budgets: Read");
  });

  test("the key travels as a bearer header to the one route we try", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const body = { windows: [
      { label: "5h", usedPercent: 1 }, { label: "weekly", usedPercent: 2 }, { label: "monthly", usedPercent: 3 },
    ] };
    const r = await readUsageLimits("sk-example", (async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);
    expect(seen!).toEqual({ url: LIMITS_URL, auth: "Bearer sk-example" });
    expect(r.status).toBe("ok");
  });
  test("the Go route's own shape: usage.rolling, weekly and monthly with a percent and a reset", () => {
    const w = parseUsageLimits({ usage: { rolling: { percent: 33, resetsAt: "2026-10-31T23:00:00Z" }, weekly: { percent: 53, resetsAt: 1793600000 }, monthly: { percent: 27, resetsAt: "2026-11-30T00:00:00Z" } } });
    expect(w?.map((r) => [r.label, r.usedPercent])).toEqual([["5h", 33], ["weekly", 53], ["monthly", 27]]);
    expect(w?.[1].resetsAt).toBe(new Date(1793600000 * 1000).toISOString());
  });
});
