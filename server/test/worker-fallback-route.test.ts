/*
 * A worker whose engine fails, end to end: a booted server, fake engines, a
 * real seat. The one rule that matters most: the next engine in the chain is
 * tried only when the FIRST turn failed before it did anything. A failure
 * after work started is the seat's to decide, because a second engine would
 * edit on top of a half-done first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { nights, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
let n = 0;
const nm = (p: string) => `${p}-${++n}`;
const CHAIN = [{ engine: "opencode", model: "opencode/big-pickle" }, { engine: "claude", model: "claude-sonnet-5-5" }];

beforeAll(async () => { if (have) h = await startHarness("wfall"); }, SERVER_BOOT_MS);
afterEach(() => { if (have) { h.mode("opencode", null); h.mode("claude", null); h.slow(false); } });
afterAll(async () => { if (have) await h.stop(); });

const withChain = async (limits: { maxWorkers?: number; maxRetries?: number } = {}) => {
  await h.usePolicy({ rules: [nights(CHAIN)], limits });
  await h.ruleOn(true);
};
const startBuilder = (name: string) => h.asSeat("/agents/named/start", { name, cwd: h.wt, role: "builder", prompt: "say done" });
const db = <T,>(q: string, args: (string | number)[] = []): T[] => {
  const d = new Database(join(h.dir, "w.db"), { readonly: true });
  try { return d.query(q).all(...args) as T[]; } finally { d.close(); }
};
const reportsFrom = (name: string) => db<{ blocked: string; need: string }>("SELECT blocked, need FROM seat_report WHERE agent = ?", [name]);
const needs = () => db<{ text: string }>("SELECT text FROM seat_need WHERE root = ?", [h.dir]).map((r) => r.text);
const switches = (name: string) => h.actions().then((a) => a.filter((x) => x.action === "worker/switch" && (x.detail ?? "").includes(name)));
const claudeTurns = () => ({ length: h.ran("claude") });
const opencodeTurns = () => ({ length: h.ran("opencode") });
/** The row once its CURRENT engine has finished a turn. */
const settledOn = (name: string, engine: string) => h.until(async () => {
  const r = await h.row(name);
  return r?.startedBy?.engine === engine && r.exitCode !== undefined ? r : undefined;
});

describe.skipIf(!have)("a worker whose engine fails", () => {
  test("a first turn that was rate-limited starts the next engine in the chain, once, and logs the switch", async () => {
    await withChain();
    h.mode("opencode", "limit");
    const name = nm("w-limit");
    const before = { oc: opencodeTurns().length, cl: claudeTurns().length };
    expect((await startBuilder(name)).ok).toBe(true);

    const row = await settledOn(name, "claude");
    expect(row.exitCode).toBe(0);
    expect(row.startedBy).toMatchObject({ engine: "claude", from: "opencode", retries: 1 });
    expect(opencodeTurns().length - before.oc).toBe(1);
    expect(claudeTurns().length - before.cl).toBe(1);
    // The prompt went along: the second engine was asked the same thing.
    const sw = await switches(name);
    expect(sw).toHaveLength(1);
    expect(sw[0]!.detail).toMatch(/opencode.*claude.*rate limit/i);
    // A switch that worked is not news for the seat.
    expect(reportsFrom(name)).toEqual([]);
    expect(needs().filter((t) => t.includes(name))).toEqual([]);
  }, 40_000);

  test("a second failure stops there and raises a need for the person", async () => {
    await withChain();
    h.mode("opencode", "limit");
    h.mode("claude", "limit");
    const name = nm("w-both");
    const before = { oc: opencodeTurns().length, cl: claudeTurns().length };
    expect((await startBuilder(name)).ok).toBe(true);

    await h.until(async () => needs().some((t) => t.includes(name)) || undefined);
    const row = await settledOn(name, "claude");
    expect(row.exitCode).not.toBe(0);
    expect(opencodeTurns().length - before.oc).toBe(1);
    expect(claudeTurns().length - before.cl).toBe(1);
    expect((await switches(name))).toHaveLength(1);
    expect(needs().find((t) => t.includes(name))).toMatch(/rate limit/i);
    expect(reportsFrom(name)).toHaveLength(1);
  }, 40_000);

  test("a failure after work started is NOT retried: the seat decides", async () => {
    await withChain();
    h.mode("opencode", "work");
    const name = nm("w-half");
    const before = claudeTurns().length;
    expect((await startBuilder(name)).ok).toBe(true);

    const row = await h.exited(name);
    expect(row.exitCode).toBe(1);
    await h.until(async () => reportsFrom(name).length > 0 || undefined);
    await Bun.sleep(1500);
    expect(claudeTurns().length - before).toBe(0);
    expect(await switches(name)).toEqual([]);
    expect(reportsFrom(name)).toHaveLength(1);
    expect((await h.row(name))?.startedBy?.engine).toBe("opencode");
  }, 40_000);

  test("a LATER turn that is rate-limited before it does anything stays where it is: the turns before it did work", async () => {
    await withChain();
    const name = nm("w-second");
    expect((await startBuilder(name)).ok).toBe(true);
    expect((await h.exited(name)).exitCode).toBe(0);
    expect((await h.row(name))?.startedBy?.turn).toBe(1);

    // The second turn's output files start empty, exactly like a first turn's.
    h.mode("opencode", "limit");
    const before = claudeTurns().length;
    const next = await h.asSeat("/agents/named/prompt", { name, text: "now the second part" });
    expect(next.ok).toBe(true);
    const row = await h.until(async () => { const r = await h.row(name); return r?.startedBy?.turn === 2 && r.exitCode !== undefined ? r : undefined; });
    expect(row.exitCode).toBe(1);
    await h.until(async () => reportsFrom(name).length > 0 || undefined);
    await Bun.sleep(1500);
    expect(claudeTurns().length - before).toBe(0);
    expect(await switches(name)).toEqual([]);
    expect((await h.row(name))?.startedBy?.engine).toBe("opencode");
    expect(reportsFrom(name)).toHaveLength(1);
    expect(reportsFrom(name)[0]!.blocked).toMatch(/later turn/);
    // The seat decides; the person is not asked for an engine nobody ran out of.
    expect(needs().filter((t) => t.includes(name))).toEqual([]);
  }, 40_000);

  test("maxRetries 0 means no switch, and the chain running out is a need", async () => {
    await withChain({ maxRetries: 0 });
    h.mode("opencode", "limit");
    const name = nm("w-none");
    const before = claudeTurns().length;
    expect((await startBuilder(name)).ok).toBe(true);
    await h.exited(name);
    await h.until(async () => needs().some((t) => t.includes(name)) || undefined);
    await Bun.sleep(1000);
    expect(claudeTurns().length - before).toBe(0);
  }, 40_000);

  test("a worker that was stopped with a status of its own carries the turn limit it started under", async () => {
    await withChain();
    const name = nm("w-stamp");
    expect((await startBuilder(name)).ok).toBe(true);
    expect((await h.row(name))?.startedBy?.turnMinutes).toBe(30);
    await h.exited(name);
  }, 40_000);

  test("a chair with no engine left is told to the person once, however many workers fail behind it", async () => {
    // The chair's chain names an engine this machine does not have.
    await h.usePolicy({ rules: [{ ...nights(CHAIN), orchestrator: [{ engine: "codex", model: "gpt-orbit" }] }], limits: { maxRetries: 0 } });
    await h.ruleOn(true);
    h.mode("opencode", "limit");
    const seen = async () => (await h.actions()).filter((a) => a.action === "chair/no-plan").length;
    const before = await seen();
    const [a, b] = [nm("w-chair"), nm("w-chair")];
    for (const x of [a, b]) { expect((await startBuilder(x)).ok).toBe(true); await h.exited(x); }
    await h.until(async () => (await seen()) > before || undefined);
    await Bun.sleep(1000);
    expect((await seen()) - before).toBe(1);

    // The person gives the chair an engine this machine has: the card comes down then, not at the next failure.
    const back = async () => (await h.actions()).filter((a) => a.action === "chair/plan-back").length;
    const was = await back();
    await h.usePolicy({ rules: [nights(CHAIN)], limits: { maxRetries: 0 } });
    await h.until(async () => (await back()) > was || undefined);
    expect((await back()) - was).toBe(1);
  }, 40_000);

  test("the fourth worker of three is refused", async () => {
    await withChain({ maxWorkers: 3 });
    h.slow(true);
    const names = [nm("w-cap"), nm("w-cap"), nm("w-cap")];
    for (const x of names) expect((await startBuilder(x)).ok, x).toBe(true);
    const fourth = nm("w-cap");
    const r = await startBuilder(fourth);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("limit is 3");
    expect(await h.row(fourth)).toBeUndefined();
    for (const x of names) await h.asSeat("/agents/named/stop", { name: x });
  }, 40_000);
});
