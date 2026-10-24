import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SettingRow } from "./SettingRow.tsx";
import { ColumnsIcon } from "./settingsNavIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EmptyState, SettingsCard } from "./SettingsKit.tsx";
import { Select } from "./Select.tsx";
import { api } from "../lib/api.ts";
import { fmtUsd } from "../lib/format.ts";
import type { GitRepoRef } from "../../../shared/types.ts";
import type { Budget, BudgetPeriod, BudgetStatus } from "../../../shared/types.ts";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";

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
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
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
    api.gitRepos().then((r) => setRepos(r.repos)).catch(() => setRepos([]));
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

  const card = (children: ReactNode, foot?: ReactNode) => (
    <SettingsCard title="Spending" icon={<ColumnsIcon size={ICON.sm} />} desc="A ceiling you set, so the insights stop firing on constants.">
      {children}
      {foot && <div className="agx-gb-foot">{foot}</div>}
    </SettingsCard>
  );
  if (!rows) return card(<EmptyState>Reading budgets…</EmptyState>);

  const statusFor = (b: Budget) =>
    status.find((s) => s.budget.root === b.root && s.budget.model === b.model && s.budget.period === b.period);

  /* A budget is a row of a table: the limit, the period, the repository and the
     model are the four columns, Remove sits where every row's action sits, and
     the bar under it says how near the ceiling the spend is. Under 560px of
     card the four fields wrap into two lines (`.agx-btable`). Add is the card's
     footer, the one action. */
  return card(<>
    {rows.length === 0 && (
      <EmptyState>
        Without one, spend is flagged on fixed thresholds — which is noise on a project that costs
        that much anyway, and silence on one where a tenth of it would worry you.
      </EmptyState>
    )}

    {rows.length > 0 && (
      <div className="agx-btable" role="table" aria-label="Budgets">
        {rows.map((b, i) => {
          const s = statusFor(b);
          const pct = s ? Math.min(1, s.pct) : 0;
          const tint = s?.level === "over" ? "var(--error)" : s?.level === "warn" ? "var(--warning)" : "var(--success)";
          const ink = s?.level === "over" ? "var(--error-ink)" : s?.level === "warn" ? "var(--warning-ink)" : "var(--text3)";
          const id = `budget-${i}`;
          return (
            <div key={i} className="agx-btable-r" role="row" aria-label={`Budget ${i + 1}`}>
              <label className="agx-btable-c agx-btable-limit" htmlFor={`${id}-limit`}>
                <span aria-hidden>$</span>
                <input id={`${id}-limit`} aria-label="Limit, in dollars" className={`t-mono ${INPUT}`} style={INPUT_STYLE}
                  inputMode="decimal" value={b.limit || ""} placeholder="40"
                  onChange={(e) => patch(i, { limit: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} />
              </label>
              <span className="agx-btable-c agx-btable-period" role="cell">
                <Select value={b.period} title="Period" onChange={(v) => patch(i, { period: v as BudgetPeriod })}
                  options={[{ value: "day", label: "a day" }, { value: "week", label: "a week" }, { value: "month", label: "a month" }]} />
              </span>
              {/* "everything" is the empty root, and it has to stay reachable — a budget with no checkout is the whole machine's. */}
              <span className="agx-btable-c agx-btable-repo" role="cell" title="Empty is everything this machine works on.">
                <CheckoutPicker repos={repos} value={b.root}
                  onPick={(r) => patch(i, { root: r === b.root ? "" : r })}
                  placeholder="everything" triggerMaxWidth={200} />
              </span>
              <span className="agx-btable-c agx-btable-model" role="cell">
                <Select value={b.model} title="Model" onChange={(v) => patch(i, { model: v })}
                  options={[{ value: "", label: "any model" }, ...models.map((m) => ({ value: m, label: m })),
                    ...(b.model && !models.includes(b.model) ? [{ value: b.model, label: b.model }] : [])]} />
              </span>
              <Button tone="danger" onClick={() => void save(rows.filter((_, n) => n !== i))}>Remove</Button>
              {/* The denominator, where the number is. A budget you cannot see yourself approaching is one you only hear about once. */}
              {s && (
                <span className="agx-btable-bar">
                  <span className="agx-btable-track"><span style={{ width: `${pct * 100}%`, background: tint }} /></span>
                  <span style={{ color: ink }}>
                    {fmtUsd(s.spent)} of {fmtUsd(s.budget.limit)} · {Math.round(s.pct * 100)}%
                    <span className="t-dim"> · {s.fromDay} to {s.toDay}</span>
                  </span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    )}

    <SettingRow
      label="How a budget is counted"
      hint="What goes into the number."
      detail={{ summary: "Details", body: <>
        Counted from the daily rollup as well as live events, so a monthly budget really means a month —
        raw events are only kept for <span className="t-mono">AGENTGLASS_RETENTION_DAYS</span> (8 by
        default). You are warned at 80% rather than only when you cross it.
      </> }} />
    {err && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
  </>,
  <Button tone="primary" disabled={busy}
    onClick={() => setRows([...(rows ?? []), { root: "", model: "", limit: 0, period: "month" }])}>
    Add a budget
  </Button>);
}
