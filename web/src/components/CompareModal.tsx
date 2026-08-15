/*
 * Compare two refs: how far ahead/behind each side is, and the diff between
 * the two tips. A pre-merge look — nothing is moved, staged or written.
 *
 * The two refs pick from the same menu (branches, tags, remotes); the swap
 * button trades them so "which side am I on" is a click, not a re-pick.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api } from "../lib/api.ts";
import type { GitFileChange } from "../../../shared/types.ts";

type CompareResult = {
  ok: boolean;
  ahead?: { hash: string; shortHash: string; subject: string; author: string; date: string; refs: string }[];
  behind?: { hash: string; shortHash: string; subject: string; author: string; date: string; refs: string }[];
  diff?: GitFileChange[];
  error?: string;
};

const CHANGE_STATUS: Record<string, string> = {
  added: "var(--success)",
  deleted: "var(--error)",
  modified: "var(--warning)",
  renamed: "var(--info)",
  untracked: "var(--text3)",
};

export function CompareModal({ root, initialBase, onClose }: {
  root: string;
  /** The ref the dialog opens on — the branch it was launched from. */
  initialBase: string;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<string[]>([]);
  const [base, setBase] = useState(initialBase);
  const [other, setOther] = useState("");
  const [r, setR] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.gitRefs(root).then((x) => setRefs(x.refs ?? [])).catch(() => {});
  }, [root]);

  // Auto-pick the other side when the menu arrives and nothing is chosen.
  useEffect(() => {
    if (other || !refs.length) return;
    const firstOther = refs.find((n) => n !== base);
    if (firstOther) setOther(firstOther);
  }, [refs, base, other]);

  const fetch = async (b: string, o: string) => {
    if (!b || !o) return;
    setBusy(true);
    try {
      const x = await api.gitCompare(root, b, o);
      setR(x as CompareResult);
    } catch (e) {
      setR({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void fetch(base, other); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [base, other, root]);

  const total = r?.ok
    ? (r.diff ?? []).reduce((n, f) => n + f.additions + f.deletions, 0)
    : 0;

  return (
    <Portal>
      <AnimatePresence>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 agx-scrim" style={{ zIndex: 10002 }} onClick={onClose} />
        <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10003 }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 340, damping: 30 }}
            className="w-[min(760px,94vw)] max-h-[min(80vh,640px)] rounded-2xl flex flex-col pointer-events-auto"
            style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
            <div className="flex items-center gap-2 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
              <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Compare</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>read-only</span>
              <CloseButton onClick={onClose} className="ml-auto" />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 agx-scroll">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1">base</div>
                  <select value={base} onChange={(e) => setBase(e.target.value)} className="w-full px-2 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "var(--bg3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}>
                    {refs.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <button onClick={() => { setBase(other); setOther(base); }} title="Swap the two sides" className="mt-5 shrink-0 text-[13px] px-2 py-1.5 rounded-lg t-dim2 hover:brightness-125">⇄</button>
                <div className="flex-1">
                  <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1">other</div>
                  <select value={other} onChange={(e) => setOther(e.target.value)} className="w-full px-2 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "var(--bg3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}>
                    {refs.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>

              {r?.ok ? (
                <>
                  <div className="mt-4 flex items-center gap-3 flex-wrap">
                    <span className="text-[11.5px] px-2 py-1 rounded-lg tabular-nums" style={{ background: "color-mix(in srgb, var(--success) 12%, transparent)", color: "var(--success)" }} title="commits {other} has that {base} doesn't">
                      ↑ {r.ahead!.length} ahead
                    </span>
                    <span className="text-[11.5px] px-2 py-1 rounded-lg tabular-nums" style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)", color: "var(--warning)" }} title="commits {base} has that {other} doesn't">
                      ↓ {r.behind!.length} behind
                    </span>
                    <span className="text-[11px] px-2 py-1 rounded-lg tabular-nums" style={{ background: "color-mix(in srgb, var(--info) 12%, transparent)", color: "var(--info)" }} title="lines changed between the two tips">
                      {r.diff!.length} file{r.diff!.length === 1 ? "" : "s"}, {total} line{total === 1 ? "" : "s"}
                    </span>
                    {busy && <span className="text-[10px] t-dim2 ml-auto">comparing…</span>}
                  </div>

                  {(r.ahead!.length > 0 || r.behind!.length > 0) && (
                    <div className="mt-4">
                      <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1.5">commits</div>
                      <div className="space-y-0.5">
                        {r.behind!.map((c) => (
                          <div key={c.hash} className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                            <span className="shrink-0 text-[9.5px] px-1 py-px rounded" style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--warning)" }} title={`{base} has this, {other} doesn't`}>↓</span>
                            <span className="shrink-0 tabular-nums font-mono" style={{ color: "var(--primary-hover)" }}>{c.shortHash}</span>
                            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{c.subject}</span>
                            <span className="shrink-0 text-[9.5px] t-dim2">{c.author}</span>
                          </div>
                        ))}
                        {r.ahead!.map((c) => (
                          <div key={c.hash} className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                            <span className="shrink-0 text-[9.5px] px-1 py-px rounded" style={{ background: "color-mix(in srgb, var(--success) 14%, transparent)", color: "var(--success)" }} title={`{other} has this, {base} doesn't`}>↑</span>
                            <span className="shrink-0 tabular-nums font-mono" style={{ color: "var(--primary-hover)" }}>{c.shortHash}</span>
                            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{c.subject}</span>
                            <span className="shrink-0 text-[9.5px] t-dim2">{c.author}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.diff!.length > 0 && (
                    <div className="mt-4">
                      <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1.5">diff — {base} vs {other}</div>
                      <div className="space-y-0.5">
                        {r.diff!.map((f) => {
                          const rel = f.file_path.replace(root + "/", "");
                          return (
                            <div key={f.file_path} className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] font-mono" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                              <span className="shrink-0 w-14 text-[9px] uppercase" style={{ color: CHANGE_STATUS[f.status] ?? "var(--text3)" }}>{f.status}</span>
                              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{rel}</span>
                              <span className="shrink-0 tabular-nums" style={{ color: "var(--success)" }}>+{f.additions}</span>
                              <span className="shrink-0 tabular-nums" style={{ color: "var(--error)" }}>−{f.deletions}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {!r.diff!.length && !r.ahead!.length && !r.behind!.length && (
                    <div className="mt-6 text-center text-[11.5px] t-dim2 py-6">Identical — {base} and {other} point at the same history.</div>
                  )}
                </>
              ) : (
                <div className="mt-4 text-[11.5px] px-3 py-2 rounded-lg" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 10%, transparent)" }}>
                  {r?.error || (busy ? "comparing…" : "pick two refs to compare")}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      </AnimatePresence>
    </Portal>
  );
}
