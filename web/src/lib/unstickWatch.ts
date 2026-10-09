/*
 * What this window has seen of a pull request that might be stuck, in memory.
 *
 * Per repository and number: the two signals (branch ahead of the pull request,
 * mergeability UNKNOWN) as runs of separate looks, and what a normal Update
 * branch did. Nothing here is stored: a window that was closed has seen nothing,
 * and the action it feeds (shared/unstick.ts) would rather wait than guess.
 */
import { lookAt, unstickGate, LAG_AFTER_MS, MIN_LOOKS, unstickSignalNow, type GateInput, type Run, type UnstickFacts, type UnstickGate, type UpdateTrial } from "../../../shared/unstick.ts";

interface Entry { lag: Run | null; unknown: Run | null; trial: UpdateTrial | null }
const seen = new Map<string, Entry>();

/** Fold one refresh into the runs. Call it when new data arrived, never from render. */
export function observeUnstick(key: string, f: UnstickFacts, now = Date.now()): void {
  const e = seen.get(key) ?? { lag: null, unknown: null, trial: null };
  const sig = unstickSignalNow(f);
  const lagHolds = !!f.refSha && !!f.headSha && f.refSha !== f.headSha;
  e.lag = lookAt(e.lag, lagHolds, now);
  e.unknown = lookAt(e.unknown, f.mergeState === "UNKNOWN", now);
  // Nothing stuck any more: what a past Update branch did no longer says anything.
  if (!sig) e.trial = null;
  seen.set(key, e);
}

export function noteUpdateTrial(key: string, t: UpdateTrial): void {
  const e = seen.get(key) ?? { lag: null, unknown: null, trial: null };
  e.trial = t;
  seen.set(key, e);
}

export function unstickGateFor(key: string, f: UnstickFacts, now = Date.now()): UnstickGate {
  const e = seen.get(key);
  const i: GateInput = { now, facts: f, lag: e?.lag ?? null, unknown: e?.unknown ?? null, trial: e?.trial ?? null };
  return unstickGate(i);
}

/** The lag run is old enough that pressing Update branch to find out is the next honest move. */
export function lagMature(key: string, now = Date.now()): boolean {
  const r = seen.get(key)?.lag;
  return !!r && r.looks >= MIN_LOOKS && now - r.since >= LAG_AFTER_MS;
}

export function forgetUnstick(key?: string): void { if (key) seen.delete(key); else seen.clear(); }
