// Long copies and moves, drawn as one small card over the finder's corner: what is
// going on, how far it has got, and a way to stop it. The numbers come from the
// server (/fs/jobs), asked for only while a job runs; the rules are lib/finderOps.
import { useEffect, useRef, useState } from "react";
import { HIT } from "../../../lib/iconSize.ts";
import { formatSize } from "../../../lib/finderMiller.ts";
import { jobFraction, jobsShown } from "../../../lib/finderOps.ts";
import type { FsJob } from "../../../../../shared/types.ts";
import { EDGE } from "../../workspace/Chrome.tsx";

export function JobsPanel({ jobs, onCancel, onDone }: { jobs: readonly FsJob[]; onCancel: (id: string) => void; onDone: (j: FsJob) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const j of jobs) if (j.state !== "running" && !seen.current.has(j.id)) { seen.current.add(j.id); onDone(j); }
  }, [jobs, onDone]);
  const shown = jobsShown(jobs, now);
  useEffect(() => { if (!shown.length) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [shown.length]);
  if (!shown.length) return null;
  return (
    <div role="status" aria-label="File jobs" className="absolute right-3 flex flex-col gap-1.5" style={{ bottom: 36, width: 300, zIndex: 8 }}>
      {shown.map((j) => {
        const f = jobFraction(j);
        return (
          <div key={j.id} className="rounded-lg px-3 py-2 text-[12px] shadow-xl" style={{ background: "var(--surface-card)", border: EDGE }}>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate">{j.state === "running" ? j.label : j.state === "done" ? `${j.label} — done` : j.state === "cancelled" ? "Cancelled" : j.error ?? "Failed"}</span>
              {j.state === "running" && <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT - 6, border: EDGE }} onClick={() => onCancel(j.id)}>Cancel</button>}
            </div>
            <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--text) 12%, transparent)" }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={f === null ? undefined : Math.round(f * 100)}>
              <div style={{ width: f === null ? "40%" : `${Math.round(f * 100)}%`, height: "100%", background: j.state === "error" ? "var(--error-ink)" : "var(--primary)" }} />
            </div>
            <div className="mt-1 text-[10.5px]" style={{ color: "var(--text3)" }}>{j.state === "running" && f !== null ? `${formatSize(j.done)} of ${formatSize(j.total!)}` : j.state === "running" ? "Counting…" : `${j.items} item${j.items === 1 ? "" : "s"}`}</div>
          </div>
        );
      })}
    </div>
  );
}
