/*
 * The notify watches, as the board and the detail see them: ONE datum, two
 * views. The server holds the rules (server/src/prNotifyWatch.ts) and sends the
 * whole small list after every change, so the bell on a card and the bell in
 * the detail's header are the same read and cannot disagree.
 */
import { useSyncExternalStore } from "react";
import type { PrWatch, PrWatchPreset, PrWatchRule, PrWatchState } from "../../../shared/types.ts";
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
export function bellState(ws: PrWatch[]): { kind: "off" | "on" | "fired"; waiting: number; last?: PrWatch } {
  const waiting = ws.filter((w) => w.active).length;
  const last = ws.filter((w) => w.lastAt).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))[0];
  if (waiting) return { kind: "on", waiting, ...(last ? { last } : null) };
  if (last) return { kind: "fired", waiting: 0, last };
  return { kind: "off", waiting: 0 };
}
