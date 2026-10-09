import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { NoteStatus, PluginPrNotes, PrNote, PrRun } from "../../lib/pluginTypes.ts";
import { subscribePluginFrame } from "../../lib/pluginBus.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { ago } from "../../lib/fileRecents.ts";
import { Spinner } from "../Spinner.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";

/**
 * Notes plugins wrote on a pull request, drawn inside the pull request.
 *
 * They sit beside GitHub's own threads and are never mistaken for them: every
 * one carries a "local" mark, a different edge, and no Reply, because there
 * is nobody on the other end. Nothing here can send anything to GitHub. What
 * the person can do is decide — resolve, dismiss, reopen — and copy a note as
 * markdown if they choose to say it out loud somewhere themselves.
 */

export type LocalRun = PrRun & { plugin: string };
export type LocalNote = PrNote & { plugin: string };

export interface LocalNotes {
  runs: LocalRun[];
  notes: LocalNote[];
  publishers: Record<string, string>;
  setStatus: (n: LocalNote, s: NoteStatus) => Promise<void>;
}

const EMPTY: PluginPrNotes = { ok: true, runs: [], notes: [], publishers: {} };

/**
 * The notes for one pull request, kept current. Opening the pull request is
 * also told to the plugins that write notes, so a reviewer can offer to look
 * at what the person is reading without polling GitHub for it.
 */
export function useLocalNotes(repo: string | undefined, number: number | null | undefined): LocalNotes {
  const [data, setData] = useState<PluginPrNotes>(EMPTY);
  // Only the latest request may land: switching pull requests quickly let an
  // earlier answer arrive last and show one pull request's notes on another.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!repo || !number) { setData(EMPTY); return; }
    try {
      const r = await api.pluginPrNotes(repo, number);
      if (mine === seq.current) setData(r);
    } catch { /* keep what is shown */ }
  }, [repo, number]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!repo || !number) return;
    void api.pluginPrOpen(repo, number).catch(() => {});
  }, [repo, number]);
  useEffect(() => subscribePluginFrame((f) => {
    if (f.kind === "pr" && f.repo === repo && f.number === number) void load();
  }), [repo, number, load]);
  const setStatus = useCallback(async (n: LocalNote, s: NoteStatus) => {
    // Shown at once; the server's answer arrives as a frame and replaces it.
    setData((d) => ({ ...d, notes: d.notes.map((x) => (x.plugin === n.plugin && x.id === n.id ? { ...x, status: s } : x)) }));
    await api.pluginNoteStatus(n.plugin, n.id, s).catch(() => {});
  }, []);
  return { runs: data.runs, notes: data.notes, publishers: data.publishers, setStatus };
}

const SEV: Record<PrNote["severity"], { label: string; color: string; rank: number }> = {
  critical: { label: "Critical", color: "var(--error-ink)", rank: 0 },
  high: { label: "High", color: "var(--error-ink)", rank: 1 },
  medium: { label: "Medium", color: "var(--warning-ink)", rank: 2 },
  low: { label: "Low", color: "var(--info-ink)", rank: 3 },
  idea: { label: "Idea", color: "var(--primary-ink)", rank: 4 },
  info: { label: "Info", color: "var(--text3)", rank: 5 },
};

export function sortNotes(ns: LocalNote[]): LocalNote[] {
  const open = (n: LocalNote) => (n.status === "open" ? 0 : 1);
  return [...ns].sort((a, b) => open(a) - open(b) || SEV[a.severity].rank - SEV[b.severity].rank || (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0));
}

function SevChip({ s, dim }: { s: PrNote["severity"]; dim?: boolean }) {
  const c = SEV[s].color;
  return (
    <span className="shrink-0 text-[9.5px] font-semibold px-1.5 py-px rounded uppercase tracking-wide"
      style={{ color: c, background: `color-mix(in srgb, ${c} ${dim ? 8 : 14}%, transparent)`, opacity: dim ? 0.7 : 1 }}>
      {SEV[s].label}
    </span>
  );
}

/** The padlock that says "only on this machine", as a line icon at any size:
 *  the timeline's node for a local pass, and inside the local chip. */
export function LocalGlyph({ size = ICON.xs }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function LocalMark({ title }: { title?: string }) {
  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-[9.5px] uppercase tracking-wide px-1.5 py-px rounded"
      title={title ?? "Only on this machine. Never sent to GitHub."}
      style={{ color: "var(--primary-ink)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>
      <LocalGlyph />
      local
    </span>
  );
}

function copyNote(n: LocalNote): void {
  const where = n.path ? `\`${n.path}${n.line ? `:${n.line}` : ""}\` — ` : "";
  const text = `**${SEV[n.severity].label}:** ${where}${n.title}${n.body ? `\n\n${n.body}` : ""}`;
  void navigator.clipboard?.writeText(text).catch(() => {});
}

function StatusActions({ n, onStatus }: { n: LocalNote; onStatus: (s: NoteStatus) => void }) {
  const btn = "agx-btn rounded inline-flex items-center leading-none text-[10px] px-2 h-[22px] whitespace-nowrap";
  const edge = EDGE;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {n.status === "open" ? (
        <>
          <button type="button" className={btn} style={{ border: edge, color: "var(--success-ink)" }} onClick={() => onStatus("resolved")} title="Fixed, or handled — keeps it out of the open count">Resolve</button>
          <button type="button" className={btn} style={{ border: edge, color: "var(--text3)" }} onClick={() => onStatus("dismissed")} title="Not a problem — the plugin keeps this answer on its next pass">Dismiss</button>
        </>
      ) : (
        <button type="button" className={btn} style={{ border: edge, color: "var(--text2)" }} onClick={() => onStatus("open")}>Reopen</button>
      )}
      <button type="button" className={btn} style={{ border: edge, color: "var(--text3)" }} onClick={() => copyNote(n)} title="Copy as markdown, to post it yourself if you choose to">Copy</button>
    </div>
  );
}

/** One note, full width: the Conversation's list and the diff's inline row
 *  both draw this, so a note reads the same wherever you meet it. */
/** The pull request view renders markdown its own way (a reading measure,
 *  links into the repository); it hands that renderer in so a local note
 *  reads exactly like the GitHub remark beside it. */
export type MdFn = (text: string) => React.ReactNode;
const plainMd: MdFn = (text) => <div className="agx-prose text-[12px]"><Markdown text={text} /></div>;

export function NoteCard({ n, onStatus, onOpenFile, compact, md = plainMd }: {
  n: LocalNote; onStatus: (s: NoteStatus) => void; onOpenFile?: (path: string, line?: number) => void; compact?: boolean; md?: MdFn;
}) {
  const closed = n.status !== "open";
  const [open, setOpen] = useState(!closed);
  useEffect(() => { if (closed) setOpen(false); }, [closed]);
  const c = SEV[n.severity].color;
  return (
    <div className="rounded-md min-w-0" style={{
      background: closed ? "transparent" : `color-mix(in srgb, ${c} 4%, var(--surface-card))`,
      border: EDGE, borderLeft: `3px solid ${closed ? "var(--surface-line)" : c}`,
    }}>
      {/* Wraps rather than clips: in a split diff the column is half the
          window, and a title plus four buttons does not fit on one line. The
          buttons go to the next line instead of off the edge. */}
      <div className="flex items-center gap-x-2 gap-y-1 px-2.5 py-1.5 min-w-0 flex-wrap">
        <SevChip s={n.severity} dim={closed} />
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="text-left text-[12px] font-medium min-w-[16ch] flex-1 truncate"
          style={{ color: closed ? "var(--text3)" : "var(--text)", textDecoration: n.status === "dismissed" ? "line-through" : undefined, background: "transparent", border: 0, padding: 0 }}>
          {n.title}
        </button>
        {n.path && !compact && (
          <button type="button" onClick={() => onOpenFile?.(n.path!, n.line)} disabled={!onOpenFile}
            className="t-mono text-[10.5px] truncate max-w-[34ch] hover:underline shrink min-w-0"
            style={{ color: "var(--text3)", background: "transparent", border: 0, padding: 0 }} title={`${n.path}${n.line ? `:${n.line}` : ""}`}>
            {n.path.split("/").pop()}{n.line ? `:${n.line}` : ""}
          </button>
        )}
        {closed && <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text4)" }}>{n.status}</span>}
        <StatusActions n={n} onStatus={onStatus} />
      </div>
      {open && n.body && (
        <div className="px-3 pb-2.5 pt-0.5 min-w-0">{md(n.body)}</div>
      )}
    </div>
  );
}

/**
 * A pass over the pull request, as one timeline entry: who ran it, on which
 * commit, what it concluded, and the notes it left — open ones first, worst
 * first. The notes stay in this card rather than scattering through the
 * conversation, because they were said together and are read together.
 */
export function RunCard({ run, notes, publisher, onStatus, onOpenFile, md = plainMd }: {
  run: LocalRun; notes: LocalNote[]; publisher?: string;
  onStatus: (n: LocalNote, s: NoteStatus) => void;
  onOpenFile?: (path: string, line?: number) => void;
  md?: MdFn;
}) {
  const sorted = useMemo(() => sortNotes(notes), [notes]);
  const openN = notes.filter((n) => n.status === "open").length;
  const bySev = useMemo(() => {
    const m = new Map<PrNote["severity"], number>();
    for (const n of notes) if (n.status === "open") m.set(n.severity, (m.get(n.severity) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => SEV[a[0]].rank - SEV[b[0]].rank);
  }, [notes]);
  const [showClosed, setShowClosed] = useState(false);
  const shown = showClosed ? sorted : sorted.filter((n) => n.status === "open");
  const closedN = notes.length - openN;
  const state = run.state;
  const stateColor = state === "failed" ? "var(--error)" : state === "done" ? "var(--success)" : state === "cancelled" ? "var(--text3)" : "var(--primary)";
  return (
    <div className="rounded-lg min-w-0" style={{
      background: "var(--surface-card)",
      border: "1px solid color-mix(in srgb, var(--primary) 28%, var(--surface-line))",
      boxShadow: "var(--surface-lift)",
    }}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 min-w-0 flex-wrap">
        <LocalMark />
        <span className="text-[12.5px] font-semibold truncate" style={{ color: "var(--text)" }}>{run.title}</span>
        <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: stateColor }}>
          {(state === "running" || state === "queued") && <Spinner />}
          {state}
        </span>
        <span className="flex-1" />
        {run.sha && <span className="t-mono text-[10.5px]" style={{ color: "var(--text3)" }} title={run.sha}>{run.sha.slice(0, 7)}</span>}
        <span className="text-[10.5px]" style={{ color: "var(--text4)" }} title={new Date(run.finishedAt ?? run.startedAt).toLocaleString()}>
          {ago(run.finishedAt ?? run.startedAt)}
        </span>
      </div>
      <div className="px-3 pb-2 flex items-center gap-2 flex-wrap text-[10.5px]" style={{ color: "var(--text3)" }}>
        <span title={`Plugin ${run.plugin}${publisher ? `, published by ${publisher}` : ""}`}>{run.plugin}</span>
        {run.meta && <><span style={{ color: "var(--text4)" }}>·</span><span className="truncate">{run.meta}</span></>}
        {bySev.length > 0 && <span style={{ color: "var(--text4)" }}>·</span>}
        {bySev.map(([s, n]) => (
          <span key={s} className="inline-flex items-center gap-1"><SevChip s={s} /><span className="tabular-nums">{n}</span></span>
        ))}
        {notes.length > 0 && openN === 0 && <span style={{ color: "var(--success-ink)" }}>all handled</span>}
      </div>
      {run.summary && (
        <div className="px-3 pb-2.5 min-w-0">{md(run.summary)}</div>
      )}
      {notes.length > 0 && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-1.5 min-w-0">
          {shown.map((n) => <NoteCard key={`${n.plugin}/${n.id}`} n={n} md={md} onStatus={(s) => onStatus(n, s)} onOpenFile={onOpenFile} />)}
          {closedN > 0 && (
            <button type="button" onClick={() => setShowClosed((v) => !v)}
              className="text-[10.5px] self-start px-1 hover:underline" style={{ color: "var(--text3)", background: "transparent", border: 0 }}>
              {showClosed ? "Hide" : "Show"} {closedN} resolved or dismissed
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Notes grouped the way the conversation draws them: one entry per run, and
 *  a note written without a run gets an entry of its own. */
export function groupByRun(local: LocalNotes): { run: LocalRun | null; notes: LocalNote[]; ms: number; key: string }[] {
  const out: { run: LocalRun | null; notes: LocalNote[]; ms: number; key: string }[] = [];
  const byRun = new Map<string, LocalNote[]>();
  for (const n of local.notes) {
    if (!n.runId) continue;
    const k = `${n.plugin}/${n.runId}`;
    byRun.set(k, [...(byRun.get(k) ?? []), n]);
  }
  for (const r of local.runs) {
    const k = `${r.plugin}/${r.id}`;
    out.push({ run: r, notes: byRun.get(k) ?? [], ms: safeMs(r.finishedAt ?? r.startedAt), key: `lr:${k}` });
    byRun.delete(k);
  }
  // Notes pointing at a run the plugin never described, and notes with no run.
  for (const [k, ns] of byRun) out.push({ run: null, notes: ns, ms: safeMs(Math.min(...ns.map((n) => n.createdAt))), key: `lo:${k}` });
  for (const n of local.notes) if (!n.runId) out.push({ run: null, notes: [n], ms: safeMs(n.createdAt), key: `ln:${n.plugin}/${n.id}` });
  return out;
}

/** The server refuses a time a Date cannot hold; this is the second guard,
 *  for a file written before it did — one bad number must not take the
 *  conversation down. */
function safeMs(v: number): number {
  return Number.isFinite(v) && Math.abs(v) <= 8.64e15 ? v : 0;
}

/**
 * One line on the Overview: what the plugins have made of this pull request.
 *
 * The Overview answers "can this land", and until now a local review was not
 * part of that answer — it was findings in a lane on another tab, which you
 * had to know were there. The strip is the smallest thing that puts them in
 * the answer: the latest run per plugin, what it found, and the way to read
 * it. Nothing at all when no plugin has looked, because a row saying "no
 * local review" on every pull request is a row nobody reads.
 *
 * The findings themselves stay where they are. This is a pointer, not a
 * second copy of the lane — two places showing the same notes is two places
 * that disagree the moment one is resolved.
 */
export function LocalStrip({ local, onShow }: { local: LocalNotes; onShow: () => void }) {
  const rows = useMemo(() => {
    const latest = new Map<string, LocalRun>();
    for (const r of local.runs) {
      const cur = latest.get(r.plugin);
      if (!cur || r.startedAt > cur.startedAt) latest.set(r.plugin, r);
    }
    return [...latest.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => ({
        run,
        open: local.notes.filter((n) => n.plugin === run.plugin && n.status === "open" && (!n.runId || n.runId === run.id)),
      }));
  }, [local.runs, local.notes]);
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(({ run, open }) => {
        const bySev = new Map<PrNote["severity"], number>();
        for (const n of open) bySev.set(n.severity, (bySev.get(n.severity) ?? 0) + 1);
        const running = run.state === "queued" || run.state === "running";
        const edge = run.state === "failed" ? "var(--error)" : "var(--primary)";
        return (
          <div key={`${run.plugin}/${run.id}`} className="flex items-center gap-2 rounded-lg px-3 py-2 min-w-0 flex-wrap"
            style={{ border: `1px solid color-mix(in srgb, ${edge} 32%, transparent)`, background: `color-mix(in srgb, ${edge} 7%, transparent)` }}>
            <LocalMark />
            <span className="text-[12px] truncate min-w-0" style={{ color: "var(--text)" }}>{run.title}</span>
            {running && <Spinner className="px-0 py-0" />}
            {run.state === "done" && open.length === 0 && (
              <span className="text-[9.5px] uppercase tracking-wide shrink-0" style={{ color: "var(--success-ink)" }}>nothing to fix</span>
            )}
            {[...bySev.entries()].sort((a, b) => SEV[a[0]].rank - SEV[b[0]].rank).map(([sev, n]) => (
              <span key={sev} className="shrink-0 text-[9.5px] uppercase tracking-wide px-1.5 py-px rounded tabular-nums"
                style={{ color: SEV[sev].color, background: `color-mix(in srgb, ${SEV[sev].color} 14%, transparent)` }}>
                {n} {SEV[sev].label}
              </span>
            ))}
            {run.meta && <span className="text-[10.5px] truncate shrink-0" style={{ color: "var(--text3)" }}>{run.meta}</span>}
            <span className="text-[10.5px] shrink-0 ml-auto" style={{ color: "var(--text3)" }}>{ago(safeMs(run.finishedAt ?? run.startedAt))}</span>
            <button type="button" onClick={onShow}
              className="agx-btn rounded inline-flex items-center leading-none text-[10px] px-2 h-[22px] whitespace-nowrap shrink-0"
              style={{ color: "var(--primary-ink)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}>
              {open.length ? "Show findings" : "Show the run"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
