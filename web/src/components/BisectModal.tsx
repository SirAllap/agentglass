/*
 * Guided bisect — walk `git bisect` one candidate at a time: start (bad/good
 * endpoints), then mark the checked-out candidate good/bad until git converges
 * on the first bad commit. Reset abandons or clears the session. Read-only
 * surface over a bisecting checkout; every button is a mutation under guard.
 */
import { useEffect, useState } from "react";
import { GitDialog, DialogError, DialogSkeleton } from "./GitDialog.tsx";
import { UNREACHABLE } from "../lib/gitDialog.ts";
import { api } from "../lib/api.ts";
import type { GitBisectStatus } from "../../../shared/types.ts";
import { CrossIcon, DoneIcon, IconLabel } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { INPUT, INPUT_STYLE, EDGE } from "./workspace/Chrome.tsx";

export function BisectModal({ root, initialGood, onClose, onReset, onOpenCommit, onChanged }: {
  root: string;
  /** "Find the bad commit from here": this commit is where it was still fine. */
  initialGood?: string;
  onClose: () => void;
  onReset: () => void;
  onOpenCommit: (hash: string, subject: string) => void;
  onChanged: (message?: string) => void;
}) {
  const [st, setSt] = useState<GitBisectStatus | null>(null);
  const [bad, setBad] = useState("");
  const [good, setGood] = useState(initialGood ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setSt(await api.gitBisectStatus(root)); } catch { setError(UNREACHABLE); }
  };
  useEffect(() => { void refresh(); }, [root]);

  const mark = async (m: "good" | "bad") => {
    setBusy(true); setError("");
    const r = await api.gitBisectMark(root, m);
    setBusy(false);
    if (!r.ok) { setError(r.error || `could not mark ${m}`); return; }
    onChanged(`Marked ${m}`);
    await refresh();
  };
  const start = async () => {
    setBusy(true); setError("");
    const r = await api.gitBisectStart(root, bad.trim(), good.trim());
    setBusy(false);
    if (!r.ok) { setError(r.error || "could not start bisect"); return; }
    setBad(""); setGood("");
    onChanged("Bisect started");
    await refresh();
  };
  const reset = async () => {
    setBusy(true); setError("");
    const r = await api.gitBisectReset(root);
    setBusy(false);
    if (!r.ok) { setError(r.error || "could not reset bisect"); return; }
    onChanged("Bisect ended");
    onReset();
  };

  const running = st?.bisecting && !st.firstBad;
  const done = st?.bisecting && !!st.firstBad;

  const title = running ? "Does the bug reproduce here?" : done ? "Found the first bad commit" : "Find the bad commit?";
  const subtitle = running
    ? (st?.remaining != null ? `${st.remaining} revision${st.remaining === 1 ? "" : "s"} left to test${st.steps != null ? `, roughly ${st.steps} step${st.steps === 1 ? "" : "s"}` : ""}.` : "Test the checked-out commit and say good or bad.")
    : done ? "This commit introduced the bug."
    : "Name a commit with the bug and one where it was still fine. Git narrows the rest down.";
  const ready = !!bad.trim() && !!good.trim();
  const idle = !!st && !st.bisecting;
  return (
    <GitDialog title={title} subtitle={subtitle} tone={done ? "danger" : "primary"} width={520}
      cancelLabel="Close" locked={busy} onClose={onClose}
      confirmLabel={busy ? "Starting…" : "Start bisect"} onConfirm={idle ? () => void start() : undefined} confirmDisabled={!ready || busy}
      reason={idle ? (ready ? "Press Start bisect to check out the first candidate." : "Fill in both commits first.") : running ? "Abort puts the checkout back as it was." : undefined}
      initialFocus={idle ? "input" : "none"}
    >
      {error && <DialogError message={error} onRetry={st ? undefined : () => { setError(""); void refresh(); }} />}

      {running && st.current && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg" style={{ background: "var(--surface-inset)", border: EDGE }}>
            <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--info-ink)" }}>{st.current.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px]" title={st.current.subject} style={{ color: "var(--text)" }}>{st.current.subject}</span>
            <button onClick={() => onOpenCommit(st.current!.sha, st.current!.subject)} className="shrink-0 text-[10px] px-2 py-1 rounded-md" style={{ color: "var(--text2)", border: EDGE }}>view</button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void mark("good")} disabled={busy} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--success) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)", color: "var(--success-ink)", opacity: busy ? .5 : 1 }}><IconLabel icon={<DoneIcon size={ICON.xs} />}>good — bug gone</IconLabel></button>
            <button onClick={() => void mark("bad")} disabled={busy} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)", color: "var(--error-ink)", opacity: busy ? .5 : 1 }}><IconLabel icon={<CrossIcon size={ICON.xs} />}>bad — bug here</IconLabel></button>
          </div>
          <div className="flex justify-end">
            <button onClick={() => void reset()} disabled={busy} className="text-[10.5px] px-2 py-1 rounded-md" style={{ color: "var(--text3)" }}>abort bisect</button>
          </div>
        </div>
      )}

      {done && st.firstBad && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
            <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--error-ink)" }}>{st.firstBad.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px]" title={st.firstBad.subject} style={{ color: "var(--text)" }}>{st.firstBad.subject}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onOpenCommit(st.firstBad!.sha, st.firstBad!.subject)} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)" }}>view diff</button>
            <button onClick={() => void reset()} disabled={busy} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ border: EDGE, color: "var(--text2)", opacity: busy ? .5 : 1 }}>finish (reset)</button>
          </div>
        </div>
      )}

      {idle && (
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={bad} onChange={(e) => setBad(e.target.value)} placeholder="bad commit (ref or sha)" aria-label="Bad commit" className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
          <input value={good} onChange={(e) => setGood(e.target.value)} placeholder="good commit" aria-label="Good commit" className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
        </div>
      )}

      {st && !st.ok && <div className="text-[11px] t-dim2">status: {st.error}</div>}
      {!st && !error && <DialogSkeleton rows={2} label="Reading bisect state…" />}
    </GitDialog>
  );
}
