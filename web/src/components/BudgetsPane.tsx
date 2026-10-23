import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SettingRow } from "./SettingRow.tsx";
import { EmptyState, Field, SettingsCard, SettingsForm, helpIdFor } from "./SettingsKit.tsx";
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

  const card = (children: ReactNode, actions?: ReactNode) => (
    <SettingsCard title="Spending" desc="A ceiling you set, so the insights stop firing on constants." actions={actions}>
      {children}
    </SettingsCard>
  );
  if (!rows) return card(<EmptyState>Reading budgets…</EmptyState>);

  const statusFor = (b: Budget) =>
    status.find((s) => s.budget.root === b.root && s.budget.model === b.model && s.budget.period === b.period);

  /* A budget used to be one sentence with four controls in it ("Spend no more
     than $ [40] [a month] on [repo] [model]"), which at any width but the
     widest broke across two lines with a select stranded at the end. It is a
     row now: the sentence says what it is (and where it stands), Remove sits
     beside it where every row's action sits, and the four choices are stacked
     fields under it. Add is the card's one action. */
  return card(<>
    {rows.length === 0 && (
      <EmptyState>
        Without one, spend is flagged on fixed thresholds — which is noise on a project that costs
        that much anyway, and silence on one where a tenth of it would worry you.
      </EmptyState>
    )}

    {rows.map((b, i) => {
      const s = statusFor(b);
      const pct = s ? Math.min(1, s.pct) : 0;
      const tint = s?.level === "over" ? "var(--error)" : s?.level === "warn" ? "var(--warning)" : "var(--success)";
      const ink = s?.level === "over" ? "var(--error-ink)" : s?.level === "warn" ? "var(--warning-ink)" : "var(--text3)";
      const per = b.period === "day" ? "a day" : b.period === "week" ? "a week" : "a month";
      const id = `budget-${i}`;
      return (
        <SettingRow key={i}
          label={b.limit > 0 ? `Spend no more than $${b.limit} ${per}` : "New budget"}
          /* The denominator, where the number is. A budget you cannot see
             yourself approaching is one you only hear about once. */
          hint={s ? (
            <span className="block">
              <span className="block h-1 rounded-full overflow-hidden mt-1.5" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <span className="block" style={{ width: `${pct * 100}%`, height: "100%", background: tint }} />
              </span>
              <span className="block mt-1" style={{ color: ink }}>
                {fmtUsd(s.spent)} of {fmtUsd(s.budget.limit)} · {Math.round(s.pct * 100)}%
                <span className="t-dim"> · {s.fromDay} to {s.toDay}</span>
              </span>
            </span>
          ) : undefined}
          actions={<Button tone="danger" onClick={() => void save(rows.filter((_, n) => n !== i))}>Remove</Button>}
          below={
            <SettingsForm label={`Budget ${i + 1}`} onSubmit={() => { /* saved as it is edited */ }}>
              <Field label="Limit" htmlFor={`${id}-limit`} help="In dollars. A budget with no amount is not saved.">
                <input id={`${id}-limit`} aria-describedby={helpIdFor(`${id}-limit`)}
                  className={`w-32 t-mono ${INPUT}`} style={INPUT_STYLE}
                  inputMode="decimal"
                  value={b.limit || ""}
                  placeholder="40"
                  onChange={(e) => patch(i, { limit: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} />
              </Field>
              <Field label="Period" htmlFor={`${id}-period`}>
                <select id={`${id}-period`} className={`w-40 ${INPUT}`} style={INPUT_STYLE}
                  value={b.period} onChange={(e) => patch(i, { period: e.target.value as BudgetPeriod })}>
                  <option value="day">a day</option>
                  <option value="week">a week</option>
                  <option value="month">a month</option>
                </select>
              </Field>
              {/* "everything" is the empty root, and it has to stay reachable —
                  a budget with no checkout is the whole machine's. */}
              <Field label="Repository" htmlFor={`${id}-repo`} help="Empty is everything this machine works on.">
                <div id={`${id}-repo`}>
                  <CheckoutPicker repos={repos} value={b.root}
                    onPick={(r) => patch(i, { root: r === b.root ? "" : r })}
                    placeholder="everything" triggerMaxWidth={320} />
                </div>
              </Field>
              <Field label="Model" htmlFor={`${id}-model`}>
                <select id={`${id}-model`} className={`w-full ${INPUT}`} style={INPUT_STYLE}
                  value={b.model} onChange={(e) => patch(i, { model: e.target.value })}>
                  <option value="">any model</option>
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  {b.model && !models.includes(b.model) && <option value={b.model}>{b.model}</option>}
                </select>
              </Field>
            </SettingsForm>
          } />
      );
    })}

    <SettingRow
      label="How a budget is counted"
      hint={<>
        Counted from the daily rollup as well as live events, so a monthly budget really means a month —
        raw events are only kept for <span className="t-mono">AGENTGLASS_RETENTION_DAYS</span> (8 by
        default). You are warned at 80% rather than only when you cross it.
      </>} />
    {err && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
  </>,
  <Button disabled={busy}
    onClick={() => setRows([...(rows ?? []), { root: "", model: "", limit: 0, period: "month" }])}>
    Add budget
  </Button>);
}
