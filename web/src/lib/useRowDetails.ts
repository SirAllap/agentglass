import { useEffect, useMemo, useRef, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { needsClosedFacts } from "../../../shared/prClosed.ts";

/** How many a request carries (the server's own cap), and how far down a list the cards are filled. */
export const DETAIL_BATCH = 24;
export const DETAIL_REACH = 48;

/**
 * Which numbers to ask for next: the first rows that are still being read, not
 * asked for already, within reach of the top of the list. Pure, so the budget
 * rule (deduped, bounded, never twice) is what the test pins.
 */
export function nextDetailBatch(rows: (Pick<PrSummary, "number" | "checksLoaded"> & Partial<Pick<PrSummary, "state" | "closed">>)[], tried: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const r of rows.slice(0, DETAIL_REACH)) {
    if (owesDetails(r) && !tried.has(r.number)) out.push(r.number);
    if (out.length === DETAIL_BATCH) break;
  }
  return out;
}

/**
 * A row that is still owed something: its checks and size (the second pass), or
 * — for a merged or closed one — the facts of how it ended. A search answered
 * with Enter brings finished rows complete except for those facts.
 */
export const owesDetails = (r: Pick<PrSummary, "checksLoaded"> & Partial<Pick<PrSummary, "state" | "closed">>): boolean =>
  r.checksLoaded === false || needsClosedFacts(r);

/**
 * What a finished pull request was read as, kept for the life of the page: it
 * never changes, so a panel that closes and reopens asks the server for nothing.
 * Ceiling: a reload of the page forgets it; the server's own store answers then
 * without a GitHub request.
 */
const finishedSeen = new Map<string, Partial<PrSummary>>();
export const forgetFinishedSeen = (): void => finishedSeen.clear();

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
    () => rows.map((r) => {
      if (!owesDetails(r)) return r;
      const hit = got.get(r.number) ?? (r.state !== "OPEN" ? finishedSeen.get(`${root}\u0000${r.number}`) : undefined);
      return hit ? { ...r, ...hit } as PrSummary : r;
    }),
    [rows, got, root],
  );
  const batch = on ? nextDetailBatch(filled, tried.current.n) : [];
  const finishedOf = (numbers: number[]) => numbers.filter((n) => { const r = filled.find((x) => x.number === n); return r != null && r.state !== "OPEN"; });
  const key = batch.join(",");
  useEffect(() => {
    if (!key || !root) return;
    const numbers = key.split(",").map(Number);
    for (const n of numbers) tried.current.n.add(n);
    let live = true;
    void api.prRowDetails(root, numbers, finishedOf(numbers)).then((r) => {
      if (!live || !r?.rows) return;
      for (const [n, row] of Object.entries(r.rows)) if (row.closed) finishedSeen.set(`${root}\u0000${n}`, row);
      setGot((cur) => { const next = new Map(cur); for (const [n, row] of Object.entries(r.rows)) next.set(Number(n), row); return next; });
    }).catch(() => {});
    return () => { live = false; };
  }, [key, root]);
  return filled;
}
