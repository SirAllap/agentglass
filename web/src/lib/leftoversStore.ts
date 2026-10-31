/*
 * The inventory rows the cards and the Closed list read, kept by PR and state.
 * Rows that ask in the same tick go out as one request (GET /cleanup/inventory),
 * a PR is read once per state it is in, and a run that ends (cleanupEvents.ts)
 * replaces its row from the report's own re-read, or drops it so the next render
 * asks again. No timer, no poll, never gh.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { stateOfRow, type LeftoverState } from "./leftovers.ts";
import { isRunning, subscribeRuns } from "./cleanupEvents.ts";

const cache = new Map<string, LeftoverState>();
const asked = new Set<string>();
const pending = new Map<string, { pr: number; branch: string; key: string }[]>();
const listeners = new Set<() => void>();
let version = 0;
const bump = (): void => { version++; listeners.forEach((l) => l()); };
const keyOf = (root: string, pr: number, state: string): string => `${root}#${pr}:${state}`;

function want(root: string, pr: number, branch: string, state: string): void {
  const key = keyOf(root, pr, state);
  if (cache.has(key) || asked.has(key)) return;
  asked.add(key);
  const list = pending.get(root) ?? [];
  list.push({ pr, branch, key });
  pending.set(root, list);
  if (list.length === 1) setTimeout(() => void flush(root), 0);
}

async function flush(root: string): Promise<void> {
  const list = pending.get(root) ?? [];
  pending.delete(root);
  if (!list.length) return;
  const r = await api.cleanupInventory(root, list.map(({ pr, branch }) => ({ pr, branch }))).catch(() => null);
  const rows = r?.ok ? (r.rows ?? []) : null;
  for (const { pr, key } of list) {
    asked.delete(key);
    cache.set(key, rows ? stateOfRow(rows.find((x) => x.pr === pr)) : { kind: "unknown", why: r?.error ?? "The local inventory could not be read." });
  }
  bump();
}

/** A run of this PR ended: the report's re-read decides, or the rows are dropped and asked again. */
subscribeRuns((e) => {
  if (e.phase !== "end") return;
  const mine = `${e.repo}#${e.pr}:`;
  const left = e.report?.remaining ? e.report.remaining.items.length : null;
  let touched = false;
  for (const k of [...cache.keys()]) {
    if (!k.startsWith(mine)) continue;
    touched = true;
    if (left === 0) cache.set(k, { kind: "none" }); else cache.delete(k);
  }
  if (touched) bump();
});

export const leftoverFor = (root: string, pr: number, state: string): LeftoverState | undefined => cache.get(keyOf(root, pr, state));

/** The state of one finished PR, asked once with its neighbours. `undefined` branch or an open PR asks nothing. */
export function useLeftover(root: string | undefined, p: { number: number; headRefName: string; state: string } | null): LeftoverState | undefined {
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version, () => 0);
  const finished = !!root && !!p && p.state !== "OPEN";
  useEffect(() => { if (finished) want(root!, p!.number, p!.headRefName, p!.state); });
  return finished ? leftoverFor(root!, p!.number, p!.state) ?? { kind: "computing" } : undefined;
}

/** A Clean up of this pull request is running, wherever it was started. */
export function useCleaning(root: string | undefined, pr: number): boolean {
  const [on, setOn] = useState(() => !!root && isRunning(root, pr));
  useEffect(() => {
    setOn(!!root && isRunning(root, pr));
    return subscribeRuns((e) => { if (e.repo === root && e.pr === pr) setOn(e.phase === "start"); });
  }, [root, pr]);
  return on;
}

/** Re-renders its caller when any row of the store changes (a read lands, a run ends). */
export function useLeftoverVersion(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version, () => 0);
}
