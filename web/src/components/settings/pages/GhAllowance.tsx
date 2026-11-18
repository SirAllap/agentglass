import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { RefreshButton, LINE } from "../../workspace/Chrome.tsx";
import { Ticks } from "../../Ticks.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { usePageLoading } from "../shell/pageLoad.tsx";

/**
 * What is left of GitHub's hourly budget.
 *
 * This app is made of `gh` calls — every pull-request list, every check, every
 * "which PRs mention this card" — against a budget that is invisible until it
 * runs out. When it does, nothing says "rate limited": the list is simply a
 * minute stale, twice, and then wrong.
 *
 * Three pots rather than one, because the small one is the one that bites:
 * Search is 30 a MINUTE against REST's 5,000 an hour, and searching is exactly
 * what looking up a card's pull requests does.
 */
export function GhBudget({ open }: { open: boolean }) {
  const [state, setState] = useState<{ ok: boolean; error?: string; budgets?: { id: string; label: string; limit: number; remaining: number; reset: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { setState(await api.ghRateLimit()); }
    catch { setState({ ok: false, error: "Could not reach the server" }); }
    finally { setBusy(false); }
  }, []);
  // On opening the pane, and never on a timer: a budget nobody is looking at is
  // a subprocess for nothing.
  useEffect(() => { if (open) void load(); }, [open, load]);
  usePageLoading("gh/allowance", open && state === null);

  return (
    <>
      <SettingRow kind="control" agentExempt label="How much of your GitHub allowance is left" help="Every pull request, check and search spends one."
        control={<RefreshButton onRefresh={() => void load()} busy={busy} title="Refresh the GitHub allowance" />} />
      <div className="px-3 pb-2.5" style={{ borderTop: LINE }}>
        {state && !state.ok && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--text3)" }}><Ticks>{state.error}</Ticks></p>
        )}
        {/* Three bars, the size the three real ones will be. `gh api` is a
            subprocess and a network round trip; without these the section is a
            heading over nothing until it answers, and then everything below it
            jumps down by 76 pixels. */}
        {!state && ["REST", "Search", "GraphQL"].map((label) => (
          <div key={label} className="mt-2" aria-hidden>
            <div className="agx-skeleton rounded" style={{ height: 14, width: label === "Search" ? 150 : 170 }} />
            <div className="agx-skeleton mt-1 rounded-full" style={{ height: 4 }} />
          </div>
        ))}
        {state?.budgets?.map((b) => {
          const left = b.limit ? b.remaining / b.limit : 0;
          // Amber under a quarter, red under a tenth: the point of the bar is
          // to be ignorable until it is not.
          const tint = left < 0.1 ? "var(--error)" : left < 0.25 ? "var(--warning)" : "var(--success)";
          const ink = left < 0.1 ? "var(--error-ink)" : left < 0.25 ? "var(--warning-ink)" : "var(--success-ink)";
          const mins = Math.max(0, Math.round((b.reset * 1000 - Date.now()) / 60_000));
          return (
            <div key={b.id} className="mt-2">
              {/* "5,000 of 5,000" next to a full bar reads as "you have used
                  all 5,000" — the number and the bar are both ambiguous about
                  which direction they run, and between them they cancel out.
                  The word `left` fixes both at once: it says what the number
                  is, and it makes a full bar mean a full tank. */}
              <div className="flex items-baseline gap-2 text-[12px]">
                <span style={{ color: "var(--text2)" }}>{b.label}</span>
                <span className="tabular-nums" style={{ color: ink }}>{b.remaining.toLocaleString()} left</span>
                <span className="tabular-nums t-dim">of {b.limit.toLocaleString()}</span>
                <span className="flex-1" />
                <span className="t-dim">{b.remaining >= b.limit ? "full" : `back to ${b.limit.toLocaleString()} in ${mins}m`}</span>
              </div>
              <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <div style={{ width: `${Math.round(left * 100)}%`, height: "100%", background: tint }} />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
