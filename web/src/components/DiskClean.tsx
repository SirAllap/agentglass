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
import { AskAboutButton } from "./AskAboutButton.tsx";
import { diskSeed } from "../lib/askSeed.ts";
import { askAbout, askDir } from "../lib/askAbout.ts";
import { sentNote } from "../lib/sendToTerminal.ts";
import { SparkleIcon } from "../lib/glyphIcons.tsx";
import { applyKept, claimAutoReport, useDiskScan } from "../lib/diskScan.ts";
import { badgeSpace } from "../lib/diskWarnPref.ts";
import { onDiskExplainChanged } from "../lib/diskExplainBus.ts";
import type { DiskCleanLine, DiskCleanMount, DiskCleanReport, DiskCleanRunResult, DiskExplain, DiskExplainItem, DiskSpace } from "../../../shared/types.ts";
import {
  VERDICT, scannedAgo, cleanable, confirmLabel, diskHeadline, fmtBytes, phaseOf, publishDiskMounts, publishDiskPlan, explainEstimate, explainSpent, reclaimHeadline, reportGroups, resultView, sortLines, useDiskWarnPct, wholePlan, type Tone,
} from "../lib/diskClean.ts";
import { groupsOf, mountBar } from "../lib/machineView.ts";
import { clearDiskStage, needsStageScan, planDiskStage, useDiskStage, type DiskStageRequest } from "../lib/diskStage.ts";
import { preparedLine, useStageHold } from "../lib/stageHold.ts";

const TONE: Record<Tone, string> = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--error)", muted: "var(--text3)" };
const TONE_INK: Record<Tone, string> = { ok: "var(--success-ink)", warn: "var(--warning-ink)", bad: "var(--error-ink)", muted: "var(--text3)" };

type Armed = null | "all" | string;

export function DiskClean({ disk }: { disk: { diskTotal: number; diskFree: number } }) {
  const [report, setReport] = useState<DiskCleanReport | null>(null);
  const [askSaid, setAskSaid] = useState("");
  const [ownScan, setScanning] = useState(false);
  /** A scan the server is running that this panel did not start (it kept going while the dialog was closed). */
  const [serverScan, setServerScan] = useState(false);
  /* The peek's own free-space reading: the badge needs no scan. */
  const [peekSpace, setPeekSpace] = useState<DiskSpace | null>(null);
  const scanning = ownScan || serverScan;
  const reading = useDiskScan().reading;
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiskCleanRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [armed, setArmed] = useState<Armed>(null);
  const [staged, setStaged] = useState<DiskStageRequest | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const warn = useDiskWarnPct();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const ownRef = useRef(false);
  const scan = useCallback(async (fresh: boolean) => {
    ownRef.current = true; setScanning(true); setError(null); setResult(null); setArmed(null);
    try {
      let r = await api.machineDiskClean(fresh);
      // A plain read with no cache answers "scanning" at once; that scan is
      // already running, so wait for it instead of drawing an empty plan.
      for (let i = 0; alive.current && r.state === "scanning" && i < 240; i++) {
        await new Promise((res) => setTimeout(res, 750));
        r = await api.machineDiskClean(false);
      }
      if (!alive.current) return;
      if (r.state === "scanning") { setError("The scan is still running. Try again in a moment."); return; }
      setReport(r);
      publishDiskMounts("scan", r.mounts);
      // The mockup's report starts by itself after the person's own scan, once for that scan.
      if (fresh && r.lines.length && claimAutoReport(r.at)) void startRef.current();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally { ownRef.current = false; if (alive.current) setScanning(false); }
  }, []);
  const startRef = useRef<() => Promise<void>>(async () => {});

  /* The engine's report on the kept scan. It runs on the server, so it goes on when the view closes; the kept scan carries it back. */
  const takeExplain = useCallback((explain: DiskExplain | undefined) => setReport((cur) => (cur ? { ...cur, explain } : cur)), []);
  const startReport = useCallback(async () => {
    setReportError(null);
    try {
      const r = await api.machineDiskExplain();
      if (!r.ok) { if (alive.current) setReportError(r.error ?? "The report did not start."); return; }
      const k = await api.machineDiskCleanKept();
      if (alive.current && k.report) takeExplain(k.report.explain);
    } catch (e) { if (alive.current) setReportError(e instanceof Error ? e.message : String(e)); }
  }, [takeExplain]);
  const cancelReport = useCallback(async () => {
    takeExplain(undefined);
    try { await api.machineDiskExplainCancel(); } catch { /* the turn ends by itself at its time limit */ }
  }, [takeExplain]);
    /* Only while a report is being written: ask the kept scan for it every 2 s, and stop the moment it is not running. */
  /* The report's progress arrives as a socket frame (disk-explain); it is re-read when told, and once on mount above. */
  useEffect(() => onDiskExplainChanged(() => {
    void api.machineDiskCleanKept().then((k) => {
      if (!alive.current) return;
      setServerScan(k.scanning === true);
      if (!k.report) return;
      // A scan that ended while no press of ours was waiting for it: show what it found.
      if (!k.scanning && !ownRef.current) { setReport(k.report); publishDiskMounts("scan", k.report.mounts); } else takeExplain(k.report.explain);
    }).catch(() => { /* the next frame asks again */ });
  }), [takeExplain]);

  /* An agent's staged plan: copied into state the moment there is one (the
     mailbox forgets after a minute) and measured against the scan on screen.
     With no scan yet, the cached one is fetched first: staging is not a reason
     to walk the disk. */
  /* On open, the scan the server kept (it lives there, so a reload or a second
     window sees it too). Asked once, never starts a scan, and never replaces a
     scan the person started meanwhile. */
  useEffect(() => {
    void api.machineDiskCleanKept().then((k) => {
      applyKept(k);
      if (!alive.current) return;
      setServerScan(k.scanning === true);
      setPeekSpace(k.space ?? null);
      if (!k.report) return;
      setReport((cur) => cur ?? k.report);
      publishDiskMounts("scan", k.report.mounts);
      // The mockup's report starts by itself, ONCE per scan: a kept scan that has none yet gets it the first time, never again after a cancel or a failure.
      if (!k.scanning && !k.report.explain && k.report.lines.length && claimAutoReport(k.report.at)) void startRef.current();
    }).catch(() => { /* no kept scan to show: the button still scans */ });
  }, []);

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

  /* The header chip names the plan on screen, and only that: while a scan runs,
     fails, or has just cleaned, no plan is visible and none is named. */
  useEffect(() => { publishDiskPlan(phase === "plan" ? view.plan : null); }, [phase, view.plan]);
  useEffect(() => () => publishDiskPlan(null), []);

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
  const stale = report?.staleWhy ?? null;
  const canClean = phase === "plan" && target.ids.length > 0 && !running && !stale;
  const groups = useMemo(() => groupsOf(report?.lines ?? []), [report]);
  const [showInfo, setShowInfo] = useState(false);
  startRef.current = startReport;
  const explain = report?.explain;
  const rg = useMemo(() => (explain?.status === "ready" ? reportGroups(report?.lines ?? [], explain) : null), [report, explain]);

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
  const row = (l: DiskCleanLine, ex?: DiskExplainItem) => (
    <LineRow key={l.id} l={l} ex={ex} many={(report?.mounts.length ?? 0) > 1} marked={view.stagedPlan?.ids.includes(l.id) ?? false}
      armed={armed === l.id} busy={running} onArm={() => setArmed(l.id)} onKeep={() => setArmed(null)} onRun={() => void run([l.id])}
      onAsk={() => { if (report) void askDir().then((dir) => (dir ? askAbout(dir, diskSeed(report, { on: l.label })) : { ok: false as const, error: "no project folder is known" })).then((d) => setAskSaid(sentNote(d, l.label).text)); }} />
  );

  const reclaim = phase === "plan" ? reclaimHeadline(view.plan) : null;
  const diskLine = diskHeadline(disk);
  const lead = reclaim ?? diskLine ?? "Disk cleanup";
  const ago = scannedAgo(report, Date.now());
  const sub = phase === "plan"
    ? `${ago ? `${ago} · ` : ""}${view.plan.ids.length} item${view.plan.ids.length === 1 ? "" : "s"} · ${diskLine ?? "the scan is on screen"}`
    : phase === "error" ? "The scan did not finish."
    : phase === "empty" ? `${ago ? `${ago} · ` : ""}Nothing safe to remove right now.`
    : phase === "done" ? "What the clean did, per item and per disk."
    : "Nothing is scanned until you ask; the scan only reads and nothing is removed.";

  return (
    <section id="disk-clean" aria-label="Disk cleanup" className="mc-dc">
      <div className="mc-dc-h">
        <span className="mc-dc-ic"><DiskIcon size={ICON.md} /></span>
        <div className="mc-dc-hd">
          <span className="mc-dc-k">Disk cleanup</span>
          <b className="mc-dc-n" data-big={reclaim ? true : undefined}>{lead}</b>
          {phase !== "scanning" && <span className="mc-dc-sub">{sub}</span>}
        </div>
        {(() => { const sp = badgeSpace(peekSpace, report?.space); return sp && <span className="mc-fine" data-space={sp.state} role="status">{fmtBytes(sp.free)} free</span>; })()}
        {running && <span className="mc-fine" role="status">Removing…</span>}
        {report && <AskAboutButton what="The disk report" disabled={scanning || running} onSaid={(_ok, text) => setAskSaid(text)}
          cwd={askDir}
          seed={() => diskSeed(report)} />}
        <Button size="hit" tone="primary" disabled={scanning || running} title="Look at what is on the disks. Reads only; nothing is removed." onClick={() => void scan(true)}>
          {scanning ? <><span className="mc-spin"><RefreshIcon size={ICON.sm} /></span>Scanning…</> : <><RefreshIcon size={ICON.sm} />{report || error ? "Scan again" : "Scan for what can go"}</>}
        </Button>
      </div>

      {askSaid && <div className="mc-fine" role="status">{askSaid}</div>}
      {phase === "scanning" && (
        <div className="mc-fine" role="status">{reading ? `Reading ${reading}…` : "Looking at Docker, checkouts, caches and the trash…"}
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
          {stale && (
            <div className="mc-note" role="status" style={{ "--tint": "var(--warning)", margin: 0 } as CSSProperties}>
              <WarningIcon size={ICON.sm} /><span>{stale}</span>
            </div>
          )}
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
          <ReportNote explain={explain} error={reportError} hasItems={report.lines.length > 0} onCancel={() => void cancelReport()} onRetry={() => void startReport()} />
          {rg ? (
            <>
              {rg.safe.rows.length > 0 && (
                <PlanGroup icon={<DoneIcon size={ICON.md} />} hue="var(--success)" title="Safe" hint="nothing uses it; it comes back" tip={VERDICT.safe.title} bytes={rg.safe.bytes} action={cleanButton || undefined}>
                  {rg.safe.rows.map((x) => row(x.line, x.item))}
                </PlanGroup>
              )}
              {rg.check.rows.length > 0 && (
                <PlanGroup icon={<EyeIcon size={ICON.md} />} hue="var(--warning)" title="Check first" hint="look before you decide" tip={VERDICT.ask.title} bytes={rg.check.bytes}>
                  {rg.check.rows.map((x) => row(x.line, x.item))}
                </PlanGroup>
              )}
              {rg.keep.rows.length > 0 && (
                <PlanGroup icon={<LockIcon size={ICON.md} />} hue="var(--text3)" title="Keep" hint="in use, or costly to lose" tip={VERDICT.inuse.title} bytes={rg.keep.bytes}>
                  {rg.keep.rows.map((x) => row(x.line, x.item))}
                </PlanGroup>
              )}
              {rg.rest.length > 0 && (
                <PlanGroup icon={<LockIcon size={ICON.md} />} hue="var(--text3)" title="Not in the report" hint="shown so the numbers add up" tip={VERDICT.explain.title}
                  bytes={rg.rest.reduce((n, l) => n + (l.bytes ?? 0), 0)} fold={!showInfo}
                  action={<Button size="compact" tone="quiet" aria-expanded={showInfo} onClick={() => setShowInfo((v) => !v)}>{showInfo ? "Hide" : "Show"}</Button>}>
                  {showInfo && rg.rest.map((l) => row(l))}
                </PlanGroup>
              )}
            </>
          ) : (
            <>
              {groups.safe.lines.length > 0 && (
                <PlanGroup icon={<DoneIcon size={ICON.md} />} hue="var(--success)" title="Safe" hint="come back by themselves; no sudo" tip={VERDICT.safe.title} bytes={groups.safe.bytes} action={cleanButton || undefined}>
                  {groups.safe.lines.map((l) => row(l))}
                </PlanGroup>
              )}
              {groups.ask.lines.length > 0 && (
                <PlanGroup icon={<EyeIcon size={ICON.md} />} hue="var(--warning)" title="Look first" hint="not in the plan: you decide" tip={VERDICT.ask.title} bytes={groups.ask.bytes}>
                  {groups.ask.lines.map((l) => row(l))}
                </PlanGroup>
              )}
              {groups.info.lines.length > 0 && (
                <PlanGroup icon={<LockIcon size={ICON.md} />} hue="var(--text3)" title="In use and for information" hint="stays; shown so the numbers add up" tip={`${VERDICT.inuse.title} ${VERDICT.explain.title}`}
                  bytes={groups.info.bytes} fold={!showInfo}
                  action={<Button size="compact" tone="quiet" aria-expanded={showInfo} onClick={() => setShowInfo((v) => !v)}>{showInfo ? "Hide" : "Show"}</Button>}>
                  {showInfo && groups.info.lines.map((l) => row(l))}
                </PlanGroup>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** The report's own state: running (progress, cancel, the estimate), failed (one line and a retry), or ready (what it cost). Never blank. */
function ReportNote({ explain, error, hasItems, onCancel, onRetry }: { explain: DiskExplain | undefined; error: string | null; hasItems: boolean; onCancel: () => void; onRetry: () => void }) {
  if (explain?.status === "running") {
    return (
      <div className="mc-note" role="status" style={{ "--tint": "var(--primary)", margin: 0 } as CSSProperties}>
        <span className="mc-spin"><RefreshIcon size={ICON.sm} /></span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <b>Report running in the background.</b> Claude reads the scan's names and sizes (never file contents) and says what each item is. You can keep cleaning meanwhile.
          <span className="mc-ind"><i /></span>
          <span className="mc-fine">{explainEstimate(explain)}</span>
        </span>
        <Button size="compact" tone="quiet" onClick={onCancel}>Cancel report</Button>
      </div>
    );
  }
  const failed = explain?.status === "error" ? explain.error ?? "The report failed." : error;
  if (failed) {
    return (
      <div className="mc-note" role="alert" style={{ "--tint": "var(--warning)", margin: 0 } as CSSProperties}>
        <WarningIcon size={ICON.sm} /><span style={{ minWidth: 0, flex: 1 }}>{failed} The scan below is unchanged.</span>
        <Button size="compact" onClick={onRetry}>Retry report</Button>
      </div>
    );
  }
  if (explain?.status === "ready") {
    const spent = explainSpent(explain);
    return <div className="mc-fine">Report written by Claude from names and sizes only · {explain.count} item{explain.count === 1 ? "" : "s"}{spent ? ` · ${spent}` : ""}. Nothing was removed.</div>;
  }
  /* The report starts by itself once per scan; when there is none (cancelled, failed, or already tried) say so and let the person start it. */
  if (hasItems) {
    return (
      <div className="mc-note" role="status" style={{ "--tint": "var(--primary)", margin: 0 } as CSSProperties}>
        <span style={{ minWidth: 0, flex: 1 }}><b>No report yet.</b> Claude can read the scan's names and sizes (never file contents) and say what each item is and whether it is safe, check or keep.</span>
        <Button size="compact" onClick={onRetry}>Write report</Button>
      </div>
    );
  }
  return null;
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

function LineRow({ l, ex, many, marked, armed, busy, onArm, onKeep, onRun, onAsk }: {
  l: DiskCleanLine; ex?: DiskExplainItem; many: boolean; marked: boolean; armed: boolean; busy: boolean; onArm: () => void; onKeep: () => void; onRun: () => void; onAsk: () => void;
}) {
  return (
    <div className="mc-vr" data-line={l.id} data-arm={armed || undefined} data-staged={marked || undefined}>
      <div className="a" title={`${l.label} — ${ex ? `${ex.why} ${ex.regen}` : l.why}`}>
        {l.label}
        {many && <i>on {l.mount}</i>}
        {marked && <i data-staged>staged</i>}
        <small>{ex ? ex.why : l.why}</small>
        {ex?.regen && <small>Comes back: {ex.regen}</small>}
        {l.bytes === null && l.sizeCommand && <small>Run to see the size: <code>{l.sizeCommand}</code></small>}
      </div>
      <span className={`s${l.bytes === null ? " root" : ""}`}>{l.bytes === null ? "size needs root" : fmtBytes(l.bytes)}</span>
      <span className="sl">
        <Button size="compact" square tone="quiet" label={`Ask about ${l.label}`} title="Open a new terminal tab with the scan, asking about this item." onClick={onAsk}><SparkleIcon size={ICON.sm} /></Button>
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
