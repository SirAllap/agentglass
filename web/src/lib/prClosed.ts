import { useCallback, useEffect, useRef, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { settleAfter } from "./prSettle.ts";

/**
 * "My closed pull requests": the viewer's own, split the way GitHub splits
 * them, as two searches. One mixed grid made a merged change and an abandoned
 * one look alike; each section has its own count and its own Load more.
 * Merged first.
 *
 * Ceiling: the sections are the viewer's own only (`author:@me`); somebody
 * else's closed work is reached by a search, as before.
 */
export type ClosedSectionId = "merged" | "unmerged";
export const CLOSED_SECTIONS: { id: ClosedSectionId; label: string; query: string }[] = [
  { id: "merged", label: "Merged", query: "author:@me is:merged" },
  { id: "unmerged", label: "Closed without merging", query: "author:@me is:closed is:unmerged" },
];

type Section = { rows: PrSummary[]; total: number | null; hasNext: boolean; cursor: string | null; loading: boolean; failed: boolean };
const EMPTY: Section = { rows: [], total: null, hasNext: false, cursor: null, loading: false, failed: false };

/** What each press cost, so a report can state cold and warm counts. */
export const closedCalls = { requests: 0 };

/** Kept for the session: leaving and coming back asks nobody. */
const KEPT = new Map<string, Section>();
const keyOf = (root: string, id: ClosedSectionId) => `${root}|${id}`;

/**
 * One request per page, on the first open and on Load more. Never on typing,
 * never on a timer. A server that has not read the page yet answers "loading"
 * with nothing; that is asked again on the settle schedule (prSettle.ts), which
 * is the same local round trip the list makes, not a second GitHub read.
 */
export function useMyClosed(root: string, on: boolean) {
  const [state, setState] = useState<Record<ClosedSectionId, Section>>(() => ({
    merged: KEPT.get(keyOf(root, "merged")) ?? EMPTY,
    unmerged: KEPT.get(keyOf(root, "unmerged")) ?? EMPTY,
  }));
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const patch = useCallback((id: ClosedSectionId, next: Section) => {
    KEPT.set(keyOf(root, id), next);
    if (live.current) setState((s) => ({ ...s, [id]: next }));
  }, [root]);

  const ask = useCallback(async (id: ClosedSectionId, cursor: string | null, prev: Section) => {
    const q = CLOSED_SECTIONS.find((s) => s.id === id)!.query;
    patch(id, { ...prev, loading: true, failed: false });
    let wait = 0;
    for (let tries = 0; tries < 6; tries++) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!live.current) return;
      closedCalls.requests++;
      let r;
      try { r = await api.prList(root, "all", "all", false, cursor ?? undefined, q); } catch { break; }
      if (r.prs.length || !r.loading) {
        const seen = new Set(prev.rows.map((p) => p.number));
        patch(id, {
          rows: [...prev.rows, ...r.prs.filter((p) => !seen.has(p.number))],
          total: r.total ?? null, hasNext: !!r.hasNext, cursor: r.cursor ?? null, loading: false, failed: !!r.error && !r.prs.length,
        });
        return;
      }
      wait = settleAfter(r, wait || undefined).wait ?? 500;
    }
    patch(id, { ...prev, loading: false, failed: true });
  }, [root, patch]);

  useEffect(() => {
    if (!on || !root) return;
    for (const s of CLOSED_SECTIONS) {
      const kept = KEPT.get(keyOf(root, s.id));
      if (kept && !kept.failed) { setState((cur) => ({ ...cur, [s.id]: kept })); continue; }
      void ask(s.id, null, EMPTY);
    }
  }, [on, root, ask]);

  const more = useCallback((id: ClosedSectionId) => {
    const cur = KEPT.get(keyOf(root, id));
    if (cur?.cursor && !cur.loading) void ask(id, cur.cursor, cur);
  }, [root, ask]);

  return { sections: state, more };
}
