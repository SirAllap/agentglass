/*
 * THE AUTOMATIC CLEANUP, the job behind the "Automatic" mode of "After a PR is
 * merged" (and the "older than N days" rule of the other modes).
 *
 * It owns no timer. The one thing that starts it is the PR list the app already
 * reads: a pull request that was open on the last read and is gone from this one
 * is asked about once (`onPrsGone`), and a merged one is cleaned in the
 * background with the same engine, the same plan id and the same safety blocks a
 * person's click goes through (cleanup.ts). A blocked pull request is left alone
 * and its reason is recorded for the badge; nothing is ever asked of the person.
 *
 * Everything outside the engine is injected (`AutoDeps`), so a test fakes docker,
 * gh and tmux through the context and uses real git in a temporary repository.
 * Runs go one at a time: a burst of merges is a queue, not a burst of docker calls.
 *
 * Ceilings, chosen and not missed:
 *  - a pull request merged while the app was not reading the list is seen only
 *    by the hourly sweep (Automatic: merged in the last day; every mode: the age rule,
 *    autoCleanDays > 0) or by a person's click;
 *  - a pull request blocked ONLY by a tab or session in its checkout is asked
 *    again by the app's own PR-list read (no timer), at most once an hour per
 *    pull request: measured, a retry that still finds the tab is two `gh`, three
 *    `docker` and one `tmux` call plus the git reads of a plan, and the reads in
 *    between cost a database query and nothing else. Any other block is never
 *    retried;
 *  - the sweep looks at the 30 newest merged pull requests of the repository
 *    that are the person's own, at most once an hour per repository;
 *  - a run that failed halfway is recorded as failed and not retried by itself.
 */
import {
  CleanupError, ghWhy, mainCheckout, planCleanup, runCleanupGated, shouldAutoClean,
  type CleanupConfig, type CleanupCtx, type CleanupMode,
} from "./cleanup.ts";
import { autoRow, claimAuto, finishAuto, interruptedPrs, noteBlocked, progressAuto, waitingPrs } from "./cleanupState.ts";

export interface AutoSettings { mode: CleanupMode; days: number; config: CleanupConfig }

export interface AutoDeps {
  ctx(): CleanupCtx;
  /** A project's cleanup settings, as the settings door stores them. */
  settings(main: string): AutoSettings;
  /** The checkouts this app knows that belong to a GitHub repository (`owner/name`). */
  roots(repoKey: string): Promise<string[]>;
  /** How the Lantern names the repository. */
  label(main: string): Promise<string>;
  /** Told whenever the Housekeeping list changed, so the window re-reads it. */
  changed(): void;
}

export type AutoOutcome = "skipped" | "cleaned" | "blocked" | "failed" | "nothing";

const no = (): never => { throw new Error("a card was raised for an automatic cleanup"); };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One at a time, in order. */
let tail: Promise<unknown> = Promise.resolve();
const inOrder = <T>(fn: () => Promise<T>): Promise<T> => { const r = tail.then(fn, fn); tail = r.catch(() => undefined); return r; };

/**
 * Pull requests asked about and not started yet. The queue itself is a promise
 * chain with nothing to count, and the window's progress chip wants "and 2
 * more", so each caller adds what it is about to ask and takes one off as that
 * one starts.
 */
let waiting = 0;
export const waitingAuto = (): number => waiting;
const startedOne = (d: AutoDeps): void => { waiting = Math.max(0, waiting - 1); d.changed(); };
/** One at a time in order, counting what has not started; a run that throws gives back what it never reached. */
async function eachQueued<T>(d: AutoDeps, items: T[], fn: (x: T) => Promise<unknown>, each?: (r: unknown) => void): Promise<void> {
  queuedMore(d, items.length);
  let started = 0;
  try {
    for (const x of items) {
      const r = await inOrder(() => { started++; startedOne(d); return fn(x); });
      each?.(r);
    }
  } finally {
    if (started < items.length) { waiting = Math.max(0, waiting - (items.length - started)); d.changed(); }
  }
}
const queuedMore = (d: AutoDeps, n: number): void => { if (n > 0) { waiting += n; d.changed(); } };

/** Whether this project's settings could ever clean without a click. Checked before any gh or git call. */
export const wantsAuto = (s: AutoSettings): boolean => s.mode === "auto" || (s.mode !== "off" && s.days > 0);

async function cleanOne(d: AutoDeps, main: string, pr: number): Promise<AutoOutcome> {
  const s = d.settings(main);
  if (!wantsAuto(s)) return "skipped";
  const prior = autoRow(main, pr);
  const c = d.ctx();
  if (prior && !(prior.state === "blocked" && c.now - prior.started_at >= HOUR_MS)) return "skipped";
  let plan;
  try { plan = await planCleanup(main, pr, s.config, c); } catch (e) {
    if (!(e instanceof CleanupError)) throw e;
    // gh could not answer (502): a merged PR's checkout stayed behind with no word why. Say why, and ask again after the hour.
    if (e.status === 502) { noteBlocked({ repo: main, pr, slug: "", title: `#${pr}`, label: await d.label(main), reason: e.message.split("\n")[0]!, waiting: true, now: c.now }); d.changed(); return "blocked"; }
    return "skipped";
  }
  const who = { repo: main, pr, slug: plan.slug ?? "", title: plan.title, label: await d.label(main) };
  const verdict = shouldAutoClean(s.mode, plan, plan.mergedAt, c.now, s.days);
  if (!verdict.clean) {
    if (plan.state !== "MERGED" || !plan.blocks.length) {
      // The tab closed but the run is still refused for another reason (too recent for the days setting): the row
      // stops waiting, or every PR-list read after its hour would plan it again.
      if (prior?.waiting) { noteBlocked({ ...who, reason: verdict.reason, waiting: false, now: c.now }); d.changed(); }
      return "skipped";
    }
    // The live-session block is the only one that clears on its own (a tab or session closes); uncommitted work,
    // unpushed commits and a stacked PR wait for a person. Marked so a later PR-list read asks again.
    const waiting = plan.blocks.length === 1 && plan.blocks[0]!.kind === "live-session";
    noteBlocked({ ...who, reason: verdict.reason, waiting, now: c.now });
    d.changed();
    return "blocked";
  }
  if (!claimAuto({ ...who, total: plan.items.length, now: c.now })) return "skipped";
  // The app's own bookkeeping rows are not leftovers: a plan of only those has nothing on this computer to clean.
  if (!plan.items.some((i) => i.kind !== "own-state" && i.kind !== "worklog")) { finishAuto(main, pr, { state: "nothing", now: c.now }); return "nothing"; }
  d.changed();
  try {
    const run = await runCleanupGated(main, pr, s.config, c, {
      planId: plan.id,
      onItem: (p) => { progressAuto(main, pr, p.done, p.total, p.bytes); d.changed(); },
    }, { caller: "auto", who: "automatic cleanup", ask: no, auto: { mode: s.mode, autoCleanDays: s.days, mergedAt: plan.mergedAt } });
    if (run.kind !== "ran") return "failed";
    const r = run.report;
    finishAuto(main, pr, { state: r.ok ? "cleaned" : "failed", reason: r.ok ? "" : r.summary, freed: r.freedBytes, report: r.items, now: c.now });
    d.changed();
    return r.ok ? "cleaned" : "failed";
  } catch (e) {
    finishAuto(main, pr, { state: "failed", reason: (e as Error).message, now: c.now });
    d.changed();
    return "failed";
  }
}

/** One pull request, by hand (the tests and the age rule use it); queued behind any run in progress. */
export const cleanMerged = (d: AutoDeps, repo: string, pr: number): Promise<AutoOutcome> =>
  inOrder(async () => {
    let main: string;
    try { main = await mainCheckout(repo, d.ctx()); } catch { return "skipped"; }
    return cleanOne(d, main, pr);
  });

const swept = new Map<string, number>();
/** Why the last age sweep of a repository did not run (gh failed); cleared by the next good read. */
const sweepSkips = new Map<string, string>();
export const sweepSkipReason = (main: string): string | null => sweepSkips.get(main) ?? null;
/** Only for tests: the hourly mark is process-wide. */
export const __resetSweeps = (): void => { swept.clear(); sweepSkips.clear(); };

/** Ceiling chosen: Automatic's catch-up covers what was merged in the last day (the gap it exists for: merged while the app was closed); anything between that and the age rule is left to a click. */
export const CATCH_UP_DAYS = 1;
const sweepWants = (s: AutoSettings, ageDays: number): boolean => (s.mode === "auto" && ageDays < CATCH_UP_DAYS) || (s.days > 0 && ageDays >= s.days);

/**
 * The age rule: this person's merged pull requests that are at least
 * `autoCleanDays` old. Asks GitHub once for the newest 30, at most once an
 * hour per repository, and only when the setting is on.
 */
export async function sweepOld(d: AutoDeps, main: string): Promise<number> {
  const s = d.settings(main);
  if (s.mode === "off" || (s.mode !== "auto" && !(s.days > 0))) return 0;
  const c = d.ctx();
  if (c.now - (swept.get(main) ?? 0) < HOUR_MS) return 0;
  swept.set(main, c.now);
  const r = await c.gh(["pr", "list", "--state", "merged", "--author", "@me", "--limit", "30", "--json", "number,mergedAt"], main).catch((e) => ({ code: -1, stdout: "", stderr: String((e as Error)?.message ?? e) }));
  if (r.code !== 0) {
    const why = `the age sweep skipped: gh could not list the merged pull requests (${ghWhy(r.stderr)}); asked again in an hour`;
    sweepSkips.set(main, why);
    console.warn(`[cleanup] ${main}: ${why}`);
    return 0;
  }
  sweepSkips.delete(main);
  let list: { number?: number; mergedAt?: string }[] = [];
  try { list = JSON.parse(r.stdout); } catch { return 0; }
  let n = 0;
  const wanted = list.filter((p) => {
    const at = Date.parse(String(p.mergedAt ?? ""));
    return Number.isInteger(p.number) && at > 0 && sweepWants(s, (c.now - at) / DAY_MS);
  });
  await eachQueued(d, wanted, (p) => cleanOne(d, main, p.number!), (r) => { if (r === "cleaned") n++; });
  return n;
}

/**
 * The PR list stopped showing these pull requests of `repoKey`. Each is asked
 * about once (gh, through the engine): the merged ones are cleaned when the
 * project's setting says so. A project whose settings never clean on their own
 * costs nothing here, not even a gh call.
 *
 * This is also the retry of a pull request waiting for its tab to close: the
 * read happens on every complete open page (prs.ts), so a waiting one is asked
 * again on the first read after its hour is up.
 */
export async function onPrsGone(d: AutoDeps, repoKey: string, numbers: number[]): Promise<void> {
  const mains = new Set<string>();
  const c = d.ctx();
  for (const root of await d.roots(repoKey).catch(() => [] as string[])) {
    let main: string;
    try { main = await mainCheckout(root, c); } catch { continue; }
    if (mains.has(main)) continue;
    mains.add(main);
    if (!wantsAuto(d.settings(main))) continue;
    const todo = [...new Set([...numbers, ...interruptedPrs(main), ...waitingPrs(main, c.now - HOUR_MS)])];
    await eachQueued(d, todo, (n) => cleanOne(d, main, n));
    await sweepOld(d, main);
  }
}
