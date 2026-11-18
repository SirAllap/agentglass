/* A bulk Jira change: refused for a worker, with writes off, or past 50 cards; a failure is folded per card; a refused sprint call falls back card by card. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-bulk-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
const B = await import("../src/jiraBulk.ts");
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const KEYS = ["ORBIT-1042", "ORBIT-1043", "ORBIT-1044", "ORBIT-1045", "ORBIT-1046"];
const SPRINT = { kind: "sprint", value: "12" }; // "Orbit Sprint 12"

describe("bulkRefusal", () => {
  test("a worker is refused with one sentence", () => {
    process.env.AGENTGLASS_JIRA_WRITE = "1";
    expect(B.bulkRefusal(false, KEYS, SPRINT)).toEqual({ status: 403, error: "Only the person makes a bulk Jira change; an agent cannot." });
  });
  test("the write switch off refuses the person too", () => {
    delete process.env.AGENTGLASS_JIRA_WRITE;
    const r = B.bulkRefusal(true, KEYS, SPRINT);
    expect(r?.status).toBe(400);
    expect(r?.error).toContain("switched off");
  });
  test("51 cards are refused, 50 are not", () => {
    process.env.AGENTGLASS_JIRA_WRITE = "1";
    const many = (n: number) => Array.from({ length: n }, (_, i) => `ORBIT-${2000 + i}`);
    expect(B.bulkRefusal(true, many(51), SPRINT)?.error).toContain("at most 50");
    expect(B.bulkRefusal(true, many(50), SPRINT)).toBeNull();
  });
  test("a bad key or a bad kind is refused", () => {
    process.env.AGENTGLASS_JIRA_WRITE = "1";
    expect(B.bulkRefusal(true, ["not a key"], SPRINT)?.error).toContain("not a Jira card id");
    expect(B.bulkRefusal(true, KEYS, { kind: "delete" })?.status).toBe(400);
  });
});

const deps = (over: Partial<import("../src/jiraBulk.ts").BulkDeps> = {}) => {
  const calls: string[] = [];
  const d: import("../src/jiraBulk.ts").BulkDeps = {
    sprint: async (id, keys) => { calls.push(`sprint ${id} ${keys.join(",")}`); return { ok: true }; },
    backlog: async (keys) => { calls.push(`backlog ${keys.join(",")}`); return { ok: true }; },
    edit: async (key, ask) => { calls.push(`edit ${key} ${String(ask.field)}`); return { ok: true }; },
    assign: async (key, to) => { calls.push(`assign ${key} ${to}`); return { ok: true }; },
    ...over,
  };
  return { d, calls };
};

describe("runBulk", () => {
  test("a sprint move is one call for the whole set", async () => {
    const { d, calls } = deps();
    const r = await B.runBulk(d, KEYS, SPRINT as never);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBe(5);
    expect(calls).toEqual(["sprint 12 " + KEYS.join(",")]);
  });
  test("a refused whole set falls back to one call per card, and the error is per card", async () => {
    const { d, calls } = deps({
      sprint: async (_id, keys) => (keys.length > 1 || keys[0] === "ORBIT-1044" ? { ok: false, error: "Jira did not accept that sprint" } : { ok: true }),
    });
    const wrapped = { ...d, sprint: async (id: string, keys: string[]) => { calls.push(`sprint ${keys.length}`); return d.sprint(id, keys); } };
    const r = await B.runBulk(wrapped, KEYS, SPRINT as never);
    expect(calls).toEqual(["sprint 5", "sprint 1", "sprint 1", "sprint 1", "sprint 1", "sprint 1"]);
    expect(r.ok).toBe(false);
    expect(r.results.filter((x) => !x.ok)).toEqual([{ key: "ORBIT-1044", ok: false, error: "Jira did not accept that sprint" }]);
    expect(r.results.filter((x) => x.ok).length).toBe(4);
  });
  test("a field change that fails on two of five says which", async () => {
    const { d } = deps({ edit: async (key) => (key === "ORBIT-1042" || key === "ORBIT-1046" ? { ok: false, error: "Your Jira account cannot change this card" } : { ok: true }) });
    const r = await B.runBulk(d, KEYS, { kind: "priority", value: "2" });
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.ok)).toEqual([false, true, true, true, false]);
    expect(r.results[0].error).toBe("Your Jira account cannot change this card");
  });
  test("labels add and remove are one write each per card", async () => {
    const { d, calls } = deps();
    await B.runBulk(d, KEYS.slice(0, 2), { kind: "labels", add: ["orbit-a"], remove: ["orbit-b"] });
    expect(calls.length).toBe(4);
  });
  test("never more than 4 cards at once", async () => {
    let live = 0, peak = 0;
    const { d } = deps({ assign: async () => { live++; peak = Math.max(peak, live); await Bun.sleep(5); live--; return { ok: true }; } });
    await B.runBulk(d, Array.from({ length: 12 }, (_, i) => `ORBIT-${3000 + i}`), { kind: "assignee", value: "acct-1" });
    expect(peak).toBe(4);
  });
  test("a labels change with no label says so", async () => {
    const { d } = deps();
    const r = await B.runBulk(d, KEYS.slice(0, 1), { kind: "labels" });
    expect(r.results[0].error).toContain("label");
  });
});
