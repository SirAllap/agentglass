import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SearchHit, FileHistoryEntry, GitGrepHit, FileChange } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { ChangesModal } from "./ChangesModal.tsx";
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

/** Word-level highlight of the query in a grep hit line. */
function GrepText({ text, q }: { text: string; q: string }) {
  if (!q) return <span>{text}</span>;
  const segs: { t: string; h: boolean }[] = [];
  const low = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = 0, at = low.indexOf(needle);
  while (at !== -1) {
    if (at > from) segs.push({ t: text.slice(from, at), h: false });
    segs.push({ t: text.slice(at, at + q.length), h: true });
    from = at + q.length;
    at = low.indexOf(needle, from);
  }
  if (from < text.length) segs.push({ t: text.slice(from), h: false });
  if (!segs.length) return <span>{text}</span>;
  return (
    <span>
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

const MODES = [
  { key: "fleet", label: "fleet" },
  { key: "commits", label: "commits" },
  { key: "working tree", label: "working tree" },
  { key: "history", label: "history" },
] as const;
type Mode = (typeof MODES)[number]["key"];

export function SearchModal({ open, onClose, onSelectApp }: { open: boolean; onClose: () => void; onSelectApp?: (app: string) => void }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<Mode>("fleet");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [commits, setCommits] = useState<FileHistoryEntry[] | null>(null);
  const [greps, setGreps] = useState<GitGrepHit[] | null>(null);
  const [gErr, setGErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [repos, setRepos] = useState<{ root: string }[]>([]);
  const [repo, setRepo] = useState("");
  const [diff, setDiff] = useState<{ changes: FileChange[]; title: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) { setQ(""); setHits(null); setCommits(null); setGreps(null); setDiff(null); setGErr(""); }
    else api.gitRepos().then(({ repos: rs }) => { setRepos(rs); setRepo((cur) => cur || rs[0]?.root || ""); }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (mode === "fleet") {
      if (!q.trim()) { setHits(null); setLoading(false); return; }
      setLoading(true);
      timer.current = setTimeout(() => {
        api.search(q).then((r) => { setHits(r.hits); setLoading(false); }).catch(() => { setHits([]); setLoading(false); });
      }, 220);
    } else if (repo && q.trim()) {
      setLoading(true); setGErr("");
      timer.current = setTimeout(() => {
        const run = mode === "commits" ? api.gitSearchCommits(repo, q)
          : mode === "working tree" ? api.gitGrep(repo, q, {})
          : api.gitPickaxe(repo, q, "S");
        run.then((r) => {
          if ("hits" in r) { setGreps(r.hits ?? []); setGErr(r.error || ""); setCommits(null); }
          else { setCommits(r.entries ?? []); setGErr(r.error || ""); setGreps(null); }
          setLoading(false);
        }).catch((e) => { setGErr(String(e)); setCommits(null); setGreps(null); setLoading(false); });
      }, 220);
    } else { setCommits(null); setGreps(null); setGErr(""); setLoading(false); }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, mode, repo]);

  /** Open a commit's diff, or a working-tree file's diff when it exists. */
  const openDiff = async (root: string, hash: string, subject: string) => {
    try {
      const { changes } = await api.gitCommitDiff(root, hash);
      setDiff({ changes, title: `${hash} · ${subject}` });
    } catch (e) { setGErr(String(e)); }
  };
  const openFileDiff = async (root: string, path: string) => {
    try {
      const t = await api.gitTree(root);
      const c = [...(t.staged ?? []), ...(t.unstaged ?? [])].find((x) => x.file_path.endsWith("/" + path) || x.file_path === path);
      if (c) setDiff({ changes: [c], title: `working tree · ${path}` });
      else { navigator.clipboard?.writeText(path).catch(() => {}); setGErr("file is unchanged — path copied"); }
    } catch (e) { setGErr(String(e)); }
  };

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }} onClick={onClose} />
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
                    placeholder={mode === "fleet" ? "Search everything — prompts, commands, outputs, errors…" : mode === "commits" ? "Commit messages… (or a sha prefix)" : mode === "working tree" ? "Grep the working tree…" : "Which commits introduced or removed this string…"}
                    className="flex-1 bg-transparent outline-none text-[13px]" style={{ color: "var(--text)" }}
                  />
                  {mode !== "fleet" && (
                    <select value={repo} onChange={(e) => setRepo(e.target.value)}
                      className="shrink-0 max-w-[180px] text-[10.5px] px-2 py-1 rounded-md outline-none"
                      style={{ background: "color-mix(in srgb, var(--bg3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}>
                      {repos.map((r) => <option key={r.root} value={r.root}>{r.root.split("/").pop() || r.root}</option>)}
                    </select>
                  )}
                  <span className="text-[10px] t-dim2 shrink-0">{loading ? "…" : mode === "fleet" ? (hits ? `${hits.length} hits` : "Your fleet's memory") : commits ? `${commits.length} commits` : greps ? `${greps.length} hits` : ""}</span>
                </div>

                <div className="flex items-center gap-1 px-3 pt-2 shrink-0">
                  {MODES.map((m) => (
                    <button key={m.key} onClick={() => { setMode(m.key); setQ(""); setHits(null); setCommits(null); setGreps(null); setGErr(""); }}
                      className="text-[10.5px] px-2.5 py-1 rounded-md"
                      style={mode === m.key
                        ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
                        : { color: "var(--text3)" }}>{m.label}</button>
                  ))}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {gErr && <div className="t-dim2 text-center py-10 text-[12px]" style={{ color: "var(--error)" }}>{gErr}</div>}
                  {mode === "fleet" && (
                    <>
                      {hits === null && <div className="t-dim2 text-center py-14 text-[12px]">Search every event ever captured — 12k+ prompts, commands and outputs.</div>}
                      {hits && hits.length === 0 && !loading && <div className="t-dim2 text-center py-14 text-[12px]">Nothing matches “{q}”</div>}
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
                    </>
                  )}
                  {mode !== "fleet" && q.trim() && !gErr && (
                    <>
                      {commits === null && greps === null && <div className="t-dim2 text-center py-14 text-[12px]">Type to search the repo…</div>}
                      {commits !== null && commits.length === 0 && !loading && <div className="t-dim2 text-center py-14 text-[12px]">No commits match “{q}”</div>}
                      {greps !== null && greps.length === 0 && !loading && <div className="t-dim2 text-center py-14 text-[12px]">No matches in the working tree</div>}
                      {commits !== null && commits.map((c) => (
                        <div key={c.fullHash} onClick={() => void openDiff(repo, c.fullHash, c.subject)}
                          className="px-4 py-2.5 border-b cursor-pointer transition-colors hover:bg-white/[0.03]"
                          style={{ borderColor: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
                          <div className="flex items-center gap-2 text-[10px] mb-1">
                            <span className="shrink-0 font-mono" style={{ color: "var(--info)" }}>{c.hash}</span>
                            <span className="chip shrink-0" style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 12%, transparent)" }}>{mode === "history" ? "pickaxe" : "commit"}</span>
                            <span className="ml-auto flex items-center gap-2.5 shrink-0 t-dim2 tabular-nums">
                              <span>{c.author}</span>
                              <span>{fmtTime(c.time)}</span>
                            </span>
                          </div>
                          <div className="text-[11.5px]" style={{ color: "var(--text)" }}><GrepText text={c.subject} q={q} /></div>
                        </div>
                      ))}
                      {greps !== null && greps.map((h, i) => (
                        <div key={`${h.path}:${h.line}:${i}`} onClick={() => void openFileDiff(repo, h.path)}
                          className="px-4 py-2.5 border-b cursor-pointer transition-colors hover:bg-white/[0.03] font-mono text-[11px]"
                          style={{ borderColor: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
                          <span className="shrink-0" style={{ color: "var(--info)" }}>{h.path}:{h.line}</span>
                          <span className="ml-2" style={{ color: "var(--text2)" }}><GrepText text={h.text} q={q} /></span>
                        </div>
                      ))}
                    </>
                  )}
                  {mode !== "fleet" && !q.trim() && <div className="t-dim2 text-center py-14 text-[12px]">Type to search the repo…</div>}
                </div>
              </motion.div>
            </div>
            {diff && <ChangesModal open={!!diff} onClose={() => setDiff(null)} onBack={() => setDiff(null)} backLabel="Search" presetChanges={diff.changes} presetTitle={diff.title} />}
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
