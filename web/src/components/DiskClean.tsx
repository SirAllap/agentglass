// The machine panel's disk cleanup: scan on request, show what would go and why,
// remove it on one press the person makes.
//
// The scan is read-only and on demand (`du` and Docker take seconds, and nothing
// here polls). The plan on screen IS the dry run: every line says what it is, how
// big, whether it may go and why, and nothing is removed until the Remove press
// that follows the first one. An agent can only stage a plan (diskclean.stage);
// the press here is the effect, and it carries the same hold every prepared
// dialog does. The server resolves what to delete from its own fresh scan by line
// id, so no path ever travels from this file.
//
// Every line shows its WHY all the time instead of opening on a click: nothing
// here expands, so nothing below a line can be pushed to somewhere else.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { DiskIcon, RefreshIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EDGE, LINE } from "./workspace/Chrome.tsx";
import type { DiskCleanLine, DiskCleanMount, DiskCleanReport, DiskCleanRunResult } from "../../../shared/types.ts";
import {
  VERDICT, cleanable, confirmLabel, fmtBytes, phaseOf, publishDiskMounts, resultView, sortLines, useDiskWarnPct, wholePlan, type Tone,
} from "../lib/diskClean.ts";
import { clearDiskStage, needsStageScan, planDiskStage, useDiskStage, type DiskStageRequest } from "../lib/diskStage.ts";
import { preparedLine, useStageHold } from "../lib/stageHold.ts";
import { freePct } from "../lib/diskWarnPref.ts";

const TONE: Record<Tone, string> = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--error)", muted: "var(--text3)" };
const TONE_INK: Record<Tone, string> = { ok: "var(--success-ink)", warn: "var(--warning-ink)", bad: "var(--error-ink)", muted: "var(--text3)" };
/** Line grid: what it is | size | verdict | its own button. Declared once so the header and the rows cannot drift. */
const GRID = "minmax(0,1fr) 64px 84px 118px";
const BTN = "agx-btn text-[10.5px] leading-none px-2 rounded inline-flex items-center justify-center whitespace-nowrap disabled:opacity-40";
/** One control height for everything pressable in this block. */
const BTN_H = 24;

type Armed = null | "all" | string;

export function DiskClean() {
  const [report, setReport] = useState<DiskCleanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiskCleanRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [armed, setArmed] = useState<Armed>(null);
  const [staged, setStaged] = useState<DiskStageRequest | null>(null);
  const warn = useDiskWarnPct();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const scan = useCallback(async (fresh: boolean) => {
    setScanning(true); setError(null); setResult(null); setArmed(null);
    try {
      const r = await api.machineDiskClean(fresh);
      if (!alive.current) return;
      setReport(r);
      publishDiskMounts("scan", r.mounts);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally { if (alive.current) setScanning(false); }
  }, []);

  /* An agent's staged plan: copied into state the moment there is one (the
     mailbox forgets after a minute) and measured against the scan on screen.
     With no scan yet, the cached one is fetched first: staging is not a reason
     to walk the disk. */
  const req = useDiskStage();
  const triedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!req) return;
    if (report) { setStaged(req); setArmed(null); clearDiskStage(); }
    else if (needsStageScan(req, triedFor.current, scanning)) { triedFor.current = req.n; void scan(false); }
  }, [req, report, scanning, scan]);

  const view = useMemo(() => {
    const lines = report ? sortLines(report.lines) : [];
    const stagedPlan = staged && report ? planDiskStage(staged, report.lines) : null;
    return { lines, plan: report ? wholePlan(report) : { ids: [], bytes: 0 }, stagedPlan };
  }, [report, staged]);
  const phase = phaseOf({ report, scanning, error, result });
  const hold = useStageHold(staged !== null, staged?.n);

  /* Escape puts the confirmation away first, and only then lets the panel see the key. */
  useEffect(() => {
    if (armed === null) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setArmed(null); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [armed]);

  const run = async (ids: string[]) => {
    setArmed(null); setRunning(true);
    try {
      const r = await api.machineDiskCleanRun(ids, report?.at);
      if (!alive.current) return;
      setResult(r); setStaged(null);
      // The badge should not go on saying the old number once the disk has more room.
      if (report) publishDiskMounts("scan", report.mounts.map((m) => ({ ...m, free: r.mounts.find((x) => x.mount === m.mount)?.after ?? m.free })));
    } catch (e) {
      if (alive.current) setResult({ ok: false, error: e instanceof Error ? e.message : String(e), dryRun: false, lines: [], mounts: [], freed: 0 });
    } finally { if (alive.current) setRunning(false); }
  };

  // The header's one clean button: the staged plan when there is one, else the whole plan.
  const target = view.stagedPlan ?? view.plan;
  const canClean = phase === "plan" && target.ids.length > 0 && !running;

  return (
    <section aria-label="Disk cleanup" style={{ borderBottom: LINE }}>
      <div className="flex items-center gap-2 px-3.5 py-2 text-[11px]" style={{ background: "color-mix(in srgb, var(--text) 5%, transparent)", borderBottom: LINE }}>
        <span className="flex shrink-0" style={{ color: "var(--text3)" }}><DiskIcon size={ICON.xs} /></span>
        <span className="shrink-0" style={{ color: "var(--text)", fontWeight: 500 }}>Disk cleanup</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{summary(phase, view.plan.bytes, view.plan.ids.length, report)}</span>
        {canClean && (armed === (staged ? "staged" : "all") ? (
          <>
            <button type="button" className={BTN} style={{ height: BTN_H, color: "var(--error-ink)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}
              onClick={() => void run(target.ids)} autoFocus>{confirmLabel(target.ids.length, target.bytes)}</button>
            <button type="button" className={BTN} style={{ height: BTN_H, color: "var(--text2)", border: EDGE }} onClick={() => setArmed(null)}>Keep</button>
          </>
        ) : (
          <button type="button" className={BTN} disabled={staged !== null && hold} title={staged && hold ? "Read what the agent prepared first" : "Remove everything marked Safe. You confirm next."}
            style={{ height: BTN_H, color: "var(--success-ink)", border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)", background: "color-mix(in srgb, var(--success) 10%, transparent)" }}
            onClick={() => setArmed(staged ? "staged" : "all")}>
            {staged ? `Clean staged ${fmtBytes(target.bytes)}` : `Clean ${fmtBytes(target.bytes)}`}
          </button>
        ))}
        {running && <span className="shrink-0 text-[10.5px]" style={{ color: "var(--text3)" }} role="status">Removing…</span>}
        <button type="button" className={`${BTN} shrink-0 gap-1`} disabled={scanning || running}
          style={{ height: BTN_H, ...(scanning ? { color: "var(--text3)", border: EDGE } : { color: "var(--primary-ink)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }) }}
          title="Look at what is on the disks. Reads only; nothing is removed."
          onClick={() => void scan(true)}>
          <RefreshIcon size={ICON.xs} className={scanning ? "animate-spin" : undefined} />
          {scanning ? "Scanning…" : report || error ? "Scan again" : "Scan"}
        </button>
      </div>

      {phase === "idle" && (
        <Note>Nothing is scanned until you ask. The scan only reads: nothing is removed, and nothing runs on a timer.</Note>
      )}
      {phase === "scanning" && (
        <div className="px-3.5 py-3" role="status">
          <div className="text-[11px]" style={{ color: "var(--text2)" }}>Looking at Docker, checkouts, caches and the trash…</div>
          <div className="mt-2 overflow-hidden rounded-full" style={{ height: 4, background: "color-mix(in srgb, var(--text) 12%, transparent)" }}>
            <div className="agx-indeterminate" style={{ height: "100%", width: "40%", background: "var(--primary)" }} />
          </div>
          <div className="mt-1.5 text-[10px]" style={{ color: "var(--text4)" }}>Measuring folders can take a minute on a big disk.</div>
        </div>
      )}
      {phase === "error" && (
        <div className="px-3.5 py-3 text-[11px]" role="alert" style={{ color: "var(--error-ink)" }}>
          The scan did not finish: {error}
          <div className="mt-0.5 text-[10px]" style={{ color: "var(--text3)" }}>Nothing was removed. Scan again once it is fixed.</div>
        </div>
      )}

      {phase === "done" && result && <Done result={result} />}

      {(phase === "plan" || phase === "empty") && report && (
        <>
          {report.problems.length > 0 && (
            <div className="flex items-start gap-1.5 px-3.5 py-1.5 text-[10.5px]" role="alert"
              style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 9%, transparent)", borderBottom: LINE }}>
              <span className="mt-px shrink-0 flex"><WarningIcon size={ICON.xs} /></span>
              <span className="min-w-0">
                {report.problems.map((p, i) => <span key={i} className="block">{p}</span>)}
                <span className="block" style={{ color: "var(--text3)" }}>What could be read is listed below; the rest is missing from the plan.</span>
              </span>
            </div>
          )}
          {staged && view.stagedPlan && (
            <div className="px-3.5 py-1.5 text-[10.5px]" style={{ borderBottom: LINE, background: "color-mix(in srgb, var(--primary) 7%, transparent)", color: "var(--text2)" }}>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  {preparedLine(staged.by)} It picked {view.stagedPlan.ids.length} line{view.stagedPlan.ids.length === 1 ? "" : "s"} ({fmtBytes(view.stagedPlan.bytes)}); marked below.
                  {view.stagedPlan.dropped.map((d) => <span key={d.id} className="block" style={{ color: "var(--text3)" }}>Left out {report.lines.find((l) => l.id === d.id)?.label ?? "a line that is gone"}: {d.why}.</span>)}
                </span>
                <button type="button" className={`${BTN} shrink-0`} style={{ height: BTN_H, color: "var(--text2)", border: EDGE }}
                  onClick={() => { setStaged(null); setArmed(null); }}>Discard</button>
              </div>
            </div>
          )}
          <Mounts mounts={report.mounts} warn={warn} />
          {phase === "empty" && (
            <Note>{report.lines.length ? "Nothing to clean right now. What is left is in use, needs your eye, or is only shown for information." : "Nothing found that could be cleaned."}</Note>
          )}
          {view.lines.length > 0 && (
            /* A fixed ceiling and its own scroll: fifteen lines must not push the
               process list out of reach, and a ceiling that never changes is what
               keeps every other block where it is. */
            <div className="overflow-y-auto" style={{ maxHeight: "min(44vh, 440px)" }}>
              <div className="sticky top-0 z-[1] grid px-3.5 py-1 text-[9.5px] uppercase tracking-wider"
                style={{ gridTemplateColumns: GRID, gap: 8, color: "var(--text3)", borderBottom: LINE, background: "var(--surface-card)" }}>
                <span>What</span><span className="text-right">Size</span><span>Verdict</span><span />
              </div>
              {view.lines.map((l) => (
                <LineRow key={l.id} l={l} many={report.mounts.length > 1} marked={view.stagedPlan?.ids.includes(l.id) ?? false}
                  armed={armed === l.id} busy={running} onArm={() => setArmed(l.id)} onKeep={() => setArmed(null)}
                  onRun={() => void run([l.id])} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function summary(phase: ReturnType<typeof phaseOf>, bytes: number, n: number, report: DiskCleanReport | null): string {
  switch (phase) {
    case "idle": return "see what is eating the disk, and what can go";
    case "scanning": return "scanning…";
    case "error": return "could not scan";
    case "done": return "report of the clean";
    case "empty": return report?.lines.length ? "nothing safe to remove" : "nothing found";
    case "plan": return `${fmtBytes(bytes)} can go, in ${n} item${n === 1 ? "" : "s"}`;
  }
}

const Note = ({ children }: { children: ReactNode }) => <div className="px-3.5 py-2.5 text-[10.5px]" style={{ color: "var(--text3)" }}>{children}</div>;

function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center justify-center rounded-full px-1.5 text-[9.5px] leading-[16px] whitespace-nowrap"
      style={{ color: TONE_INK[tone], background: `color-mix(in srgb, ${TONE[tone]} ${tone === "muted" ? 12 : 16}%, transparent)` }}>
      {children}
    </span>
  );
}

/** Free space per disk, so it is clear which one is full. Under the setting the bar turns amber; the green tail is what the plan would give back. */
function Mounts({ mounts, warn }: { mounts: DiskCleanMount[]; warn: number }) {
  if (!mounts.length) return null;
  return (
    <div className="flex flex-col gap-1.5 px-3.5 py-2" style={{ borderBottom: LINE }}>
      {mounts.map((m) => {
        const pct = freePct(m);
        const low = pct !== null && pct < warn;
        const used = m.size > 0 ? Math.min(100, ((m.size - m.free) / m.size) * 100) : 0;
        const back = m.size > 0 ? Math.min(used, (m.safeBytes / m.size) * 100) : 0;
        return (
          <div key={m.mount} className="grid items-center text-[10.5px]" style={{ gridTemplateColumns: "minmax(0,150px) minmax(60px,1fr) auto", gap: 10 }}>
            <span className="truncate" style={{ color: "var(--text2)" }} title={`${m.mount} (${m.source})`}>{m.mount}</span>
            <span className="flex overflow-hidden rounded-full" style={{ height: 6, background: "color-mix(in srgb, var(--text) 12%, transparent)" }}
              role="img" aria-label={`${m.mount}: ${fmtBytes(m.free)} free of ${fmtBytes(m.size)}${low ? ", low" : ""}`}>
              <span style={{ width: `${used - back}%`, background: low ? "var(--warning)" : "color-mix(in srgb, var(--text) 38%, transparent)" }} />
              <span style={{ width: `${back}%`, background: "var(--success)" }} />
            </span>
            <span className="tabular-nums text-right" style={{ color: low ? "var(--warning-ink)" : "var(--text3)" }}>
              <b style={{ fontWeight: 500, color: low ? "var(--warning-ink)" : "var(--text2)" }}>{fmtBytes(m.free)}</b> free of {fmtBytes(m.size)}
              {m.safeBytes > 0 && <span style={{ color: "var(--success-ink)" }}> · +{fmtBytes(m.safeBytes)} if cleaned</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LineRow({ l, many, marked, armed, busy, onArm, onKeep, onRun }: {
  l: DiskCleanLine; many: boolean; marked: boolean; armed: boolean; busy: boolean; onArm: () => void; onKeep: () => void; onRun: () => void;
}) {
  const v = VERDICT[l.verdict];
  return (
    <div className="grid items-start px-3.5 py-1.5 text-[11.5px]" data-line={l.id}
      style={{ gridTemplateColumns: GRID, gap: 8, borderBottom: LINE, boxShadow: marked ? "inset 2px 0 0 var(--primary)" : undefined }}>
      <div className="min-w-0">
        <div className="break-words" style={{ color: l.verdict === "explain" ? "var(--text2)" : "var(--text)" }}>
          {l.label}
          {many && <span className="ml-1.5 text-[9.5px]" style={{ color: "var(--text4)" }}>on {l.mount}</span>}
          {marked && <span className="ml-1.5 text-[9.5px]" style={{ color: "var(--primary-ink)" }}>staged</span>}
        </div>
        <div className="text-[10px]" style={{ color: "var(--text3)" }}>{l.why}</div>
      </div>
      <span className="text-right tabular-nums" style={{ color: l.verdict === "safe" ? "var(--text)" : "var(--text3)" }}>{fmtBytes(l.bytes)}</span>
      <span><Chip tone={v.tone} title={v.title}>{v.label}</Chip></span>
      <span className="flex justify-end gap-1">
        {cleanable(l) && (armed ? (
          <>
            <button type="button" className={BTN} style={{ height: BTN_H, color: "var(--error-ink)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}
              onClick={onRun} disabled={busy} autoFocus>Remove</button>
            <button type="button" className={BTN} style={{ height: BTN_H, color: "var(--text2)", border: EDGE }} onClick={onKeep}>Keep</button>
          </>
        ) : (
          <button type="button" className={BTN} disabled={busy} style={{ height: BTN_H, color: "var(--text2)", border: EDGE }}
            title={`Remove only this line (${fmtBytes(l.bytes)}). You confirm next.`} onClick={onArm}>Clean this</button>
        ))}
      </span>
    </div>
  );
}

function Done({ result }: { result: DiskCleanRunResult }) {
  const r = resultView(result);
  return (
    <div>
      <div className="px-3.5 py-2 text-[12px]" role="status" style={{ color: r.failed ? "var(--error-ink)" : "var(--text)", borderBottom: LINE }}>
        <b style={{ fontWeight: 500, color: r.failed ? "var(--error-ink)" : r.sudo.length ? "var(--warning-ink)" : "var(--success-ink)" }}>{r.headline}</b>
        {!r.failed && <span className="ml-2 text-[10.5px]" style={{ color: "var(--text3)" }}>measured as the free space each disk gained</span>}
      </div>
      {r.mounts.length > 0 && (
        <div className="flex flex-col gap-1 px-3.5 py-2 text-[10.5px]" style={{ borderBottom: LINE }}>
          {r.mounts.map((m) => (
            <div key={m.mount} className="flex items-baseline gap-2 tabular-nums">
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text2)" }}>{m.mount}</span>
              <span style={{ color: "var(--text3)" }}>free {fmtBytes(m.before)} before</span>
              <span style={{ color: "var(--text3)" }}>→</span>
              <span style={{ color: m.gained > 0 ? "var(--success-ink)" : "var(--text2)" }}>{fmtBytes(m.after)} after</span>
            </div>
          ))}
        </div>
      )}
      <div className="overflow-y-auto" style={{ maxHeight: "min(44vh, 440px)" }}>
        {r.rows.map((x) => (
          <div key={x.id} className="grid items-start px-3.5 py-1.5 text-[11.5px]" style={{ gridTemplateColumns: "minmax(0,1fr) 64px 96px", gap: 8, borderBottom: LINE }}>
            <div className="min-w-0">
              <div className="break-words" style={{ color: "var(--text)" }}>{x.label}</div>
              {x.note && <div className="text-[10px]" style={{ color: x.tone === "warn" ? "var(--warning-ink)" : "var(--text3)" }}>{x.note}</div>}
            </div>
            <span className="text-right tabular-nums" style={{ color: x.freed > 0 ? "var(--success-ink)" : "var(--text3)" }}>{x.freed > 0 ? fmtBytes(x.freed) : "—"}</span>
            <span><Chip tone={x.tone}>{x.chip}</Chip></span>
          </div>
        ))}
      </div>
      {r.sudo.length > 0 && (
        <Note>{r.sudo.length === 1 ? "1 item is owned by root. Agentglass never asks for sudo, so it is still there." : `${r.sudo.length} items are owned by root. Agentglass never asks for sudo, so they are still there.`}</Note>
      )}
    </div>
  );
}

