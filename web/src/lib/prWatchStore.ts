/*
 * The notify watches, as the board and the detail see them: ONE datum, two
 * views. The server holds the rules (server/src/prNotifyWatch.ts) and sends the
 * whole small list after every change, so the bell on a card and the bell in
 * the detail's header are the same read and cannot disagree.
 */
import { useSyncExternalStore } from "react";
import type { PrCheck, PrChecksRead, PrWatch, PrWatchPreset, PrWatchRule, PrWatchState } from "../../../shared/types.ts";
import { api } from "./api.ts";

let state: PrWatchState = { watches: [], presets: [] };
let loaded = false;
const subs = new Set<() => void>();

export function setPrWatchState(next: PrWatchState): void {
  state = next;
  loaded = true;
  for (const fn of subs) fn();
}

/** Read the list again. Called on first use and whenever the socket (re)opens, so a first read that failed
 *  while the server was booting does not leave the bell showing "off" for a PR that is being watched. */
export function reloadPrWatches(): void {
  void api.prWatches().then((r) => { if (r?.ok) setPrWatchState({ watches: r.watches, presets: r.presets }); }).catch(() => {});
}

function load(): void {
  if (loaded) return;
  loaded = true;
  reloadPrWatches();
}

export function usePrWatchState(): PrWatchState {
  load();
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    () => state,
  );
}

const checkSubs = new Set<(r: PrChecksRead) => void>();
/** The server's watch read a pull request's checks (frame `prchecks`): whoever shows that pull request takes them. */
export function publishChecksRead(r: PrChecksRead): void { for (const fn of checkSubs) fn(r); }
export function onChecksRead(fn: (r: PrChecksRead) => void): () => void { checkSubs.add(fn); return () => { checkSubs.delete(fn); }; }

/** Is something already going to say this? The talk and ci notes step aside for a watch of the same kind on the
 *  same PR: one remark or one verdict is one notification, not two. */
export function hasActiveWatch(repo: string, number: number, types: PrWatchRule["type"][]): boolean {
  return state.watches.some((w) => w.repo === repo && w.number === number && w.active && types.includes(w.rule.type));
}

export const watchesOf = (s: PrWatchState, repo: string, number: number): PrWatch[] =>
  s.watches.filter((w) => w.repo === repo && w.number === number);

export const presetOf = (s: PrWatchState, repo: string): PrWatchPreset | undefined =>
  s.presets.find((p) => p.repo === repo);

export function ruleLabel(r: PrWatchRule): string {
  switch (r.type) {
    case "ci-pass": return r.ignore?.length ? `All CI passed, except ${r.ignore.length}` : "All CI passed";
    case "ci-fail": return "Any check fails (first one)";
    case "comment": return "New comment";
    case "check": return `Check ~${r.match} ${r.on === "fail" ? "fails" : r.on === "pass" ? "passes" : "fails or passes"}`;
  }
}

/** The checks "All CI passed" does not wait for, from this PR's CI watch: the one waiting, else the last that fired. */
export function ignoredOf(ws: PrWatch[]): string[] {
  const ci = ws.filter((w) => w.rule.type === "ci-pass");
  const w = ci.find((x) => x.active) ?? ci[0];
  return w?.rule.type === "ci-pass" ? w.rule.ignore ?? [] : [];
}

/** The ignore list after one chip is pressed: that name goes in, or comes out if it was in. */
export const toggleIgnored = (ignored: string[], name: string): string[] =>
  ignored.includes(name) ? ignored.filter((n) => n !== name) : [...ignored, name];

/** The chips shown up front: the checks that can hold "All CI passed" back right now (failed, running, cancelled),
 *  plus whatever is already ignored so it can be taken out again. */
export function ignorableNames(all: PrCheck[], ignored: string[]): string[] {
  const blocking = all.filter((c) => !c.done || c.cancelled || c.state === "failure").map((c) => c.name);
  return [...new Set([...blocking, ...ignored])].sort((a, b) => a.localeCompare(b));
}

/** The rest of the PR's check names, behind "+N more": a green check runs again on the next push, so it can be
 *  ignored ahead of time. Together with ignorableNames this is every name the PR has. */
export function moreIgnorableNames(all: PrCheck[], ignored: string[]): string[] {
  const shown = new Set(ignorableNames(all, ignored));
  return [...new Set(all.map((c) => c.name))].filter((n) => !shown.has(n)).sort((a, b) => a.localeCompare(b));
}

/** "All CI passed" as the person set it: the rule with its ignore list, or the bare rule when nothing is ignored. */
export const ciPassRule = (ignored: string[]): PrWatchRule => (ignored.length ? { type: "ci-pass", ignore: ignored } : { type: "ci-pass" });

export const sameRule = (a: PrWatchRule, b: PrWatchRule): boolean =>
  a.type === b.type && (a.type !== "check" || (b.type === "check" && a.match.toLowerCase() === b.match.toLowerCase() && a.on === b.on));

/**
 * What the bell says. Waiting beats fired: a PR with one rule spent and another
 * waiting is still being watched. A fired-only PR shows what happened last, so
 * the person who comes back sees "CI passed" rather than a bare bell.
 */
export function bellState(ws: PrWatch[], seenAt = 0, checksDone = true): { kind: "off" | "on" | "fired"; waiting: number; last?: PrWatch } {
  const waiting = ws.filter((w) => w.active).length;
  const last = ws.filter((w) => w.lastAt).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))[0];
  if (waiting) return { kind: "on", waiting, ...(last ? { last } : null) };
  // A fire says so until it has been looked at, then the button is a plain Notify again.
  /* "CI passed" is about a run. A new head or a re-run puts the checks back to pending, and the chip then
     says Notify again rather than sit green over a suite that is running. Ceiling: only "CI passed" is
     retired this way; a red fire stays until seen, because it fires on the first failure while the rest still run. */
  const superseded = !!last && last.rule.type === "ci-pass" && firedOk(last) && !checksDone;
  if (last && !superseded && (last.lastAt ?? 0) > seenAt) return { kind: "fired", waiting: 0, last };
  return { kind: "off", waiting: 0, ...(last ? { last } : null) };
}

const short = (sha: string | undefined): string => (sha ?? "").slice(0, 7);

/**
 * What the chip says about the run a CI watch is looking at. After an Update branch the old head's green is not
 * the answer, so the person is told the watch is waiting for the new one, and told in words when the update moved
 * nothing. Null when nothing is being watched or no head has been read yet.
 */
export function watchPhase(ws: PrWatch[]): { kind: "waiting" | "unchanged" | "watching"; text: string } | null {
  const w = ws.find((x) => x.active && x.rule.type !== "comment" && (x.head || x.sync));
  if (!w) return null;
  const from = short(w.sync?.from ?? w.head);
  if (w.sync?.state === "waiting") return { kind: "waiting", text: `Waiting for new run (head ${from} → …)` };
  if (w.sync?.state === "moved") return { kind: "waiting", text: `Waiting for new run (head ${from} → ${short(w.head)})` };
  if (w.sync?.state === "unchanged") return { kind: "unchanged", text: `Update did not change the head — still watching the old run (${from})` };
  return w.head ? { kind: "watching", text: `Watching run on ${short(w.head)}` } : null;
}

/** Only the verdict is read, not what follows the colon: "CI passed: ignoring 1: detect-failures" is a pass. */
export const firedOk = (w: PrWatch): boolean => !/fail/i.test((w.lastText ?? "").split(":")[0]!);

/** "CI passed · 10:42" — what the button says once a watch has fired; the tick or cross before it is drawn, not typed. */
export function firedLabel(w: PrWatch): string {
  const said = (w.lastText ?? "Notified").split(":")[0]!.trim();
  const d = new Date(w.lastAt ?? 0);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${said}${w.lastAt ? ` · ${hm}` : ""}`;
}

// Which fires have been looked at, per pull request. Kept in the browser: it is
// a fact about this person's screen, not about the pull request.
const SEEN_KEY = "agentglass.prWatch.seen";
const seenSubs = new Set<() => void>();
function readSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { return {}; }
}
export const fireSeenAt = (repo: string, number: number): number => readSeen()[`${repo}#${number}`] ?? 0;
export function markFireSeen(repo: string, number: number, at: number): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [`${repo}#${number}`]: at })); } catch { /* private mode: dismissed until reload */ }
  for (const fn of seenSubs) fn();
}
/** Re-renders the button when a fire is dismissed, from any place that dismisses it. */
export function useFireSeen(repo: string, number: number): number {
  return useSyncExternalStore(
    (fn) => { seenSubs.add(fn); return () => { seenSubs.delete(fn); }; },
    () => fireSeenAt(repo, number),
  );
}
