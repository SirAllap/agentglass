import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { RepoStatus, GitFileStatus, CommitResult } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";

// Commits the repo's LIVE working tree (not the telemetry snapshot): the agent's
// changed-file list is only the entry point — we read `git status` fresh and
// commit exactly the files you tick, as they are on disk right now.

const STATUS_COLOR: Record<string, string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  untracked: "var(--success)",
  deleted: "var(--error)",
  renamed: "var(--info)",
  copied: "var(--info)",
  unmerged: "var(--error)",
  "type-changed": "var(--warning)",
};

const baseName = (p: string) => p.split("/").pop() ?? p;
const dirName = (p: string) => { const b = baseName(p); return p.slice(0, p.length - b.length); };

function suggestTitle(files: string[]): string {
  const names = files.map(baseName);
  if (!names.length) return "";
  if (names.length === 1) return `Update ${names[0]}`;
  if (names.length <= 3) return `Update ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Update ${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function Checkbox({ on }: { on: boolean }) {
  return (
    <span
      className="shrink-0 w-3.5 h-3.5 rounded flex items-center justify-center text-[9px] leading-none"
      style={{
        color: on ? "var(--bg)" : "transparent",
        background: on ? "var(--primary)" : "transparent",
        border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
      }}
    >{on ? "✓" : ""}</span>
  );
}

function FileRow({ f, on, onToggle }: { f: GitFileStatus; on: boolean; onToggle: () => void }) {
  const color = STATUS_COLOR[f.status] ?? "var(--text3)";
  return (
    <button onClick={onToggle} className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg3)_40%,transparent)]">
      <Checkbox on={on} />
      <span className="text-[9px] px-1 rounded shrink-0 tabular-nums w-[68px] text-center" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{f.status}</span>
      <span className="text-[11.5px] truncate" style={{ color: on ? "var(--text)" : "var(--text3)" }}>
        <span className="t-dim2">{dirName(f.path)}</span><span className="font-medium">{baseName(f.path)}</span>
      </span>
      {!on && f.unstaged && f.staged && <span className="ml-auto text-[9px] t-dim2 shrink-0">Partly staged</span>}
    </button>
  );
}

export function CommitModal({ open, onClose, paths }: { open: boolean; onClose: () => void; paths: string[] }) {
  const [repos, setRepos] = useState<RepoStatus[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [repoIdx, setRepoIdx] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const load = () => {
    setRepos(null); setResult(null); setConfirming(false);
    api.gitStatus(paths).then((r) => {
      setRepos(r.repos);
      setEnabled(r.commitEnabled);
      const first = r.repos[0];
      setRepoIdx(0);
      setSel(new Set(first?.suggested ?? []));
      setTitle(suggestTitle(first?.suggested ?? []));
      setBody("");
    }).catch(() => setRepos([]));
  };

  useEffect(() => { if (open) load(); /* seed from paths captured at open */ }, [open]);

  const repo = repos?.[repoIdx] ?? null;

  // switching repo re-seeds selection + title from that repo's suggestions
  useEffect(() => {
    if (!repo) return;
    setSel(new Set(repo.suggested));
    setTitle(suggestTitle(repo.suggested));
    setConfirming(false);
  }, [repoIdx]);

  const selPaths = useMemo(() => (repo ? repo.files.filter((f) => sel.has(f.path)).map((f) => f.path) : []), [repo, sel]);
  const allOn = !!repo && repo.files.length > 0 && repo.files.every((f) => sel.has(f.path));
  const toggle = (p: string) => setSel((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); setConfirming(false); return n; });
  const toggleAll = () => { if (repo) setSel(allOn ? new Set() : new Set(repo.files.map((f) => f.path))); setConfirming(false); };

  const doCommit = () => {
    if (!repo || !title.trim() || !selPaths.length || busy) return;
    setBusy(true);
    api.gitCommit({ root: repo.root, files: selPaths, title: title.trim(), body: body.trim() })
      .then((r) => setResult(r))
      .catch((e) => setResult({ ok: false, error: String(e) }))
      .finally(() => { setBusy(false); setConfirming(false); });
  };

  const canCommit = enabled && !!repo && !!title.trim() && selPaths.length > 0 && !busy;

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10002, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10003 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[min(760px,94vw)] max-h-[min(760px,92vh)] rounded-2xl flex flex-col pointer-events-auto"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
              >
                {/* header */}
                <div className="flex items-center gap-2.5 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Commit</span>
                  {repo && <span className="chip text-[10px]" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 14%, transparent)" }}>⎇ {repo.branch}</span>}
                  {repo && <span className="text-[10.5px] t-dim2 truncate" title={repo.root}>{repo.root}</span>}
                  <button onClick={onClose} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
                  {!repos && <div className="t-dim2 text-center py-12 text-[12px]">Reading working tree…</div>}
                  {repos && repos.length === 0 && (
                    <div className="t-dim2 text-center py-12 text-[12px]">No git repository found for these changes</div>
                  )}

                  {result?.ok ? (
                    <div className="flex flex-col items-center justify-center py-10 gap-3">
                      <div className="text-[26px]">✅</div>
                      <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>Committed</div>
                      <div className="text-[12px] t-dim2 tabular-nums">
                        <span className="font-mono" style={{ color: "var(--primary)" }}>{result.shortSha}</span> · {result.summary}
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <button onClick={load} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}>Commit more</button>
                        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: "var(--primary)", color: "var(--bg)" }}>Done</button>
                      </div>
                    </div>
                  ) : repo ? (
                    <div className="space-y-3">
                      {/* repo selector */}
                      {repos!.length > 1 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          {repos!.map((r, i) => (
                            <button key={r.root} onClick={() => setRepoIdx(i)} title={r.root}
                              className="px-2 py-0.5 rounded text-[10px] transition-colors"
                              style={{ background: i === repoIdx ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent", color: i === repoIdx ? "var(--text)" : "var(--text3)", border: `1px solid color-mix(in srgb, var(--border) ${i === repoIdx ? 45 : 18}%, transparent)` }}>
                              {baseName(r.root)} <span className="t-dim2">({r.files.length})</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* file list */}
                      <div>
                        <div className="flex items-center justify-between mb-1 px-1">
                          <span className="text-[10px] t-dim2 uppercase tracking-wide">Files in this commit</span>
                          <button onClick={toggleAll} className="text-[10px] t-dim2 hover:opacity-80">{allOn ? "Select none" : "Select all"} · {selPaths.length}/{repo.files.length}</button>
                        </div>
                        <div className="rounded-lg p-1 space-y-0.5 max-h-[220px] overflow-y-auto" style={{ background: "color-mix(in srgb, var(--bg3) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
                          {repo.files.length === 0 && <div className="t-dim2 text-center py-6 text-[11px]">Working tree clean — nothing to commit</div>}
                          {repo.files.map((f) => <FileRow key={f.path} f={f} on={sel.has(f.path)} onToggle={() => toggle(f.path)} />)}
                        </div>
                      </div>

                      {/* message */}
                      <div>
                        <div className="flex items-center justify-between mb-1 px-1">
                          <span className="text-[10px] t-dim2 uppercase tracking-wide">Message</span>
                          <span className="text-[9.5px] t-dim2 tabular-nums">{title.length}/72</span>
                        </div>
                        <input
                          value={title} onChange={(e) => { setTitle(e.target.value); setConfirming(false); }}
                          placeholder={suggestTitle(selPaths) || "Commit title…"}
                          className="w-full px-3 py-1.5 rounded-lg text-[12px] outline-none mb-1.5"
                          style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}
                        />
                        <textarea
                          value={body} onChange={(e) => setBody(e.target.value)}
                          placeholder="Extended description (optional)…" rows={3}
                          className="w-full px-3 py-1.5 rounded-lg text-[11.5px] outline-none resize-none"
                          style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}
                        />
                      </div>

                      {!enabled && (
                        <div className="text-[11px] px-3 py-2 rounded-lg" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 12%, transparent)" }}>
                          Committing is disabled on this server (AGENTGLASS_COMMIT_DISABLED=1).
                        </div>
                      )}
                      {result && !result.ok && (
                        <div className="text-[11px] px-3 py-2 rounded-lg font-mono" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }}>
                          {result.error}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* footer */}
                {repo && !result?.ok && (
                  <div className="flex items-center gap-2 px-5 py-3 border-t shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <span className="text-[10.5px] t-dim2 tabular-nums">
                      {selPaths.length} file{selPaths.length === 1 ? "" : "s"} → <span style={{ color: "var(--warning)" }}>⎇ {repo.branch}</span>
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      {confirming ? (
                        <>
                          <button onClick={() => setConfirming(false)} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text3)" }}>Cancel</button>
                          <button onClick={doCommit} disabled={busy} className="px-3 py-1.5 rounded-lg text-[11px] font-medium" style={{ background: "var(--error)", color: "#fff", opacity: busy ? 0.6 : 1 }}>
                            {busy ? "Committing…" : `Yes, commit ${selPaths.length}`}
                          </button>
                        </>
                      ) : (
                        <button onClick={() => canCommit && setConfirming(true)} disabled={!canCommit}
                          className="px-3.5 py-1.5 rounded-lg text-[11px] font-medium transition-opacity"
                          style={{ background: "var(--primary)", color: "var(--bg)", opacity: canCommit ? 1 : 0.45, cursor: canCommit ? "pointer" : "not-allowed" }}>
                          Commit {selPaths.length || ""} {selPaths.length === 1 ? "file" : "files"}…
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
