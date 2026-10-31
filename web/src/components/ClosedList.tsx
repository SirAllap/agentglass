import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { closedAt, groupClosed } from "../lib/closedList.ts";
import type { PrSummary } from "../../../shared/types.ts";

/** Cards drawn at first, and added each time the end nears: 555 closed pull requests are never 555 mounted cards. */
export const CLOSED_CHUNK = 30;

/**
 * The Closed tab: the board's own cards (`card` draws one), grouped by the day it ended, newest first.
 * The card carries what the list's columns used to (branch, linked card, review, checks, size, who closed it and when)
 * and, for the viewer's own, whether anything is left on this computer.
 */
export function ClosedList({ rows, resetKey, card }: { rows: PrSummary[]; resetKey: string; card: (p: PrSummary) => ReactNode }) {
  const [cap, setCap] = useState(CLOSED_CHUNK);
  useEffect(() => { setCap(CLOSED_CHUNK); }, [resetKey]);
  const grow = useCallback(() => setCap((c) => c + CLOSED_CHUNK), []);
  const shown = useMemo(() => rows.slice(0, cap).map((p) => ({ p, at: closedAt(p) })), [rows, cap]);
  const groups = useMemo(() => groupClosed(shown), [shown]);
  const left = rows.length - shown.length;
  return (
    <div data-closed-list className="pt-1" role="list" aria-label="Closed pull requests">
      {groups.map((g) => (
        <section key={g.label} data-closed-group={g.label} aria-label={g.label}>
          <h3 className="agx-cl-day"><span>{g.label}</span><span className="tabular-nums">{g.rows.length}</span></h3>
          <div className="agx-cl-grid">
            {g.rows.map(({ p }) => <div key={p.number} role="listitem" className="contents">{card(p)}</div>)}
          </div>
        </section>
      ))}
      {left > 0 && <ClosedMore left={left} onMore={grow} />}
    </div>
  );
}

function ClosedMore({ left, onMore }: { left: number; onMore: () => void }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) onMore(); },
      { root: el.closest("[data-results]"), rootMargin: "0px 0px 800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el, left, onMore]);
  return (
    <button ref={setEl} onClick={onMore} data-closed-more className="agx-btn rounded-lg text-[11px] w-full mt-2"
      style={{ minHeight: 40, border: "1px dashed color-mix(in srgb, var(--text) 24%, transparent)", color: "var(--text2)" }}>
      Show {Math.min(left, CLOSED_CHUNK)} more ({left} left)
    </button>
  );
}
