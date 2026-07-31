import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { fmtUsd } from "../lib/format.ts";
import type { Budget, BudgetPeriod, BudgetStatus } from "../../../shared/types.ts";

/**
 * A number you chose, instead of one this app picked.
 *
 * The spend insights fired on constants — $15 in fifteen minutes is "burning
 * fast" — which is noise on a project that genuinely costs that, and silence on
 * one where a tenth would be alarming. There was no way to say "this should not
 * cost more than X a month" and be told when it does.
 *
 * Three fields on purpose: how much, over what period, for what. Not a rate,
 * not a forecast, not a per-session cap. "£40 a month on this repository" is a
 * sentence somebody can say about their own work, and a setting phrased as one
 * is a setting that still makes sense a year after it was made.
 */
export function BudgetsPane({ open }: { open: boolean }) {
  const [rows, setRows] = useState<Budget[] | null>(null);
  const [status, setStatus] = useState<BudgetStatus[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.budgets()
      .then((r) => { setRows(r.budgets); setStatus(r.status); setModels(r.models); })
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    // The projects this machine has actually worked on, so a budget is attached
    // by picking rather than by typing a path exactly right.
    api.gitRepos().then((r) => setRoots(r.repos.map((x) => x.root))).catch(() => setRoots([]));
  }, [open, load]);

  /** Saved as a set, because a row has no identity: two budgets can differ only
   *  by a limit somebody is halfway through typing. */
  const save = async (next: Budget[]) => {
    setRows(next);
    setErr(null);
    // A row being filled in is not an error yet — it is a row being filled in.
    const ready = next.filter((b) => b.limit > 0);
    setBusy(true);
    const r = await api.budgetsSet(ready).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr(r?.error ?? "Could not save."); return; }
    if (r.status) setStatus(r.status);
  };

  const patch = (i: number, over: Partial<Budget>) =>
    void save((rows ?? []).map((b, n) => (n === i ? { ...b, ...over } : b)));

  if (!rows) return <div className="text-[11px] t-dim2">Reading budgets…</div>;

  const statusFor = (b: Budget) =>
    status.find((s) => s.budget.root === b.root && s.budget.model === b.model && s.budget.period === b.period);

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <div className="text-[10.5px] t-dim2">
          Without one, spend is flagged on fixed thresholds — which is noise on a project that costs
          that much anyway, and silence on one where a tenth of it would worry you.
        </div>
      )}

      {rows.map((b, i) => {
        const s = statusFor(b);
        const pct = s ? Math.min(1, s.pct) : 0;
        const tint = s?.level === "over" ? "var(--error)" : s?.level === "warn" ? "var(--warning)" : "var(--success)";
        return (
          <div key={i} className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg" style={{
            background: "color-mix(in srgb, var(--bg2) 60%, transparent)",
            border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
          }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10.5px] t-dim2">Spend no more than</span>
              <span className="flex items-center gap-1">
                <span className="text-[11px] t-dim2">$</span>
                <input
                  className="w-16 text-[12px] px-1.5 py-1 rounded-md t-mono"
                  style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}
                  inputMode="decimal"
                  value={b.limit || ""}
                  placeholder="40"
                  onChange={(e) => patch(i, { limit: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
                />
              </span>
              <select className="text-[11px] px-1.5 py-1 rounded-md"
                style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}
                value={b.period} onChange={(e) => patch(i, { period: e.target.value as BudgetPeriod })}>
                <option value="day">a day</option>
                <option value="week">a week</option>
                <option value="month">a month</option>
              </select>
              <span className="text-[10.5px] t-dim2">on</span>
              <select className="text-[11px] px-1.5 py-1 rounded-md min-w-0 max-w-[9rem]"
                style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}
                value={b.root} onChange={(e) => patch(i, { root: e.target.value })}>
                <option value="">everything</option>
                {roots.map((r) => <option key={r} value={r}>{r.split("/").filter(Boolean).pop() || r}</option>)}
                {b.root && !roots.includes(b.root) && <option value={b.root}>{b.root}</option>}
              </select>
              <select className="text-[11px] px-1.5 py-1 rounded-md min-w-0 max-w-[11rem]"
                style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}
                value={b.model} onChange={(e) => patch(i, { model: e.target.value })}>
                <option value="">any model</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
                {b.model && !models.includes(b.model) && <option value={b.model}>{b.model}</option>}
              </select>
              <button onClick={() => void save(rows.filter((_, n) => n !== i))}
                className="ml-auto text-[10.5px] px-2 py-1 rounded-md hover:opacity-80"
                style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                Remove
              </button>
            </div>

            {/* The denominator, where the number is. A budget you cannot see
                yourself approaching is one you only hear about once. */}
            {s && (
              <div className="flex flex-col gap-1">
                <div className="h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <div style={{ width: `${pct * 100}%`, height: "100%", background: tint }} />
                </div>
                <div className="text-[10px]" style={{ color: s.level === "ok" ? "var(--text3)" : tint }}>
                  {fmtUsd(s.spent)} of {fmtUsd(s.budget.limit)} · {Math.round(s.pct * 100)}%
                  <span className="t-dim2"> · {s.fromDay} to {s.toDay}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button
          onClick={() => setRows([...(rows ?? []), { root: "", model: "", limit: 0, period: "month" }])}
          disabled={busy}
          className="self-start text-[11px] px-2.5 py-1.5 rounded-lg hover:opacity-80"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          Add a budget
        </button>
        {err && <span className="text-[10.5px]" style={{ color: "var(--error)" }}>{err}</span>}
      </div>

      <div className="text-[10px] t-dim2">
        Counted from the daily rollup as well as live events, so a monthly budget really means a month —
        raw events are only kept for {}
        <span className="t-mono">AGENTGLASS_RETENTION_DAYS</span> (8 by default). You are warned at 80%
        rather than only when you cross it.
      </div>
    </div>
  );
}
