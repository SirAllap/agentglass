/*
 * Blame + file history — who wrote each line of a file, and the file's commit
 * trail (following renames). Read-only. Clicking a history entry reblames the
 * file as of that commit; clicking a blame line opens that commit's diff.
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api } from "../lib/api.ts";
import type { BlameLine, FileHistoryEntry } from "../../../shared/types.ts";

const SHORT = 7;

export function BlameModal({ root, path, onClose, onOpenCommit }: {
  root: string;
  path: string;
  onClose: () => void;
  onOpenCommit: (hash: string, subject: string) => void;
}) {
  const [lines, setLines] = useState<BlameLine[]>([]);
  const [history, setHistory] = useState<FileHistoryEntry[]>([]);
  const [at, setAt] = useState("HEAD");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = async (ref: string) => {
    setBusy(true);
    setError("");
    try {
      const b = await api.gitBlame(root, path, ref);
      if (!b.ok) { setError(b.error || "blame failed"); setLines([]); }
      else setLines(b.lines ?? []);
    } catch (e) { setError(String(e)); setLines([]); }
    setBusy(false);
  };

  useEffect(() => { void load("HEAD"); }, [root, path]);
  useEffect(() => {
    api.gitFileHistory(root, path).then((h) => setHistory(h.entries ?? [])).catch(() => {});
  }, [root, path]);

  const bySha = useMemo(() => {
    const m = new Map<string, { author: string; subject: string; time: number }>();
    for (const l of lines) {
      if (l.sha && !m.has(l.sha)) m.set(l.sha, { author: l.author, subject: l.subject, time: l.time });
    }
    return m;
  }, [lines]);

  const reblame = async (fullHash: string, short: string) => {
    setAt(short);
    await load(fullHash);
  };

  const fmt = (t: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

  return (
    <Portal>
      <AnimatePresence>
        <motion.div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "color-mix(in srgb, #000 45%, transparent)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="relative w-full max-w-4xl h-[80vh] rounded-2xl p-4 flex flex-col min-h-0"
            style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 24px 80px rgba(0,0,0,.5)" }}
            initial={{ opacity: 0, scale: .97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .97, y: 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3 shrink-0">
              <h3 className="text-[13px] font-semibold truncate" style={{ color: "var(--text)" }} title={path}>{path}</h3>
              <span className="shrink-0 rounded px-1.5 py-px text-[9.5px] font-mono" style={{ color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }}>{at}</span>
              {at !== "HEAD" && (
                <button onClick={() => reblame("HEAD", "HEAD")} className="shrink-0 text-[10px] px-2 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>back to HEAD</button>
              )}
              <CloseButton onClick={onClose} />
            </div>

            <div className="flex-1 min-h-0 flex gap-3">
              {/* History — the file's commits; a click reblames as of it. */}
              <div className="w-72 shrink-0 min-h-0 flex flex-col rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                <div className="text-[9.5px] uppercase tracking-wider t-dim2 px-3 pt-2.5 pb-1 shrink-0">file history · click to reblame</div>
                <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
                  {history.map((h) => (
                    <button key={h.fullHash} onClick={() => reblame(h.fullHash, h.hash)} className="w-full text-left px-2 py-1.5 rounded-md" style={{ background: at === h.hash ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent" }}>
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 font-mono text-[9.5px]" style={{ color: "var(--info)" }}>{h.hash}</span>
                        <span className="shrink-0 text-[9.5px] t-dim2 ml-auto">{fmt(h.time)}</span>
                      </div>
                      <div className="truncate text-[11px] mt-0.5" style={{ color: "var(--text)" }}>{h.subject}</div>
                      <div className="truncate text-[9.5px] t-dim2">{h.author}</div>
                    </button>
                  ))}
                  {!history.length && !busy && <div className="text-[10.5px] t-dim2 px-2 py-2">no history</div>}
                </div>
              </div>

              {/* The blame itself. */}
              <div className="flex-1 min-h-0 flex flex-col rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                <div className="text-[9.5px] uppercase tracking-wider t-dim2 px-3 pt-2.5 pb-1 shrink-0">blame · click a line to open its commit</div>
                {busy ? (
                  <div className="flex-1 grid place-items-center text-[11px] t-dim2">Reading blame…</div>
                ) : error ? (
                  <div className="flex-1 grid place-items-center text-[11px] px-4 text-center" style={{ color: "var(--error)" }}>{error}</div>
                ) : (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 font-mono text-[10.5px] leading-[1.55]">
                    {lines.map((l) => {
                      const meta = l.sha ? bySha.get(l.sha) : null;
                      return (
                        <button key={l.line} onClick={() => { if (l.sha) onOpenCommit(l.sha, meta?.subject || ""); }}
                          className="w-full flex items-baseline gap-2 text-left rounded-sm hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]"
                          title={l.sha ? `${l.sha.slice(0, SHORT)} · ${meta?.subject ?? ""} · ${meta?.author ?? ""}` : "not yet committed"}>
                          <span className="shrink-0 w-7 text-right select-none" style={{ color: "var(--text3)" }}>{l.line}</span>
                          <span className="shrink-0 w-[4.6rem] truncate" style={{ color: l.sha ? "var(--info)" : "var(--warning)" }}>{l.sha ? l.sha.slice(0, SHORT) : "local"}</span>
                          <span className="shrink-0 w-20 truncate" style={{ color: "var(--text3)" }}>{meta?.author ?? ""}</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text2)" }}>{l.content}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </Portal>
  );
}
