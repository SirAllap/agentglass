import { useMemo, useState } from "react";
import { GitDialog, DialogSkeleton } from "./GitDialog.tsx";
import { BranchStrip } from "./git/BranchStrip.tsx";
import { Switch } from "./SettingRow.tsx";
import { Checkbox, EDGE, INPUT, INPUT_STYLE, Textarea } from "./workspace/Chrome.tsx";
import { CommitIcon, UndoIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { commitPlan, commitTitle, filterFiles, splitPath, statusCounts, statusLetter, subjectMeter, type CommitFile, type StatusLetter } from "../lib/gitCommitModal.ts";

const MONO = "var(--font-mono, ui-monospace, monospace)";
const TINT: Record<StatusLetter, string> = { M: "var(--warning)", A: "var(--success)", D: "var(--error)", R: "var(--primary)" };
const WORD: Record<StatusLetter, string> = { M: "modified", A: "added", D: "deleted", R: "renamed" };

/** At 20 files and more the strip becomes this: one square per file, a letter and a count beside the colours. */
function StatusMap({ files, branch, n, additions, deletions }: { files: CommitFile[]; branch: string; n: number; additions: number; deletions: number }) {
  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-col gap-2" style={{ background: "var(--surface-inset)", border: EDGE }} data-status-map="">
      <div className="flex gap-3 items-start">
        <div className="flex flex-wrap gap-0.5 flex-1 min-w-0" aria-hidden>
          {files.map((f) => <span key={f.path} style={{ width: 9, height: 9, borderRadius: 2, background: TINT[statusLetter(f.status)], opacity: 0.8 }} />)}
        </div>
        <div className="shrink-0 flex flex-col text-[11px]" style={{ fontFamily: MONO, color: "var(--text2)" }}>
          {statusCounts(files).map(({ letter, n: k }) => <span key={letter}><b style={{ color: TINT[letter] }}>{letter}</b> {k} {WORD[letter]}</span>)}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] min-w-0" style={{ fontFamily: MONO, color: "var(--text3)" }}>
        <span className="truncate" data-tip={branch}>{branch}</span><span className="flex-1" />
        <span className="shrink-0">{n} files <span style={{ color: "var(--success-ink, var(--success))" }}>+{additions}</span> <span style={{ color: "var(--error-ink)" }}>−{deletions}</span></span>
      </div>
    </div>
  );
}

const LEVEL = { ok: "var(--text3)", warn: "var(--warning)", over: "var(--error)" } as const;

/** The ring that fills to the limit; the number beside it says the same thing. */
function Ring({ fill, level }: { fill: number; level: keyof typeof LEVEL }) {
  const r = 7, c = 2 * Math.PI * r;
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
      <circle cx={9} cy={9} r={r} fill="none" stroke="var(--border)" strokeWidth={2} />
      <circle cx={9} cy={9} r={r} fill="none" stroke={LEVEL[level]} strokeWidth={2} strokeDasharray={`${c * fill} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Commit these files. What the panel's inline box opens when more than a line
 * is wanted: the strip shows where the commit lands, the staged list can be
 * trimmed, and the fold toggle rewrites the last commit while it is unpushed.
 */
export function CommitModal(p: {
  branch: string;
  /** Commits ahead of the upstream; null when there is none. */
  ahead: number | null;
  files: CommitFile[];
  initialSubject?: string;
  initialBody?: string;
  busy?: boolean;
  error?: string | null;
  /** The staged list is still being read: the strip and rows are drawn as grey shapes. */
  loading?: boolean;
  /** Changes that are not staged. With `onStageAll`, an empty dialog offers "Stage all N changes". */
  unstagedCount?: number;
  onStageAll?: () => void;
  onClose: () => void;
  /** `paths` are the ticked files, `fold` rewrites the last commit. */
  onCommit: (a: { paths: string[]; subject: string; body: string; fold: boolean }) => void;
}) {
  const [subject, setSubject] = useState(p.initialSubject ?? "");
  const [body, setBody] = useState(p.initialBody ?? "");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [fold, setFold] = useState(false);
  const [openList, setOpenList] = useState(p.files.length <= 6 || p.files.length >= 20);
  const [q, setQ] = useState("");
  const shown = useMemo(() => filterFiles(p.files, q), [p.files, q]);
  const plan = useMemo(() => commitPlan({ files: p.files, off, subject, fold, ahead: p.ahead }), [p.files, off, subject, fold, p.ahead]);
  const meter = subjectMeter(subject);
  const folding = fold && plan.canFold;
  const n = plan.paths.length;
  const toggle = (path: string, on: boolean) => setOff((s) => { const t = new Set(s); if (on) t.delete(path); else t.add(path); return t; });

  return (
    <GitDialog
      title={commitTitle(n, folding)}
      tone={folding ? "warn" : "neutral"}
      icon={<CommitIcon size={ICON.lg} />}
      subtitle={folding
        ? <>The last commit is rewritten. It is not pushed, so nobody else has it.</>
        : <>They land on <b>{p.branch}</b>{p.ahead ? <>, which is {p.ahead} ahead of origin</> : null}.</>}
      reason={p.loading ? "Reading…" : p.error ? `${p.error} Your message is kept.` : (plan.reason || <><b>{n} file{n === 1 ? "" : "s"}</b> → {p.branch}</>)}
      confirmLabel={plan.actionLabel}
      confirmIcon={folding ? <UndoIcon size={ICON.xs} /> : <CommitIcon size={ICON.xs} />}
      confirmDisabled={!plan.ok || p.busy || p.loading}
      initialFocus="input"
      onConfirm={() => p.onCommit({ paths: plan.paths, subject: subject.trim(), body, fold: folding })}
      onClose={p.onClose}
      locked={p.busy}
      width={600}
    >
      {p.loading ? (
        <>
          <div className="rounded-lg motion-safe:animate-pulse" style={{ height: 74, background: "var(--surface-inset)", border: EDGE }} aria-hidden />
          <DialogSkeleton rows={2} label="Reading the working tree…" />
        </>
      ) : p.files.length === 0 ? (
        <>
          <BranchStrip tone="primary" slot ahead={p.ahead ?? 0} branch={p.branch} files={0} />
          <div className="rounded-lg px-3 py-3 text-[12px]" style={{ border: "1px dashed var(--border)", color: "var(--text2)" }} data-empty="">
            Nothing is staged yet. Stage the files you want in this commit, then come back.
            {p.onStageAll && !!p.unstagedCount && (
              <div className="mt-2">
                <button type="button" onClick={p.onStageAll} className="text-[12px] px-3 rounded-lg font-medium" style={{ height: 28, color: "var(--text)", border: EDGE, background: "var(--surface-card)" }}>Stage all {p.unstagedCount} change{p.unstagedCount === 1 ? "" : "s"}</button>
              </div>
            )}
          </div>
        </>
      ) : plan.statusMap ? (
        <StatusMap files={p.files} branch={p.branch} n={n} additions={plan.additions} deletions={plan.deletions} />
      ) : <BranchStrip tone={folding ? "warn" : "primary"} ahead={p.ahead ?? 0} hollow={folding} landing={folding ? "replaces HEAD" : "this commit"}
        branch={p.branch} files={n} additions={plan.additions} deletions={plan.deletions} />}

      <div>
        <div className="flex items-center justify-between mb-1 text-[11px]" style={{ color: "var(--text3)" }}>
          <label htmlFor="commit-subject" className="font-semibold">Subject</label>
          <span className="inline-flex items-center gap-1.5" style={{ fontFamily: MONO, color: LEVEL[meter.level] }}>
            <Ring fill={meter.fill} level={meter.level} />{meter.label}
          </span>
        </div>
        <input id="commit-subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={`w-full ${INPUT}`}
          style={{ ...INPUT_STYLE, fontFamily: MONO, ...(meter.level === "over" ? { borderColor: "var(--error)" } : null) }}
          placeholder="What changed, in one line" />
        {meter.hint && <div className="mt-1 text-[11.5px]" style={{ color: "var(--error-ink)" }}>{meter.hint}</div>}
      </div>
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Why, if it needs saying (optional)…" className="agx-scroll w-full !min-h-0 resize-none" />

      <div className="rounded-lg" style={{ border: EDGE, background: "var(--surface-card)" }}>
        <button type="button" aria-expanded={openList} onClick={() => setOpenList((o) => !o)}
          className="w-full flex items-center gap-2 px-3 text-left text-[12px] font-semibold" style={{ height: 36, color: "var(--text)" }}>
          <span aria-hidden style={{ display: "inline-block", transform: openList ? "rotate(90deg)" : undefined, color: "var(--text3)" }}>›</span>
          {p.files.length} staged file{p.files.length === 1 ? "" : "s"}
          <span className="flex-1" />
          <span style={{ fontFamily: MONO, color: "var(--text3)", fontWeight: 400 }}>+{plan.additions} −{plan.deletions}</span>
        </button>
        {openList && plan.statusMap && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${p.files.length} files…`} aria-label="Filter files"
            className={`mx-3 mb-2 ${INPUT}`} style={{ ...INPUT_STYLE, width: "calc(100% - 24px)", fontFamily: MONO }} />
        )}
        {openList && shown.length === 0 && <div className="px-3 pb-2 text-[11.5px]" style={{ color: "var(--text3)" }}>No file matches “{q}”.</div>}
        {openList && (
          <ul className="m-0 p-0 list-none px-3 pb-2 flex flex-col max-h-[220px] overflow-y-auto agx-scroll">
            {shown.map((f) => {
              const { dir, name } = splitPath(f.path);
              return (
                <li key={f.path} className="flex items-center gap-2 text-[11.5px]" style={{ minHeight: 28, fontFamily: MONO }}>
                  <span className="shrink-0 grid place-items-center rounded font-semibold text-[10px]" data-status-badge={statusLetter(f.status)} aria-hidden
                    style={{ width: 16, height: 16, color: TINT[statusLetter(f.status)], background: `color-mix(in srgb, ${TINT[statusLetter(f.status)]} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${TINT[statusLetter(f.status)]} 40%, transparent)` }}>{statusLetter(f.status)}</span>
                  <Checkbox checked={!off.has(f.path)} onChange={(on) => toggle(f.path, on)}>
                    <span className="truncate"><span style={{ color: "var(--text3)" }}>{dir}</span><span style={{ color: "var(--text)" }}>{name}</span></span>
                  </Checkbox>
                  <span className="flex-1" />
                  <span style={{ color: "var(--text3)" }}>+{f.additions} −{f.deletions}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {folding && (
        <div className="rounded-lg px-3 py-2.5 flex items-start gap-2 text-[12px] leading-snug" role="status" data-fold-note=""
          style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--warning) 35%, transparent)", color: "var(--warning-ink)" }}>
          <UndoIcon size={ICON.sm} />
          <span>The last dot is redrawn hollow: the last commit is replaced by a new commit with these {n} file{n === 1 ? "" : "s"} added. It is safe because origin does not have it.</span>
        </div>
      )}
      <div className="rounded-lg px-3 flex items-center gap-2 text-[12px]" style={{ border: EDGE, background: "var(--surface-card)", minHeight: 40, color: "var(--text2)" }}>
        <span aria-hidden style={{ color: "var(--text3)" }}><UndoIcon size={ICON.sm} /></span>
        <span className="flex-1 min-w-0"><b style={{ color: "var(--text)" }}>Fold into the last commit instead</b>{folding ? "" : <> — {plan.foldNote}</>}</span>
        <button type="button" role="switch" aria-checked={fold && plan.canFold} aria-label="Fold into the last commit instead" disabled={!plan.canFold}
          onClick={() => setFold((v) => !v)} className="shrink-0 bg-transparent border-0 p-0 disabled:opacity-50" style={{ cursor: plan.canFold ? "pointer" : "default" }}>
          <Switch on={fold && plan.canFold} />
        </button>
      </div>
    </GitDialog>
  );
}
