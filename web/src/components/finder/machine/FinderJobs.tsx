// Long copies and moves, the way Strata shows them: a small button in the footer after
// the count ("1 running", then "3 finished"), and a Jobs popover above it that lists each
// one with how long it has run, how far it has got and a way to stop it. The numbers come
// from the server (/fs/jobs), asked for only while a job runs; the rules are lib/finderOps.
import { useEffect, useRef, useState } from "react";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { formatSize } from "../../../lib/finderMiller.ts";
import { jobFraction, jobStatus, jobsLabel } from "../../../lib/finderOps.ts";
import type { FsJob } from "../../../../../shared/types.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { Popover } from "./Popover.tsx";
import { StrataIcon } from "./StrataIcon.tsx";

const BAR = "color-mix(in srgb, var(--text) 12%, transparent)";

export function JobsIndicator({ jobs, onCancel, onClear, onDone }: { jobs: readonly FsJob[]; onCancel: (id: string) => void; onClear: () => void; onDone: (j: FsJob) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<DOMRect | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const running = jobs.filter((j) => j.state === "running").length;
  // A job that was already over when the finder opened is history, not news: only one seen running is reported.
  useEffect(() => {
    for (const j of jobs) {
      if (j.state === "running") seen.current.add(`run:${j.id}`);
      else if (seen.current.has(`run:${j.id}`) && !seen.current.has(j.id)) { seen.current.add(j.id); onDone(j); }
    }
  }, [jobs, onDone]);
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);
  const label = jobsLabel(jobs);
  if (!label) return null;
  const finished = jobs.length - running;
  return (
    <>
      <button type="button" className="agx-btn rounded-md px-2 inline-flex items-center gap-1.5 shrink-0" style={{ minHeight: HIT - 6, color: "var(--text2)" }}
        title="Show background jobs" aria-haspopup="dialog" aria-expanded={!!open} onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())}>
        {label}
      </button>
      {open && (
        <Popover anchor={open} width={500} label="Jobs" onClose={() => setOpen(null)}>
          <div className="flex items-center gap-2.5 px-3 pb-2 pt-1" style={{ borderBottom: EDGE }}>
            <span style={{ color: "var(--primary-ink)" }}><StrataIcon set="act" name="list-checks" size={ICON.md} /></span>
            <b className="text-[13px]">Jobs</b>
            {running > 0 && <span style={{ color: "var(--text3)" }}>{running} running</span>}
            {finished > 0 && <span style={{ color: "var(--text3)" }}>{running > 0 ? "· " : ""}{finished} finished</span>}
            <span className="flex-1" />
            {finished > 0 && <button className="agx-btn rounded-md px-2 inline-flex items-center gap-1.5" style={{ minHeight: HIT - 6, border: EDGE }} onClick={onClear}><StrataIcon set="act" name="trash" size={ICON.xs} />Clear finished</button>}
            <button className="agx-btn rounded-md px-2 inline-flex items-center" style={{ minHeight: HIT - 6, border: EDGE }} aria-label="Minimize" onClick={() => setOpen(null)}><StrataIcon set="act" name="minus" size={ICON.xs} /></button>
          </div>
          <div className="agx-scroll overflow-auto" style={{ maxHeight: 420 }}>
            {jobs.map((j) => <JobRow key={j.id} j={j} now={now} open={more === j.id} onMore={() => setMore(more === j.id ? null : j.id)} onCancel={() => onCancel(j.id)} />)}
          </div>
        </Popover>
      )}
    </>
  );
}

function JobRow({ j, now, open, onMore, onCancel }: { j: FsJob; now: number; open: boolean; onMore: () => void; onCancel: () => void }) {
  const f = jobFraction(j);
  const meta = j.state === "running" ? (f !== null ? `${formatSize(j.done)} of ${formatSize(j.total!)}` : "Counting…") : j.state === "error" ? (j.error ?? "Failed") : `${j.items} item${j.items === 1 ? "" : "s"}`;
  return (
    <div className="px-3 py-2.5" style={{ borderBottom: EDGE }}>
      <div className="flex items-center gap-2">
        <span className="truncate min-w-0" style={{ maxWidth: 220, fontWeight: 600 }}>{j.label}</span>
        <span className="truncate" style={{ color: j.state === "error" ? "var(--error-ink)" : "var(--text3)" }}>{jobStatus(j, now)}</span>
        <span className="flex-1" />
        {j.output && <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT - 6, border: EDGE }} aria-expanded={open} onClick={onMore}>Details</button>}
        {j.state === "running" && <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT - 6, border: EDGE }} onClick={onCancel}>Cancel</button>}
      </div>
      <div className="mt-1 truncate text-[11px]" style={{ color: "var(--text3)" }}>{meta}</div>
      {j.state === "running" && (
        <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: BAR }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={f === null ? undefined : Math.round(f * 100)}>
          <div style={{ width: f === null ? "40%" : `${Math.round(f * 100)}%`, height: "100%", background: "var(--primary)" }} />
        </div>
      )}
      {j.output && open && <pre className="agx-scroll mt-1.5 mb-0 overflow-auto text-[10.5px] whitespace-pre-wrap" style={{ maxHeight: 160, color: "var(--text2)" }}>{j.output}</pre>}
    </div>
  );
}
