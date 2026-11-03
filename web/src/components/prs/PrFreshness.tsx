import type { PrRate } from "../../../../shared/types.ts";
import { RefreshIcon } from "../../lib/glyphIcons.tsx";
import { freshness } from "../../lib/prFreshness.ts";
import { BAR_ICON } from "../workspace/Chrome.tsx";

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
  return (
    <span className="inline-flex items-center h-[28px] text-[11px] tabular-nums whitespace-nowrap" style={{ color }}
      role={tone === "limited" ? "status" : undefined} title={loud ? undefined : fresh?.title}>
      {empty && loading && !fresh ? "Loading pull requests…"
        : empty && checksPending && !fresh ? "Loading check states…"
        : fresh
          ? <span className="inline-flex items-center gap-1"><RefreshIcon size={BAR_ICON} />{fresh.text}{!empty && tone !== "limited" && busy ? " · updating" : ""}</span>
          : ""}
    </span>
  );
}
