/*
 * Guided bisect — walk `git bisect` one candidate at a time: start (bad/good
 * endpoints), then mark the checked-out candidate good/bad until git converges
 * on the first bad commit. Reset abandons or clears the session. Read-only
 * surface over a bisecting checkout; every button is a mutation under guard.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api } from "../lib/api.ts";
import type { GitBisectStatus } from "../../../shared/types.ts";

export function BisectModal({ root, onClose, onReset, onOpenCommit, onChanged }: {
  root: string;
  onClose: () => void;
  onReset: () => void;
  onOpenCommit: (hash: string, subject: string) => void;
  onChanged: () => void;
}) {
  const [st, setSt] = useState<GitBisectStatus | null>(null);
  const [bad, setBad] = useState("");
  const [good, setGood] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setSt(await api.gitBisectStatus(root)); } catch (e) { setError(String(e)); }
  };
  useEffect(() => { void refresh(); }, [root]);

  const mark = async (m: "good" | "bad") => {
    setBusy(true); setError("");
    const r = await api.gitBisectMark(root, m);
    setBusy(false);
    if (!r.ok) { setError(r.error || `could not mark ${m}`); return; }
    onChanged();
    await refresh();
  };
  const start = async () => {
    setBusy(true); setError("");
    const r = await api.gitBisectStart(root, bad.trim(), good.trim());
    setBusy(false);
    if (!r.ok) { setError(r.error || "could not start bisect"); return; }
    setBad(""); setGood("");
    onChanged();
    await refresh();
  };
  const reset = async () => {
    setBusy(true); setError("");
    const r = await api.gitBisectReset(root);
    setBusy(false);
    if (!r.ok) { setError(r.error || "could not reset bisect"); return; }
    onChanged();
    onReset();
  };

  const running = st?.bisecting && !st.firstBad;
  const done = st?.bisecting && !!st.firstBad;

  return (
    <Portal>
      <AnimatePresence>
        <motion.div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "color-mix(in srgb, #000 45%, transparent)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            className="relative w-full max-w-lg rounded-2xl p-5"
            style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 24px 80px rgba(0,0,0,.5)" }}
            initial={{ opacity: 0, scale: .97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .97, y: 8 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>git bisect</h3>
              {st?.bisecting && <span className="shrink-0 rounded px-1.5 py-px text-[9.5px] font-mono" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>active</span>}
              <CloseButton onClick={onClose} />
            </div>

            {error && <div className="mb-3 text-[11px] px-3 py-2 rounded-lg" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)" }}>{error}</div>}

            {running && st.current && (
              <div className="space-y-4">
                <div className="text-[10.5px] t-dim2">
                  {st.remaining != null && <span>{st.remaining} revision{st.remaining === 1 ? "" : "s"} left to test{st.steps != null ? <> · roughly {st.steps} step{st.steps === 1 ? "" : "s"}</> : ""}</span>}
                  <span className="ml-2"> — does the bug reproduce at this commit?</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                  <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--info)" }}>{st.current.sha.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{st.current.subject}</span>
                  <button onClick={() => onOpenCommit(st.current!.sha, st.current!.subject)} className="shrink-0 text-[10px] px-2 py-1 rounded-md" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>view</button>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void mark("good")} disabled={busy} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--success) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)", color: "var(--success)", opacity: busy ? .5 : 1 }}>✓ good — bug gone</button>
                  <button onClick={() => void mark("bad")} disabled={busy} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)", color: "var(--error)", opacity: busy ? .5 : 1 }}>✕ bad — bug here</button>
                </div>
                <div className="flex justify-end">
                  <button onClick={() => void reset()} disabled={busy} className="text-[10px] px-2 py-1 rounded-md" style={{ color: "var(--text3)" }}>abort bisect</button>
                </div>
              </div>
            )}

            {done && st.firstBad && (
              <div className="space-y-4">
                <div className="text-[10.5px] t-dim2">found it — this commit introduced the bug:</div>
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
                  <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--error)" }}>{st.firstBad.sha.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{st.firstBad.subject}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => onOpenCommit(st.firstBad!.sha, st.firstBad!.subject)} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)" }}>view diff</button>
                  <button onClick={() => void reset()} disabled={busy} className="flex-1 text-[11.5px] font-medium py-2 rounded-lg" style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text2)", opacity: busy ? .5 : 1 }}>finish (reset)</button>
                </div>
              </div>
            )}

            {!st?.bisecting && (
              <div className="space-y-3">
                <div className="text-[10.5px] t-dim2">No bisect in progress — start one with a known-bad and a known-good commit.</div>
                <div className="flex gap-2">
                  <input value={bad} onChange={(e) => setBad(e.target.value)} placeholder="bad commit (ref or sha)" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                  <input value={good} onChange={(e) => setGood(e.target.value)} placeholder="good commit" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                </div>
                <button onClick={() => void start()} disabled={busy || !bad.trim() || !good.trim()} className="w-full text-[11.5px] font-medium py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: busy || !bad.trim() || !good.trim() ? .5 : 1 }}>start bisect</button>
              </div>
            )}

            {st && !st.ok && <div className="text-[11px] t-dim2">status: {st.error}</div>}
            {!st && !error && <div className="text-[11px] t-dim2 py-6 text-center">Reading bisect state…</div>}
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </Portal>
  );
}
