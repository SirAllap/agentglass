// Who may run a clean: a person does, an agent only through a card the person
// approves, and the person-set auto mode without one.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CleanupError, planCleanup, runCleanupGated, type CleanupAsk, type CleanupGate } from "../src/cleanup.ts";
import { parseCleanupCard } from "../../shared/cleanupCard.ts";
import { BRANCH, PR, makeWorld, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());

/** A door that keeps the card instead of showing it: `approve()` is the person's click. */
function fakeDoor() {
  const cards: Parameters<CleanupAsk>[0][] = [];
  const ask: CleanupAsk = (card) => { cards.push(card); return { ok: true, cardId: `sr_${cards.length}` }; };
  return { cards, ask, approve: async (i = 0) => cards[i]!.apply() };
}
const agent = (ask: CleanupAsk): CleanupGate => ({ caller: "agent", who: "an agent calling itself \"orbit-worker\"", repoLabel: "acme/orbit", ask });
const never: CleanupAsk = () => { throw new Error("a card was raised"); };

describe("runCleanupGated", () => {
  test("an agent without approval gets a pending card and nothing is touched; the person's approval then runs it", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx(), id = (await planCleanup(w.main, PR, cfg, c)).id;
    const door = fakeDoor();
    const r = await runCleanupGated(w.main, PR, cfg, c, { planId: id }, agent(door.ask));
    expect(r).toEqual({ kind: "approval", cardId: "sr_1", planId: id });
    expect(existsSync(w.wt)).toBe(true);
    expect(w.git(w.main, "branch", "--list", BRANCH)).not.toBe("");
    expect(w.calls.filter((x) => x.startsWith("docker") && /\b(rm|rmi|stop)\b/.test(x))).toEqual([]);
    expect(door.cards[0]!.diff.join("\n")).toContain(`worktree: ${w.wt}`);
    // the window reads the same lines back: the totals of the whole plan, and no bookkeeping row among the items
    const card = parseCleanupCard(door.cards[0]!.diff)!;
    expect(card).toMatchObject({ pr: PR, repo: "acme/orbit", mergedAt: expect.any(Number) });
    expect(card.itemCount).toBe(card.items.length);
    expect(card.items.some((i) => i.kind === "own-state")).toBe(false);
    expect(card.items.find((i) => i.kind === "worktree")).toMatchObject({ group: "worktree", target: w.wt });

    expect(await door.approve()).toEqual({ ok: true });
    expect(existsSync(w.wt)).toBe(false);
    expect(w.git(w.main, "branch", "--list", BRANCH)).toBe("");
  });

  test("an agent's stale plan id, a blocked tree and an unconfirmed closed-unmerged PR are refused before any card", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx(), id = (await planCleanup(w.main, PR, cfg, c)).id;
    await expect(runCleanupGated(w.main, PR, cfg, c, { planId: "0".repeat(64) }, agent(never))).rejects.toThrow(/state changed/);
    await Bun.write(`${w.wt}/dirty.txt`, "x");
    const blocked = await planCleanup(w.main, PR, cfg, c);
    await expect(runCleanupGated(w.main, PR, cfg, c, { planId: blocked.id }, agent(never))).rejects.toThrow(/refused/);
    expect(id).not.toBe(blocked.id);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a closed-unmerged PR needs confirmNotMerged before an agent gets a card", async () => {
    w = makeWorld();
    w.pr = { ...w.pr, state: "CLOSED", mergedAt: null, mergeCommit: null };
    const cfg = w.cfg(), c = w.ctx(), id = (await planCleanup(w.main, PR, cfg, c)).id;
    await expect(runCleanupGated(w.main, PR, cfg, c, { planId: id }, agent(never))).rejects.toThrow(/confirmNotMerged/);
    const door = fakeDoor();
    expect((await runCleanupGated(w.main, PR, cfg, c, { planId: id, confirmNotMerged: true }, agent(door.ask))).kind).toBe("approval");
  });

  test("a card that cannot be raised (the door is full) is the answer, and nothing runs", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx(), id = (await planCleanup(w.main, PR, cfg, c)).id;
    const full: CleanupAsk = () => ({ ok: false, error: "30 requests are already waiting for the person", status: 429 });
    const e = await runCleanupGated(w.main, PR, cfg, c, { planId: id }, agent(full)).catch((x) => x);
    expect(e).toBeInstanceOf(CleanupError);
    expect((e as CleanupError).status).toBe(429);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("the approval re-checks the tree: a change after the card was raised is refused when approved", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx(), id = (await planCleanup(w.main, PR, cfg, c)).id;
    const door = fakeDoor();
    await runCleanupGated(w.main, PR, cfg, c, { planId: id }, agent(door.ask));
    await Bun.write(`${w.wt}/late.txt`, "x");
    const a = await door.approve();
    expect(a.ok).toBe(false);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a person runs it directly, no card", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx(), id = (await planCleanup(w.main, PR, cfg, c)).id;
    const r = await runCleanupGated(w.main, PR, cfg, c, { planId: id }, { caller: "person", who: "the person", ask: never });
    expect(r.kind).toBe("ran");
    expect(existsSync(w.wt)).toBe(false);
  });

  test("the auto path runs without a card when the person's mode says auto and the plan is clean", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx();
    const r = await runCleanupGated(w.main, PR, cfg, c, { planId: "" }, { caller: "auto", who: "auto", ask: never, auto: { mode: "auto", autoCleanDays: 0, mergedAt: null } });
    expect(r.kind).toBe("ran");
    expect(existsSync(w.wt)).toBe(false);
  });

  test("the auto path refuses when the mode is not auto, when it was not asked for, or when the tree is blocked", async () => {
    w = makeWorld();
    const cfg = w.cfg(), c = w.ctx();
    for (const mode of ["off", "ask", "atMerge"] as const) {
      await expect(runCleanupGated(w.main, PR, cfg, c, { planId: "" }, { caller: "auto", who: "auto", ask: never, auto: { mode, autoCleanDays: 0, mergedAt: null } })).rejects.toBeInstanceOf(CleanupError);
    }
    await expect(runCleanupGated(w.main, PR, cfg, c, { planId: "" }, { caller: "auto", who: "auto", ask: never })).rejects.toThrow(/not asked for/);
    await Bun.write(`${w.wt}/dirty.txt`, "x");
    await expect(runCleanupGated(w.main, PR, cfg, c, { planId: "" }, { caller: "auto", who: "auto", ask: never, auto: { mode: "auto", autoCleanDays: 0, mergedAt: null } })).rejects.toBeInstanceOf(CleanupError);
    expect(existsSync(w.wt)).toBe(true);
  });
});
