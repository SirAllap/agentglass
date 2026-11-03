import { ICON } from "../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { useMemo, useState } from "react";
import { findingsOf, historyRows, usd, when, type PlanDetail, type Run, type Severity } from "../../lib/flightPlan.ts";
import { CrossIcon, SealIcon, SearchIcon, TickIcon } from "./fpIcons.tsx";
import { Certificate } from "./GoPoll.tsx";

const DOT: Record<Severity, string> = { blocker: "b", major: "m", nit: "n" };

export function HistoryTab({ details, runs, now, onOpen }: { details: PlanDetail[]; runs: Run[]; now: number; onOpen: (planId: string) => void }) {
  const [filter, setFilter] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const all = useMemo(() => historyRows(details, runs), [details, runs]);
  const rows = all.filter((r) => !q.trim() || `${r.title} ${r.sub}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="page">
      <div className="card" style={{ margin: 0 }}>
        <div className="ch"><span className="ci"><SealIcon /></span><h5>Every plan that reached Go / No-go</h5><button type="button" className="btn sm" aria-pressed={filter} onClick={() => setFilter((v) => !v)}><SearchIcon size={13} />Filter</button></div>
        <div className="csub">Each row opens the plan as it was, its findings and how they were answered, and the certificate.</div>
        {filter && <div style={{ padding: "0 18px 10px" }}><input className={`field ${INPUT}`} style={{ ...INPUT_STYLE, width: "100%" }} autoFocus aria-label="Filter history" placeholder="Filter by title or project" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
        <div className="hrow h"><span>When</span><span>Plan</span><span>Findings</span><span>Verdict</span><span>Cost</span></div>
        {rows.length === 0 && <div className="say hnone">{all.length ? "Nothing matches." : "Nothing has reached Go or No-go yet."}</div>}
        {rows.map((r) => {
          const run = runs.find((x) => x.id === r.runId) ?? null;
          return (
            <div key={r.key}>
              <button type="button" className="hrow" aria-expanded={open === r.key} onClick={() => (r.planId ? onOpen(r.planId) : setOpen(open === r.key ? null : r.key))}>
                <span className="s">{when(r.at, now)}</span>
                <span className="tcell"><div className="t">{r.title}</div><div className="s">{r.sub}</div></span>
                <span className="dots" aria-label={`${r.dots.length} findings`}>{r.dots.map((d, i) => <i key={i} className={DOT[d]} />)}</span>
                <span><span className={`chip ${r.verdict === "no-go" ? "err" : "ok"}`}>{r.verdict === "no-go" ? <CrossIcon size={ICON.xs} /> : <TickIcon size={ICON.xs} />}{r.verdict === "no-go" ? "No-go" : r.verdict === "go" ? "Go" : "Checked"}</span></span>
                <span className="s">{usd(r.cost)}</span>
              </button>
              {open === r.key && run && (
                <div className="hdetail">
                  {findingsOf(run).map((f) => <div key={f.id} className="resolved"><span>{f.severity}</span><span>{f.title}{f.action ? ` — ${f.action}${f.note ? `: ${f.note}` : ""}` : " — unanswered"}</span></div>)}
                  <Certificate run={run} cap={run.input.budgetUsd ?? 0.5} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
