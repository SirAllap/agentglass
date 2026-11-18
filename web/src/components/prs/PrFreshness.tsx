import type { PrRate } from "../../../../shared/types.ts";
import { freshness } from "../../lib/prFreshness.ts";
import { CHIP_SURFACE } from "../workspace/Chrome.tsx";

/**
 * The bar's age text: how old the rows are, in amber once they are old enough
 * to doubt, and in red while GitHub's budget is spent (see lib/prFreshness.ts).
 *
 * The loud "Loading pull requests…" is for a genuinely empty pane that has no
 * age to show yet: a board with an old read to quote says how old it is, as the
 * mockup's loading state does. Once
 * rows are up, the background poll revalidates every couple of minutes and
 * announcing each one read as the list constantly reloading; with rows in hand
 * it stays as the age, and a quiet "· updating" is all a background read earns.
 */
export function PrFreshness({ at, rate, loading, checksPending, empty }: {
  /** When the rows were last really read; 0 before any read. */
  at: number;
  rate?: PrRate;
  loading: boolean;
  checksPending: boolean;
  /** No rows yet. */
  empty: boolean;
}) {
  const busy = loading || checksPending;
  const fresh = freshness(at, rate);
  const loud = busy && empty && !fresh;
  const tone = fresh?.tone;
  const color = loud ? "var(--warning)" : tone === "limited" ? "var(--error)" : tone === "stale" ? "var(--warning-ink)" : "var(--text3)";
  /* A chip with a status dot, the house look: green while the read is fresh, amber once it is old enough to doubt,
     red while GitHub's budget is spent. The dot breathes while a read is out. The old circular arrow looked like
     a second Refresh button beside the real one. */
  const dot = loud ? "var(--warning)" : tone === "limited" ? "var(--error)" : tone === "stale" ? "var(--warning)" : "var(--success)";
  return (
    <span className="inline-flex items-center gap-1.5 h-[28px] px-2.5 rounded-lg text-[11px] tabular-nums whitespace-nowrap"
      style={{ ...CHIP_SURFACE, color: loud || tone ? color : "var(--text2)" }}
      role={tone === "limited" ? "status" : undefined} title={loud ? undefined : fresh?.title}>
      {empty && loading && !fresh ? "Loading pull requests…"
        : empty && checksPending && !fresh ? "Loading check states…"
        : fresh
          ? <>
              <span aria-hidden className={busy ? "motion-safe:animate-pulse" : undefined}
                style={{ width: 7, height: 7, borderRadius: "50%", background: dot, boxShadow: `0 0 0 3px color-mix(in srgb, ${dot} 22%, transparent)` }} />
              {/^(updated|rate)/i.test(fresh.text) ? fresh.text.charAt(0).toUpperCase() + fresh.text.slice(1) : `Updated ${fresh.text}`}{!empty && tone !== "limited" && busy ? " · updating" : ""}
            </>
          : null}
    </span>
  );
}
