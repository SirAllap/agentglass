/*
 * The notify watches, as the board and the detail see them: ONE datum, two
 * views. The server holds the rules (server/src/prNotifyWatch.ts) and sends the
 * whole small list after every change, so the bell on a card and the bell in
 * the detail's header are the same read and cannot disagree.
 */
import { useSyncExternalStore } from "react";
import type { PrChecksRead, PrWatch, PrWatchPreset, PrWatchRule, PrWatchState } from "../../../shared/types.ts";
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
    case "ci-pass": return "All CI passed";
    case "ci-fail": return "Any check fails (first one)";
    case "comment": return "New comment";
    case "check": return `Check ~${r.match} ${r.on === "fail" ? "fails" : r.on === "pass" ? "passes" : "fails or passes"}`;
  }
}

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

export const firedOk = (w: PrWatch): boolean => !/fail/i.test(w.lastText ?? "");

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
