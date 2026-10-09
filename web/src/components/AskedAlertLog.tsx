/*
 * The last few notifications the person asked for, and what became of each.
 *
 * A quiet list, read when somebody wonders "did it ever tell me?": when it fired,
 * when a window drew it, when it was opened or closed, and why the OS popup was
 * not shown when it was not. It is not a notification kind and never interrupts.
 */
import { useEffect, useState } from "react";
import type { AskedAlert } from "../../../shared/notifyPayload.ts";
import { api } from "../lib/api.ts";
import { EDGE } from "./workspace/Chrome.tsx";
import { askedState, askedTimeline } from "../lib/askedAudit.ts";

export function AskedAlertLog() {
  const [rows, setRows] = useState<AskedAlert[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.askedAudit().then((r) => { if (!dead) setRows(r?.audit ?? []); }).catch(() => { if (!dead) setRows([]); });
    return () => { dead = true; };
  }, []);
  if (!rows) return <div className="px-3 py-3 text-[11.5px] t-dim2">Loading…</div>;
  if (!rows.length) return <div className="px-3 py-3 text-[11.5px] t-dim2">Nothing asked for has fired yet.</div>;
  return (
    <div className="flex flex-col gap-1 px-1">
      {rows.slice(0, 10).map((a) => (
        <div key={a.id} className="flex flex-col px-2 py-1.5 rounded-lg" style={{ border: EDGE }}>
          <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>{a.payload.title}</span>
          <span className="text-[11px] t-dim2">{askedState(a)} — {askedTimeline(a)}</span>
          {a.osError && <span className="text-[11px]" style={{ color: "var(--warning-ink)" }}>Desktop popup not shown: {a.osError}</span>}
        </div>
      ))}
    </div>
  );
}
