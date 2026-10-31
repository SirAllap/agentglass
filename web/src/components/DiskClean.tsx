// The machine panel's disk cleanup: scan on request, show what would go and why,
// remove it on one press the person makes.
//
// The scan is read-only and on demand (`du` and Docker take seconds, and nothing
// here repeats on its own: the Scan button is its Refresh). The plan on screen IS
// the dry run: every line says what it is, how big, whether it may go and why, and
// nothing is removed until the Remove press that follows the first one. An agent
// can only stage a plan (diskclean.stage); the press here is the effect, and it
// carries the same hold every prepared dialog does. The server resolves what to
// delete from its own fresh scan by line id, so no path ever travels from this
// file.
//
// Every line shows its WHY all the time instead of opening on a click: nothing
// here expands, so nothing below a line can be pushed to somewhere else.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { DiskIcon, DoneIcon, EyeIcon, LockIcon, RefreshIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { BroomIcon } from "./docker/DockerIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { Badge, Button } from "./workspace/Chrome.tsx";
import type { DiskCleanLine, DiskCleanMount, DiskCleanReport, DiskCleanRunResult } from "../../../shared/types.ts";
import {
  VERDICT, cleanable, confirmLabel, fmtBytes, phaseOf, publishDiskMounts, resultView, sortLines, useDiskWarnPct, wholePlan, type Tone,
} from "../lib/diskClean.ts";
import { groupsOf, mountBar } from "../lib/machineView.ts";
import { clearDiskStage, needsStageScan, planDiskStage, useDiskStage, type DiskStageRequest } from "../lib/diskStage.ts";
import { preparedLine, useStageHold } from "../lib/stageHold.ts";

const TONE: Record<Tone, string> = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--error)", muted: "var(--text3)" };
const TONE_INK: Record<Tone, string> = { ok: "var(--success-ink)", warn: "var(--warning-ink)", bad: "var(--error-ink)", muted: "var(--text3)" };

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

  // The Safe group's one clean button: the staged plan when there is one, else the whole plan.
  const target = view.stagedPlan ?? view.plan;
  const canClean = phase === "plan" && target.ids.length > 0 && !running;
  const groups = useMemo(() => groupsOf(report?.lines ?? []), [report]);
  const [showInfo, setShowInfo] = useState(false);

  const cleanButton = canClean && (armed === (staged ? "staged" : "all") ? (
    <>
      <Button tone="danger" autoFocus onClick={() => void run(target.ids)}>{confirmLabel(target.ids.length, target.bytes)}</Button>
      <Button onClick={() => setArmed(null)}>Keep</Button>
    </>
  ) : (
    <Button tint="var(--success)" solid disabled={staged !== null && hold} title={staged && hold ? "Read what the agent prepared first" : "Remove every Safe line. You confirm next."}
      onClick={() => setArmed(staged ? "staged" : "all")}>
      {staged ? `Clean staged ${fmtBytes(target.bytes)}` : `Clean ${fmtBytes(target.bytes)}`}
    </Button>
  ));
  const row = (l: DiskCleanLine) => (
    <LineRow key={l.id} l={l} many={(report?.mounts.length ?? 0) > 1} marked={view.stagedPlan?.ids.includes(l.id) ?? false}
      armed={armed === l.id} busy={running} onArm={() => setArmed(l.id)} onKeep={() => setArmed(null)} onRun={() => void run([l.id])} />
  );

  return (
    <section aria-label="Disk cleanup" className="mc-dc">
      <div className="mc-sect">
        <DiskIcon size={ICON.sm} />
        <b>Disk cleanup</b>
        <span className="t">{summary(phase, view.plan.bytes, view.plan.ids.length, report)}</span>
        <span className="sp" />
        {running && <span className="mc-fine" role="status">Removing…</span>}
        <Button disabled={scanning || running} title="Look at what is on the disks. Reads only; nothing is removed." onClick={() => void scan(true)}>
          {scanning ? <><span className="mc-spin"><RefreshIcon size={ICON.xs} /></span>Scanning…</> : <><RefreshIcon size={ICON.xs} />{report || error ? "Scan again" : "Scan"}</>}
        </Button>
      </div>

      {phase === "idle" && (
        <div className="mc-fine">Nothing is scanned until you ask. The scan only reads: nothing is removed, and nothing runs on a timer.</div>
      )}
      {phase === "scanning" && (
        <div className="mc-fine" role="status">Looking at Docker, checkouts, caches and the trash…
          <div className="mc-ind"><i /></div>Measuring folders can take a minute on a big disk.</div>
      )}
      {phase === "error" && (
        <div role="alert" style={{ color: "var(--error-ink)", fontSize: 11 }}>
          The scan did not finish: {error}
          <div className="mc-fine">Nothing was removed. Scan again once it is fixed.</div>
        </div>
      )}

      {phase === "done" && result && <Done result={result} mounts={report?.mounts ?? []} />}

      {(phase === "plan" || phase === "empty") && report && (
        <>
          {report.problems.length > 0 && (
            <div className="mc-note" role="alert" style={{ "--tint": "var(--warning)", margin: 0 } as CSSProperties}>
              <WarningIcon size={ICON.sm} />
              <span>
                {report.problems.map((p, i) => <span key={i} style={{ display: "block" }}>{p}</span>)}
                <span style={{ display: "block", color: "var(--text3)" }}>What could be read is listed below; the rest is missing from the plan.</span>
              </span>
            </div>
          )}
          {staged && view.stagedPlan && (
            <div className="mc-note" style={{ "--tint": "var(--primary)", margin: 0 } as CSSProperties}>
              <span style={{ minWidth: 0, flex: 1 }}>
                {preparedLine(staged.by)} It picked {view.stagedPlan.ids.length} line{view.stagedPlan.ids.length === 1 ? "" : "s"} ({fmtBytes(view.stagedPlan.bytes)}); marked below.
                {view.stagedPlan.dropped.map((d) => <span key={d.id} style={{ display: "block", color: "var(--text3)" }}>Left out {report.lines.find((l) => l.id === d.id)?.label ?? "a line that is gone"}: {d.why}.</span>)}
              </span>
              <Button size="compact" tone="quiet" onClick={() => { setStaged(null); setArmed(null); }}>Discard</Button>
            </div>
          )}
          <Mounts mounts={report.mounts} warn={warn} />
          {phase === "empty" && (
            <div className="mc-fine">{report.lines.length ? "Nothing to clean right now. What is left is in use, needs your eye, or is only shown for information." : "Nothing found that could be cleaned."}</div>
          )}
          {groups.safe.lines.length > 0 && (
            <PlanGroup icon={<DoneIcon size={ICON.md} />} hue="var(--success)" title="Safe" hint="come back by themselves; no sudo" tip={VERDICT.safe.title} bytes={groups.safe.bytes} action={cleanButton || undefined}>
              {groups.safe.lines.map(row)}
            </PlanGroup>
          )}
          {groups.ask.lines.length > 0 && (
            <PlanGroup icon={<EyeIcon size={ICON.md} />} hue="var(--warning)" title="Look first" hint="not in the plan: you decide" tip={VERDICT.ask.title} bytes={groups.ask.bytes}>
              {groups.ask.lines.map(row)}
            </PlanGroup>
          )}
          {groups.info.lines.length > 0 && (
            <PlanGroup icon={<LockIcon size={ICON.md} />} hue="var(--text3)" title="In use and for information" hint="stays; shown so the numbers add up" tip={`${VERDICT.inuse.title} ${VERDICT.explain.title}`}
              bytes={groups.info.bytes} fold={!showInfo}
              action={<Button size="compact" tone="quiet" aria-expanded={showInfo} onClick={() => setShowInfo((v) => !v)}>{showInfo ? "Hide" : "Show"}</Button>}>
              {showInfo && groups.info.lines.map(row)}
            </PlanGroup>
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

function PlanGroup({ icon, hue, title, hint, tip, bytes, action, fold, children }: {
  icon: ReactNode; hue: string; title: string; hint: string; tip: string; bytes: number; action?: ReactNode; fold?: boolean; children: ReactNode;
}) {
  return (
    <div className="mc-vgrp" data-fold={fold || undefined}>
      <div className="mc-vh">
        <span style={{ color: hue }}>{icon}</span>
        <b title={tip}>{title}<small>{hint}</small></b>
        <span className="sz">{fmtBytes(bytes)}</span>
        <span className="sl">{action}</span>
      </div>
      {children}
    </div>
  );
}

function ToneBadge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <Badge tint={TONE_INK[tone]} fill={TONE[tone]} wash={tone === "muted" ? 12 : 16} title={title}>{children}</Badge>;
}

/** Free space per disk, so it is clear which one is full. Under the setting the bar turns amber; the striped tail is what the plan would give back. */
function Mounts({ mounts, warn }: { mounts: DiskCleanMount[]; warn: number }) {
  if (!mounts.length) return null;
  return (
    <div className="mc-mounts">
      {mounts.map((m) => {
        const bar = mountBar(m, warn);
        return (
          <div key={m.mount} className="mc-mount">
            <div className="a">
              <b title={`${m.mount} (${m.source})`}>{m.mount}</b>
              <span data-low={bar.low || undefined}>{fmtBytes(m.free)} free of {fmtBytes(m.size)}{m.safeBytes > 0 && <em> · +{fmtBytes(m.safeBytes)} if cleaned</em>}</span>
            </div>
            <div className="b" role="img" aria-label={`${m.mount}: ${fmtBytes(m.free)} free of ${fmtBytes(m.size)}${bar.low ? ", low" : ""}`}>
              <i style={{ width: `${bar.greyPct}%`, background: bar.low ? "var(--warning)" : "var(--text4)" }} />
              {bar.safePct > 0 && <i data-stripe="safe" style={{ width: `${bar.safePct}%` }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LineRow({ l, many, marked, armed, busy, onArm, onKeep, onRun }: {
  l: DiskCleanLine; many: boolean; marked: boolean; armed: boolean; busy: boolean; onArm: () => void; onKeep: () => void; onRun: () => void;
}) {
  return (
    <div className="mc-vr" data-line={l.id} data-arm={armed || undefined} data-staged={marked || undefined}>
      <div className="a" title={`${l.label} — ${l.why}`}>
        {l.label}
        {many && <i>on {l.mount}</i>}
        {marked && <i data-staged>staged</i>}
        <small>{l.why}</small>
      </div>
      <span className={`s${l.bytes === null ? " root" : ""}`}>{l.bytes === null ? "needs root" : fmtBytes(l.bytes)}</span>
      <span className="sl">
        {cleanable(l) && (armed ? (
          <>
            <Button size="compact" tone="danger" autoFocus onClick={onRun} disabled={busy}>Remove</Button>
            <Button size="compact" tone="quiet" onClick={onKeep}>Keep</Button>
          </>
        ) : (
          <Button size="compact" square tone="quiet" disabled={busy} label={`Clean ${l.label}`}
            title={`Remove only this line (${fmtBytes(l.bytes)}). You confirm next.`} onClick={onArm}><BroomIcon size={ICON.sm} /></Button>
        ))}
      </span>
    </div>
  );
}

function Done({ result, mounts }: { result: DiskCleanRunResult; mounts: DiskCleanMount[] }) {
  const r = resultView(result);
  return (
    <div className="mc-done">
      <div role="status">
        <b style={{ color: r.failed ? "var(--error-ink)" : "var(--text)" }}>{r.headline}</b>
        {!r.failed && <span className="mc-fine"> measured as the free space each disk gained</span>}
      </div>
      {r.mounts.length > 0 && (
        <div className="mc-mounts">
          {r.mounts.map((m) => {
            const size = mounts.find((x) => x.mount === m.mount)?.size ?? 0;
            return (
              <div key={m.mount} className="mc-mount">
                <div className="a"><b>{m.mount}</b><span>free {fmtBytes(m.before)} before → {fmtBytes(m.after)} after</span></div>
                {size > 0 && <div className="b"><i style={{ width: `${Math.max(0, ((size - m.after) / size) * 100)}%`, background: "var(--text4)" }} /></div>}
              </div>
            );
          })}
        </div>
      )}
      {r.rows.length > 0 && (
        <div className="mc-vgrp">
          {r.rows.map((x) => (
            <div key={x.id} className="mc-vr" style={{ paddingLeft: 12, gridTemplateColumns: "minmax(0,1fr) 84px auto" }}>
              <div className="a" title={x.label}>{x.label}{x.note && <small>{x.note}</small>}</div>
              <span className={`s${x.freed > 0 ? "" : " root"}`}>{x.freed > 0 ? fmtBytes(x.freed) : "—"}</span>
              <span className="chip"><ToneBadge tone={x.tone}>{x.chip}</ToneBadge></span>
            </div>
          ))}
        </div>
      )}
      {r.sudo.length > 0 && (
        <div className="mc-fine">{r.sudo.length === 1 ? "1 item is owned by root. Agentglass never asks for sudo, so it is still there." : `${r.sudo.length} items are owned by root. Agentglass never asks for sudo, so they are still there.`}</div>
      )}
    </div>
  );
}
