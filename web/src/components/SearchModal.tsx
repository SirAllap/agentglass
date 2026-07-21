import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SearchHit } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { friendly } from "../lib/labels.ts";
import { fmtTime, fmtUsd, fmtMs, agentKey } from "../lib/format.ts";

/** Render an FTS snippet, highlighting the \x01…\x02 matched spans. */
function Snippet({ text }: { text: string }) {
  const clean = text.replace(/\s*\n\s*/g, " · ");
  const segs: { t: string; h: boolean }[] = [];
  const re = /\u0001([^\u0002]*)\u0002/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (m.index > last) segs.push({ t: clean.slice(last, m.index), h: false });
    segs.push({ t: m[1], h: true });
    last = re.lastIndex;
  }
  segs.push({ t: clean.slice(last), h: false });
  return (
    <span className="text-[11px] t-dim break-all">
      {segs.map((s, i) =>
        s.h ? (
          <mark key={i} style={{ background: "color-mix(in srgb, var(--warning) 30%, transparent)", color: "var(--text)", borderRadius: 3, padding: "0 1px" }}>{s.t}</mark>
        ) : (
          <span key={i}>{s.t}</span>
        )
      )}
    </span>
  );
}

export function SearchModal({ open, onClose, onSelectApp }: { open: boolean; onClose: () => void; onSelectApp?: (app: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) { setQ(""); setHits(null); }
  }, [open]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setHits(null); setLoading(false); return; }
    setLoading(true);
    timer.current = setTimeout(() => {
      api.search(q).then((r) => { setHits(r.hits); setLoading(false); }).catch(() => { setHits([]); setLoading(false); });
    }, 220);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex justify-center items-start pt-[9vh] px-4 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.97, y: -10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: -6 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[min(820px,94vw)] max-h-[80vh] rounded-2xl flex flex-col overflow-hidden pointer-events-auto"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
              >
                <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="t-dim2 text-[13px]">🔎</span>
                  <input
                    autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder="Search everything — prompts, commands, outputs, errors…"
                    className="flex-1 bg-transparent outline-none text-[13px]" style={{ color: "var(--text)" }}
                  />
                  <span className="text-[10px] t-dim2 shrink-0">{loading ? "…" : hits ? `${hits.length} hits` : "your fleet's memory"}</span>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {hits === null && <div className="t-dim2 text-center py-14 text-[12px]">Search every event ever captured — 12k+ prompts, commands and outputs.</div>}
                  {hits && hits.length === 0 && !loading && <div className="t-dim2 text-center py-14 text-[12px]">nothing matches “{q}”</div>}
                  {hits && hits.map((h) => {
                    const f = friendly({ hook_event_type: h.hook_event_type } as any);
                    const who = agentKey({ source_app: h.source_app, session_id: h.session_id });
                    return (
                      <div
                        key={h.id}
                        onClick={() => { onSelectApp?.(h.source_app); onClose(); }}
                        className="px-4 py-2.5 border-b cursor-pointer transition-colors hover:bg-white/[0.03]"
                        style={{ borderColor: "color-mix(in srgb, var(--border) 22%, transparent)" }}
                      >
                        <div className="flex items-center gap-2 text-[10px] mb-1">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: f.color }} />
                          <span className="font-medium shrink-0" style={{ color: f.color }}>{f.verb}</span>
                          {h.tool_name && <span className="chip shrink-0" style={{ color: "var(--info)", background: "color-mix(in srgb, var(--info) 14%, transparent)" }}>{h.tool_name}</span>}
                          <span className="ml-auto flex items-center gap-2.5 shrink-0 t-dim2 tabular-nums">
                            {h.duration_ms != null && <span>{fmtMs(h.duration_ms)}</span>}
                            {h.cost_usd > 0 && <span style={{ color: "var(--success)" }}>{fmtUsd(h.cost_usd)}</span>}
                            <span>{who}</span>
                            <span>{fmtTime(h.timestamp)}</span>
                          </span>
                        </div>
                        <Snippet text={h.snippet} />
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
