import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import { lineDiff } from "../../lib/flightPlan.ts";

/** The plan as it is now against an earlier version of its text, line by line. */
export function PlanCompare({ planId, planMd, n, onClose }: { planId: string; planMd: string; n: number; onClose: () => void }) {
  const [old, setOld] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setOld(null); setErr("");
    api.flightPlanRevision(planId, n).then((r) => { if (r.ok && r.revision) setOld(r.revision.planMd); else setErr(r.error ?? "could not read that version"); }).catch(() => setErr("could not reach the server"));
  }, [planId, n]);
  const rows = useMemo(() => (old === null ? [] : lineDiff(old, planMd)), [old, planMd]);
  const changed = rows.filter((r) => r.kind !== "same").length;
  return (
    <div className="cmp" role="region" aria-label={`The plan against v${n}`}>
      <div className="cmp-h"><b>v{n} → now</b><span>{old === null ? "" : changed ? `${changed} ${changed === 1 ? "line" : "lines"} changed` : "no change in the text"}</span>
        <button type="button" className="btn sm" onClick={onClose}>Close</button></div>
      {err && <div className="say bad" role="alert">{err}</div>}
      <div className="cmp-b">
        {rows.map((r, i) => <div key={i} className={`dl ${r.kind}`}><span aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span><span>{r.text || " "}</span></div>)}
      </div>
    </div>
  );
}
