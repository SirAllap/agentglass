import { useEffect, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { api } from "./api.ts";

/*
 * The pull requests whose branch carries a card key, asked once per key.
 *
 * The server does the work (a `git ls-remote` in the local clone and one
 * batched read, cached five minutes there); this keeps the answer for the
 * session so searching the same key again, or coming back to it, sends nothing.
 * Only the search box's Enter can start it: the caller passes `enabled` once
 * GitHub has been asked, never on a keystroke. No timer, no retry; a failed ask
 * is remembered as "none" for this session rather than hammering a clone with
 * no remote.
 */
const done = new Map<string, PrSummary[]>();
const asking = new Map<string, Promise<PrSummary[]>>();
const keyOf = (root: string, key: string) => `${root}\u0000${key.toUpperCase()}`;

export function askRefBranches(root: string, key: string): Promise<PrSummary[]> {
  const k = keyOf(root, key);
  const hit = done.get(k);
  if (hit) return Promise.resolve(hit);
  const flying = asking.get(k);
  if (flying) return flying;
  const p = api.prRefBranches(root, key)
    .then((r) => r?.rows ?? [])
    .catch((): PrSummary[] => [])
    .then((rows) => { done.set(k, rows); return rows; })
    .finally(() => { asking.delete(k); });
  asking.set(k, p);
  return p;
}
export function __forgetRefBranches(): void { done.clear(); asking.clear(); }

/** Rows for `keys` (all of them, de-duplicated) and whether any ask is still out. `enabled` false asks nothing. */
export function useRefBranches(root: string, keys: readonly string[], enabled: boolean): { rows: PrSummary[]; pending: boolean } {
  const id = keys.join(",");
  const [state, setState] = useState<{ id: string; rows: PrSummary[] }>({ id: "", rows: [] });
  useEffect(() => {
    if (!enabled || !root || !keys.length) { setState({ id: "", rows: [] }); return; }
    let live = true;
    void Promise.all(keys.map((k) => askRefBranches(root, k))).then((all) => {
      if (!live) return;
      const by = new Map<number, PrSummary>();
      for (const rows of all) for (const r of rows) if (!by.has(r.number)) by.set(r.number, r);
      setState({ id, rows: [...by.values()] });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, id, enabled]);
  return { rows: state.id === id ? state.rows : [], pending: enabled && keys.length > 0 && state.id !== id };
}
