// "After merge, the card moves too": the `card-move` plan step, carried like
// `own-state`/`worklog` (no tick of its own), on the same real-git fixture the
// other cleanup engine tests use.
import { afterEach, describe, expect, test } from "bun:test";
import { planCleanup, runCleanup } from "../src/cleanup.ts";
import { PR, SLUG, makeWorld, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());

describe("card-move", () => {
  test("off by default: no item, whatever else is configured", async () => {
    w = makeWorld();
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    expect(plan.items.some((i) => i.kind === "card-move")).toBe(false);
  });

  test("on with no status configured: still no item", async () => {
    w = makeWorld();
    const plan = await planCleanup(w.main, PR, w.cfg({ moveCard: true }), w.ctx());
    expect(plan.items.some((i) => i.kind === "card-move")).toBe(false);
  });

  test("on and a status: one item, naming the card and the destination status", async () => {
    w = makeWorld();
    const cfg = w.cfg({ moveCard: true, moveCardStatus: "Done" });
    const plan = await planCleanup(w.main, PR, cfg, w.ctx());
    const it = plan.items.find((i) => i.kind === "card-move");
    expect(it).toBeTruthy();
    expect(it!.target).toBe(SLUG);
    expect(it!.detail).toBe(`move ${SLUG} to Done`);
  });

  test("a branch with no card id prefix: no item, even when configured on", async () => {
    w = makeWorld({ branch: "fix-the-thing" });
    const cfg = w.cfg({ moveCard: true, moveCardStatus: "Done" });
    const plan = await planCleanup(w.main, PR, cfg, w.ctx());
    expect(plan.items.some((i) => i.kind === "card-move")).toBe(false);
  });

  test("a run calls the injected mover with the card and the status, and reports what it said", async () => {
    w = makeWorld();
    const cfg = w.cfg({ moveCard: true, moveCardStatus: "Done" });
    const calls: { key: string; status: string }[] = [];
    const ctx = w.ctx({ moveCard: async (key, status) => { calls.push({ key, status }); return { ok: true, detail: "moved to Done" }; } });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(calls).toEqual([{ key: SLUG, status: "Done" }]);
    const row = rep.items.find((i) => i.kind === "card-move");
    expect(row).toEqual({ id: `card-move:${SLUG}`, kind: "card-move", target: SLUG, status: "done", detail: "moved to Done" });
    expect(rep.ok).toBe(true);
  });

  test("the mover failing does not fail the rest of the plan", async () => {
    w = makeWorld();
    const cfg = w.cfg({ moveCard: true, moveCardStatus: "Done" });
    const ctx = w.ctx({ moveCard: async () => ({ ok: false, detail: "no free move to Done from In Review" }) });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    const row = rep.items.find((i) => i.kind === "card-move")!;
    expect(row.status).toBe("failed");
    expect(row.detail).toBe("no free move to Done from In Review");
    expect(rep.items.some((i) => i.kind === "worktree" && i.status === "done")).toBe(true);
  });

  test("no mover wired: the item fails instead of silently doing nothing", async () => {
    w = makeWorld();
    const cfg = w.cfg({ moveCard: true, moveCardStatus: "Done" });
    const ctx = w.ctx({ moveCard: undefined });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    const row = rep.items.find((i) => i.kind === "card-move")!;
    expect(row.status).toBe("failed");
    expect(row.detail).toBe("no tracker is wired to move cards");
  });
});
