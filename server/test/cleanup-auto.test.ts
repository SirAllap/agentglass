// The automatic cleanup after a merge: it cleans what is clean, leaves a blocked
// pull request alone with its reason, never runs one twice, and costs nothing
// for a project whose setting does not ask for it. Docker, tmux and gh are the
// fixture's fakes; git is real, in a temporary repository.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_CLEANUP_CONFIG, type CleanupMode } from "../src/cleanup.ts";
import { claimAuto, markInterrupted } from "../src/cleanupState.ts";
import { __resetSweeps, cleanMerged, onPrsGone, sweepOld, sweepSkipReason, waitingAuto, type AutoDeps } from "../src/cleanupAuto.ts";
import { autoRow, autoRows } from "../src/cleanupState.ts";
import { db } from "../src/db.ts";
import { PR, fakeProcess, makeWorld, type World } from "./cleanupFixture.ts";

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

  test("auto: gh cannot read the pull request: the reason is kept for the panel and it is asked again after the hour", async () => {
    w = makeWorld();
    const real = w.ctx();
    const broken = { ...real, gh: async () => ({ code: 1, stdout: "", stderr: "gh: To get started with GitHub CLI, please run: gh auth login\n" }) };
    expect(await cleanMerged(deps("auto", 0, { ctx: () => broken }), w.main, PR)).toBe("blocked");
    expect(existsSync(w.wt)).toBe(true);
    expect(autoRow(w.main, PR)).toMatchObject({ state: "blocked", waiting: 1 });
    expect(autoRow(w.main, PR)!.reason).toMatch(/gh could not read pull request/);
    const later = deps("auto", 0, { ctx: () => w.ctx({ now: real.now + 2 * 3_600_000 }) });
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

  test("the age sweep that gh cannot feed says why it skipped, token removed, and clears on a good read", async () => {
    w = makeWorld();
    let bad = true;
    const gh = async (args: string[]) => (args[1] === "list" && bad ? { code: 1, stdout: "", stderr: "HTTP 401 Bearer ghp_SECRET123\nmore" } : w.ctx().gh(args));
    const d = deps("ask", 14, { ctx: () => w.ctx({ gh }) });
    expect(await sweepOld(d, w.main)).toBe(0);
    const why = sweepSkipReason(w.main)!;
    expect(why).toMatch(/age sweep skipped: gh could not list the merged pull requests \(HTTP 401/);
    expect(why).not.toMatch(/SECRET|more/);
    bad = false;
    const later = deps("ask", 14, { ctx: () => w.ctx({ gh, now: w.ctx().now + 2 * 3_600_000 }) });
    await sweepOld(later, w.main);
    expect(sweepSkipReason(w.main)).toBeNull();
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

  test("a pull request blocked only by a live session is cleaned by the next read once the tab is gone", async () => {
    w = makeWorld();
    fakeProcess(w, 4242, w.wt);
    const d = deps("auto");
    expect(await cleanMerged(d, w.main, PR)).toBe("blocked");
    expect(existsSync(w.wt)).toBe(true);
    const row = autoRow(w.main, PR)!;
    expect(row.state).toBe("blocked");
    expect(row.waiting).toBe(1);
    expect(row.reason).toMatch(/running in this card's checkout or tab/);

    // Inside the hour no read asks again: nothing is planned, nothing moves.
    const views = () => w.calls.filter((c) => c.startsWith("gh pr view")).length;
    expect(views()).toBe(1);
    await onPrsGone(deps("auto", 0, { ctx: () => w.ctx({ now: w.ctx().now + 1_800_000 }) }), "acme/orbit", []);
    expect(views()).toBe(1);
    expect(existsSync(w.wt)).toBe(true);

    // The hour is up and the tab is still there: one re-plan, and it is asked no more often than that.
    const before = w.calls.length;
    await onPrsGone(deps("auto", 0, { ctx: () => w.ctx({ now: w.ctx().now + 2 * 3_600_000 }) }), "acme/orbit", []);
    expect(existsSync(w.wt)).toBe(true);
    expect(autoRow(w.main, PR)!.state).toBe("blocked");
    // Measured: one retry that still finds the tab is two gh (the view and the open list), three docker (ps, images,
    // volume ls) and one tmux (list-panes), plus the git reads the plan makes. The sweep's own gh is not the retry's.
    const retry = w.calls.slice(before).filter((c) => !c.startsWith("gh pr list --state merged"));
    expect(retry.length).toBe(6);
    expect(retry.filter((c) => c.startsWith("gh ")).length).toBe(2);

    // The tab closes, and the next read (an hour on) cleans it on its own.
    rmSync(join(w.procDir, "4242"), { recursive: true, force: true });
    await onPrsGone(deps("auto", 0, { ctx: () => w.ctx({ now: w.ctx().now + 4 * 3_600_000 }) }), "acme/orbit", []);
    expect(existsSync(w.wt)).toBe(false);
    expect(autoRow(w.main, PR)!.state).toBe("cleaned");
  });

  test("a waiting row whose tab closed but is still too recent stops waiting, so later reads do not plan it again", async () => {
    w = makeWorld();
    fakeProcess(w, 4242, w.wt);
    // Merged 28 days before the fixture's clock; the age rule asks for 60.
    expect(await cleanMerged(deps("atMerge", 60), w.main, PR)).toBe("blocked");
    expect(autoRow(w.main, PR)!.waiting).toBe(1);
    rmSync(join(w.procDir, "4242"), { recursive: true, force: true });
    await onPrsGone(deps("atMerge", 60, { ctx: () => w.ctx({ now: w.ctx().now + 2 * 3_600_000 }) }), "acme/orbit", []);
    expect(autoRow(w.main, PR)!.waiting).toBe(0);
    const views = () => w.calls.filter((c) => c.startsWith("gh pr view")).length;
    const seen = views();
    for (const hours of [4, 8]) {
      await onPrsGone(deps("atMerge", 60, { ctx: () => w.ctx({ now: w.ctx().now + hours * 3_600_000 }) }), "acme/orbit", []);
    }
    expect(views()).toBe(seen);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a pull request blocked for any other reason is never retried by a later read", async () => {
    w = makeWorld();
    await Bun.write(`${w.wt}/dirty.txt`, "x");
    const d = deps("auto");
    expect(await cleanMerged(d, w.main, PR)).toBe("blocked");
    expect(autoRow(w.main, PR)!.waiting).toBe(0);
    // The dirty file is gone, so only the hour and the read stand in the way of a retry: it must still not happen.
    await Bun.spawn(["rm", `${w.wt}/dirty.txt`]).exited;
    for (const hours of [2, 8]) {
      await onPrsGone(deps("auto", 0, { ctx: () => w.ctx({ now: w.ctx().now + hours * 3_600_000 }) }), "acme/orbit", []);
      expect(autoRow(w.main, PR)!.state).toBe("blocked");
      expect(existsSync(w.wt)).toBe(true);
    }
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
