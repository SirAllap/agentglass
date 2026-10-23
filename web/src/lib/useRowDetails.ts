import { useEffect, useMemo, useRef, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { api } from "./api.ts";

/** How many a request carries (the server's own cap), and how far down a list the cards are filled. */
export const DETAIL_BATCH = 24;
export const DETAIL_REACH = 48;

/**
 * Which numbers to ask for next: the first rows that are still being read, not
 * asked for already, within reach of the top of the list. Pure, so the budget
 * rule (deduped, bounded, never twice) is what the test pins.
 */
export function nextDetailBatch(rows: Pick<PrSummary, "number" | "checksLoaded">[], tried: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const r of rows.slice(0, DETAIL_REACH)) {
    if (r.checksLoaded === false && !tried.has(r.number)) out.push(r.number);
    if (out.length === DETAIL_BATCH) break;
  }
  return out;
}

/**
 * The second pass for the cards on screen that never had one.
 *
 * Rows the sweep or a first pass left without checks and size ask for exactly
 * themselves — batched into one request, each number asked once per repository
 * (a failed ask is not retried: there is no polling here), and only the top
 * `DETAIL_REACH` of the list. Ceiling: a card further down than that stays a
 * skeleton until the list is searched with Enter, which brings complete rows.
 * Returns the rows with what arrived laid over them.
 */
export function useRowDetails(root: string, rows: PrSummary[], on: boolean): PrSummary[] {
  const [got, setGot] = useState<Map<number, Partial<PrSummary>>>(new Map());
  const tried = useRef<{ root: string; n: Set<number> }>({ root, n: new Set() });
  if (tried.current.root !== root) tried.current = { root, n: new Set() };
  useEffect(() => { setGot(new Map()); }, [root]);

  const filled = useMemo(
    () => rows.map((r) => (r.checksLoaded === false && got.has(r.number) ? { ...r, ...got.get(r.number) } as PrSummary : r)),
    [rows, got],
  );
  const batch = on ? nextDetailBatch(filled, tried.current.n) : [];
  const key = batch.join(",");
  useEffect(() => {
    if (!key || !root) return;
    const numbers = key.split(",").map(Number);
    for (const n of numbers) tried.current.n.add(n);
    let live = true;
    void api.prRowDetails(root, numbers).then((r) => {
      if (!live || !r?.rows) return;
      setGot((cur) => { const next = new Map(cur); for (const [n, row] of Object.entries(r.rows)) next.set(Number(n), row); return next; });
    }).catch(() => {});
    return () => { live = false; };
  }, [key, root]);
  return filled;
}
