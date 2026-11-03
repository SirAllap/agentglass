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
 * Somebody else's closed work is the same two searches with their login in
 * place of `@me` (`who`), kept apart per person so switching never mixes them.
 */
export type ClosedSectionId = "merged" | "unmerged";
export const CLOSED_SECTIONS: { id: ClosedSectionId; label: string; query: string }[] = [
  { id: "merged", label: "Merged", query: "author:@me is:merged" },
  { id: "unmerged", label: "Closed without merging", query: "author:@me is:closed is:unmerged" },
];

type Section = { rows: PrSummary[]; total: number | null; hasNext: boolean; cursor: string | null; loading: boolean; failed: boolean };
const EMPTY: Section = { rows: [], total: null, hasNext: false, cursor: null, loading: false, failed: false };

/** The search behind a section: the viewer's own (`@me`), or one person's. */
export const closedQuery = (id: ClosedSectionId, who = "@me"): string =>
  CLOSED_SECTIONS.find((s) => s.id === id)!.query.replace("@me", who === "@me" ? who : who.replace(/[^\w.-]/g, ""));

/** What each press cost, so a report can state cold and warm counts. */
export const closedCalls = { requests: 0 };

/** Kept for the session: leaving and coming back asks nobody. */
const KEPT = new Map<string, Section>();
const keyOf = (root: string, id: ClosedSectionId, who = "@me") => `${root}|${id}${who === "@me" ? "" : `|${who.toLowerCase()}`}`;

/**
 * The number on the Closed tab: both sections' totals, from what the view
 * already read. Nothing is asked for it, so before the first open there is no
 * number rather than a request.
 */
export function closedKnownTotal(root: string): number | undefined {
  let sum = 0;
  for (const s of CLOSED_SECTIONS) {
    const t = KEPT.get(keyOf(root, s.id))?.total;
    if (t == null) return undefined;
    sum += t;
  }
  return sum;
}

/**
 * One request per page, on the first open and on Load more. Never on typing,
 * never on a timer. A server that has not read the page yet answers "loading"
 * with nothing; that is asked again on the settle schedule (prSettle.ts), which
 * is the same local round trip the list makes, not a second GitHub read.
 */
export function useMyClosed(root: string, on: boolean, who = "@me") {
  const kept = (): Record<ClosedSectionId, Section> => ({
    merged: KEPT.get(keyOf(root, "merged", who)) ?? EMPTY,
    unmerged: KEPT.get(keyOf(root, "unmerged", who)) ?? EMPTY,
  });
  const [state, setState] = useState<Record<ClosedSectionId, Section>>(kept);
  /* Another person is another list: never show the last one's while this one is asked for. */
  const [stateFor, setStateFor] = useState(who);
  if (stateFor !== who) { setStateFor(who); setState(kept()); }
  const live = useRef(true);
  const current = useRef(who);
  current.current = who;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /* An answer for the person we left is kept for them and drawn for nobody. */
  const patch = useCallback((id: ClosedSectionId, next: Section) => {
    KEPT.set(keyOf(root, id, who), next);
    if (live.current && current.current === who) setState((s) => ({ ...s, [id]: next }));
  }, [root, who]);

  const ask = useCallback(async (id: ClosedSectionId, cursor: string | null, prev: Section) => {
    const q = closedQuery(id, who);
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
  }, [root, who, patch]);

  useEffect(() => {
    if (!on || !root) return;
    for (const s of CLOSED_SECTIONS) {
      const kept = KEPT.get(keyOf(root, s.id, who));
      if (kept && !kept.failed) { setState((cur) => ({ ...cur, [s.id]: kept })); continue; }
      void ask(s.id, null, EMPTY);
    }
  }, [on, root, who, ask]);

  const more = useCallback((id: ClosedSectionId) => {
    const cur = KEPT.get(keyOf(root, id, who));
    if (cur?.cursor && !cur.loading) void ask(id, cur.cursor, cur);
  }, [root, who, ask]);

  return { sections: state, more };
}
