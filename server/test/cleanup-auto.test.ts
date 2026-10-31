// The automatic cleanup after a merge: it cleans what is clean, leaves a blocked
// pull request alone with its reason, never runs one twice, and costs nothing
// for a project whose setting does not ask for it. Docker, tmux and gh are the
// fixture's fakes; git is real, in a temporary repository.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { EMPTY_CLEANUP_CONFIG, type CleanupMode } from "../src/cleanup.ts";
import { claimAuto, markInterrupted } from "../src/cleanupState.ts";
import { __resetSweeps, cleanMerged, onPrsGone, sweepOld, waitingAuto, type AutoDeps } from "../src/cleanupAuto.ts";
import { autoRow, autoRows } from "../src/cleanupState.ts";
import { db } from "../src/db.ts";
import { PR, makeWorld, type World } from "./cleanupFixture.ts";

let w: World;
beforeEach(() => { db.exec("DELETE FROM cleanup_auto"); __resetSweeps(); });
afterEach(() => w?.cleanup());

function deps(mode: CleanupMode, days = 0, over: Partial<AutoDeps> = {}): AutoDeps & { told: number } {
  const d = {
    told: 0,
    ctx: () => w.ctx(),
    settings: () => ({ mode, days, config: w.cfg() }),
    roots: async () => [w.main],
    label: async () => "acme/orbit",
    changed: () => { d.told++; },
    ...over,
  };
  return d;
}

describe("automatic cleanup", () => {
  test("auto: a merged, unblocked pull request is cleaned in the background, once", async () => {
    w = makeWorld();
    const d = deps("auto");
    expect(await cleanMerged(d, w.main, PR)).toBe("cleaned");
    expect(existsSync(w.wt)).toBe(false);
    const row = autoRow(w.main, PR)!;
    expect(row).toMatchObject({ state: "cleaned", label: "acme/orbit", slug: "ORBIT-1042", reason: "" });
    expect(row.total).toBeGreaterThan(0);
    expect(d.told).toBeGreaterThanOrEqual(2); // claimed, then finished (and every item between)
    // the same pull request again: no plan, no gh, nothing
    const before = w.calls.length;
    expect(await cleanMerged(d, w.main, PR)).toBe("skipped");
    expect(w.calls.length).toBe(before);
  });

  test("auto: a blocked pull request is left alone and the reason is kept; asked again only after an hour", async () => {
    w = makeWorld();
    await Bun.write(`${w.wt}/dirty.txt`, "x");
    const d = deps("auto");
    expect(await cleanMerged(d, w.main, PR)).toBe("blocked");
    expect(existsSync(w.wt)).toBe(true);
    const row = autoRow(w.main, PR)!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toMatch(/uncommitted|dirty|changes/i);
    expect(autoRows(5).map((r) => r.state)).toEqual(["blocked"]);
    // inside the hour: not planned again
    const before = w.calls.length;
    expect(await cleanMerged(d, w.main, PR)).toBe("skipped");
    expect(w.calls.length).toBe(before);
    // two hours on and the block is gone: cleaned
    await Bun.spawn(["rm", `${w.wt}/dirty.txt`]).exited;
    const later = deps("auto", 0, { ctx: () => w.ctx({ now: w.ctx().now + 2 * 3_600_000 }) });
    expect(await cleanMerged(later, w.main, PR)).toBe("cleaned");
    expect(existsSync(w.wt)).toBe(false);
  });

  test("a project that never cleans on its own costs no gh, docker or tmux call", async () => {
    w = makeWorld();
    for (const mode of ["off", "ask", "atMerge"] as const) await onPrsGone(deps(mode, 0), "acme/orbit", [PR]);
    expect(w.calls).toEqual([]);
    expect(autoRows(5)).toEqual([]);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("the pull requests not started yet are counted for the window, and the count returns to zero", async () => {
    w = makeWorld();
    const seen: number[] = [];
    await onPrsGone(deps("auto", 0, { changed: () => { seen.push(waitingAuto()); } }), "acme/orbit", [PR, PR + 1, PR + 2]);
    expect(seen.filter((n, i) => n !== seen[i - 1])).toEqual([3, 2, 1, 0]);
    expect(waitingAuto()).toBe(0);
  });

  test("ask with autoCleanDays: only a pull request merged at least that many days ago is cleaned", async () => {
    w = makeWorld(); // merged 28 days before the fixture's clock
    const young = deps("ask", 30);
    await onPrsGone(young, "acme/orbit", [PR]);
    expect(existsSync(w.wt)).toBe(true);
    expect(autoRow(w.main, PR)).toBeNull();
    const old = deps("ask", 14);
    await onPrsGone(old, "acme/orbit", [PR]);
    expect(existsSync(w.wt)).toBe(false);
    expect(autoRow(w.main, PR)!.state).toBe("cleaned");
  });

  test("a pull request closed without a merge, or still open, is never touched", async () => {
    w = makeWorld();
    for (const state of ["CLOSED", "OPEN"]) {
      w.pr = { ...w.pr, state, mergedAt: null, mergeCommit: null };
      expect(await cleanMerged(deps("auto"), w.main, PR)).toBe("skipped");
    }
    expect(existsSync(w.wt)).toBe(true);
    expect(autoRows(5)).toEqual([]);
  });

  test("a merged pull request with nothing to clean is recorded as nothing and never shown or planned again", async () => {
    w = makeWorld();
    const d = deps("auto", 0, { settings: () => ({ mode: "auto", days: 0, config: { ...EMPTY_CLEANUP_CONFIG, include: [] } }) });
    expect(await cleanMerged(d, w.main, PR)).toBe("nothing");
    expect(autoRow(w.main, PR)!.state).toBe("nothing");
    expect(existsSync(w.wt)).toBe(true);
    const before = w.calls.length;
    expect(await cleanMerged(d, w.main, PR)).toBe("skipped");
    expect(w.calls.length).toBe(before);
  });

  test("the age rule asks GitHub for the newest merged ones once an hour and cleans only the old", async () => {
    w = makeWorld(); // PR is #77, merged 28 days ago
    const gh = async (args: string[]) => {
      w.calls.push(`gh ${args.join(" ")}`);
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify([{ number: PR, mergedAt: "2026-10-01T10:00:00Z" }, { number: 90, mergedAt: "2026-10-28T10:00:00Z" }]), stderr: "" };
      return w.ctx().gh(args);
    };
    const d = deps("ask", 14, { ctx: () => w.ctx({ gh }) });
    expect(await sweepOld(d, w.main)).toBe(1);
    expect(existsSync(w.wt)).toBe(false);
    expect(autoRow(w.main, 90)).toBeNull(); // 1 day old: never planned
    const lists = () => w.calls.filter((c) => c.startsWith("gh pr list --state merged")).length;
    expect(lists()).toBe(1);
    await sweepOld(d, w.main);
    expect(lists()).toBe(1); // inside the hour
    expect(await sweepOld(deps("ask", 0, { ctx: () => w.ctx({ gh }) }), "/elsewhere")).toBe(0); // days 0: off
  });

  test("Automatic also sweeps merged ones nobody saw leave the open list, but only those merged in the last day; days 0 stays off for the other modes", async () => {
    w = makeWorld(); // PR is #77
    const gh = async (args: string[]) => {
      w.calls.push(`gh ${args.join(" ")}`);
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify([{ number: PR, mergedAt: new Date(w.ctx().now - 3600_000).toISOString() }]), stderr: "" };
      return w.ctx().gh(args);
    };
    expect(await sweepOld(deps("ask", 0, { ctx: () => w.ctx({ gh }) }), w.main)).toBe(0);
    __resetSweeps();
    expect(await sweepOld(deps("auto", 0, { ctx: () => w.ctx({ gh }) }), w.main)).toBe(1);
    expect(existsSync(w.wt)).toBe(false);
    // merged 3 days ago, age rule off: not Automatic's catch-up, left alone
    w = makeWorld(); __resetSweeps();
    const old = async (args: string[]) => (args[1] === "list" ? { code: 0, stdout: JSON.stringify([{ number: PR, mergedAt: new Date(w.ctx().now - 3 * 86_400_000).toISOString() }]), stderr: "" } : w.ctx().gh(args));
    expect(await sweepOld(deps("auto", 0, { ctx: () => w.ctx({ gh: old }) }), w.main)).toBe(0);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a run the app closed in the middle of is resumed by the next sweep, not left cleaning for ever", async () => {
    w = makeWorld();
    expect(claimAuto({ repo: w.main, pr: PR, label: "acme/orbit", slug: "ORBIT-1042", title: "t", total: 3, now: w.ctx().now })).toBe(true);
    expect(autoRow(w.main, PR)!.state).toBe("cleaning");
    markInterrupted(); // what the next boot does
    expect(autoRow(w.main, PR)!.state).toBe("blocked");
    await onPrsGone(deps("auto", 0), "acme/orbit", []);
    expect(autoRow(w.main, PR)!.state).toBe("cleaned");
    expect(existsSync(w.wt)).toBe(false);
  });

  test("a failing step is recorded as failed with its reason and is not retried by itself", async () => {
    w = makeWorld();
    w.denyWorktreeRemove = true;
    // the root-owned fallback (docker run ... rm) fails too, so the worktree step really fails
    const base = w.ctx().run;
    const d = deps("auto", 0, { ctx: () => w.ctx({ run: async (cmd, args, o) => (cmd === "docker" && args[0] === "run" ? { code: 1, stdout: "", stderr: "denied" } : base(cmd, args, o)) }) });
    const out = await cleanMerged(d, w.main, PR);
    expect(out).toBe("failed");
    expect(autoRow(w.main, PR)!.state).toBe("failed");
    expect(await cleanMerged(d, w.main, PR)).toBe("skipped");
  });
});

describe("which pull requests the list stopped showing", () => {
  test("only a complete open page counts", async () => {
    const { prsGone } = await import("../src/prs.ts");
    const rows = [{ number: 2 }, { number: 3 }];
    expect(prsGone("open", false, [1, 2, 3], rows)).toEqual([1]);
    expect(prsGone("open", true, [1, 2, 3], rows)).toEqual([]);
    expect(prsGone("closed", false, [1, 2, 3], rows)).toEqual([]);
    expect(prsGone("open", false, [], rows)).toEqual([]);
  });
});
