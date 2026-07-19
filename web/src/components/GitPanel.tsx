// Live Source Control — agentglass's lazygit replacement. Working tree
// (stage/unstage/discard/commit), branches (checkout/create/delete), log
// (browse commits, view a commit's diff), and stash — all with the same diff
// renderer as the telemetry view.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { GitRepoRef, WorkingTree, GitFileChange, GitBranch, GitStash, GitGraphLine, GitWorktree, FileChange, WalkthroughResult, WalkthroughFile } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import { usePoll } from "../lib/usePoll.ts";
import { UnifiedDiff, SplitDiff, ThemePicker, Toggle, SCROLLBAR_CSS, ChangesModal, changesetSig, readWalkCache, writeWalkCache } from "./ChangesModal.tsx";

const unifiedText = (c: GitFileChange) => c.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");

type View = "changes" | "log" | "branches" | "stashes" | "worktrees";
// parse "[ahead 4, behind 53]" → compact "↑4 ↓53"
function trackChip(track: string): { ahead: number; behind: number } {
  const a = track.match(/ahead (\d+)/), b = track.match(/behind (\d+)/);
  return { ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0 };
}
const wtName = (p: string) => p.split("/").pop() || p;

const STATUS_TINT: Record<string, string> = {
  modified: "var(--info)", added: "var(--success)", deleted: "var(--error)",
  renamed: "var(--warning)", untracked: "var(--success)", copied: "var(--warning)",
  unmerged: "var(--error)", "type-changed": "var(--warning)",
};
const STATUS_LETTER: Record<string, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U",
  copied: "C", unmerged: "!", "type-changed": "T",
};
const baseName = (p: string) => p.split("/").pop() || p;
// a file can be in BOTH staged & unstaged after partial staging — key by side.
const keyOf = (c: GitFileChange) => (c.staged ? "s:" : "u:") + c.file_path;
function dirName(p: string, root: string) {
  const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

function FileRow({ c, root, active, writeEnabled, desc, onSelect, action, onAction, onDiscard }: {
  c: GitFileChange; root: string; active: boolean; writeEnabled: boolean; desc?: string; onSelect: () => void;
  action: "stage" | "unstage"; onAction: () => void; onDiscard?: () => void;
}) {
  const dir = dirName(c.file_path, root);
  return (
    <div onClick={onSelect} data-file={active ? "active" : undefined}
      className="group flex items-center gap-2 pl-2 pr-1.5 py-1 rounded-md cursor-pointer"
      style={{ background: active ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
      <span className="w-3.5 text-center text-[10px] font-bold shrink-0 self-start mt-0.5" style={{ color: STATUS_TINT[c.status] }} title={c.status}>{STATUS_LETTER[c.status]}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="block truncate text-[11.5px]" style={{ color: active ? "var(--text)" : "var(--text2)" }}>
          {baseName(c.file_path)}{dir && <span className="t-dim2 text-[9.5px] ml-1.5">{dir}</span>}
        </span>
        {desc && <span className="block truncate text-[9.5px] leading-tight t-dim2" title={desc}>{desc}</span>}
      </span>
      <span className="shrink-0 self-start mt-0.5 text-[9.5px] tabular-nums flex items-center gap-1 opacity-80">
        {c.additions > 0 && <span style={{ color: "var(--success)" }}>+{c.additions}</span>}
        {c.deletions > 0 && <span style={{ color: "var(--error)" }}>−{c.deletions}</span>}
      </span>
      {writeEnabled && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onDiscard && <button onClick={(e) => { e.stopPropagation(); onDiscard(); }} title="Discard changes (irreversible)" className="w-5 h-5 grid place-items-center rounded text-[11px]" style={{ color: "var(--error)" }}>↺</button>}
          <button onClick={(e) => { e.stopPropagation(); onAction(); }} title={action === "stage" ? "Stage" : "Unstage"} className="w-5 h-5 grid place-items-center rounded text-[13px] font-bold" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg3) 60%, transparent)" }}>{action === "stage" ? "＋" : "－"}</button>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, tint, action, onAll, children }: { title: string; count: number; tint: string; action?: string; onAll?: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1 sticky top-0 z-10" style={{ background: "var(--bg2)" }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint }} />
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text2)" }}>{title}</span>
        <span className="text-[9.5px] t-dim2 tabular-nums">{count}</span>
        {action && count > 0 && onAll && <button onClick={onAll} className="ml-auto text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>{action}</button>}
      </div>
      <div className="px-1">{children}</div>
    </div>
  );
}

export function GitPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState<string>("");
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [view, setView] = useState<View>("changes");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  // branches / log / stashes / worktrees
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[] }>({ current: "", branches: [] });
  const [newBranch, setNewBranch] = useState("");
  const [graph, setGraph] = useState<GitGraphLine[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [newWtBranch, setNewWtBranch] = useState("");
  const [commitView, setCommitView] = useState<{ changes: FileChange[]; title: string } | null>(null);
  const [walk, setWalk] = useState<WalkthroughResult | null>(null);
  const [walkLoading, setWalkLoading] = useState(false);
  const walkReqSig = useRef<string | null>(null);
  const treeSeq = useRef(0); // guards stale working-tree responses (repo switches)
  const frameRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => [...(tree?.staged ?? []), ...(tree?.unstaged ?? [])], [tree]);
  const selected = useMemo(() => all.find((c) => keyOf(c) === selKey) ?? all[0] ?? null, [all, selKey]);
  const { hilite, themePref, setThemePref, bold, setBold } = useDiffHighlight(selected?.file_path);
  const writeEnabled = tree?.writeEnabled ?? false;
  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 2600); };

  // AI walkthrough of the *working tree* — cached per changeset (shared cache
  // with the telemetry viewer), so re-opening never re-hits the model.
  const walkSig = useMemo(() => changesetSig(all), [all]);
  const descMap = useMemo(() => { const m = new Map<string, WalkthroughFile>(); for (const f of walk?.files ?? []) m.set(f.path, f); return m; }, [walk]);
  useEffect(() => { if (!open) return; walkReqSig.current = null; setWalkLoading(false); setWalk(all.length ? (readWalkCache()[walkSig] ?? null) : null); }, [open, walkSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const explain = (force = false) => {
    if (walkLoading || !all.length) return;
    if (!force) { const c = readWalkCache()[walkSig]; if (c) { setWalk(c); return; } }
    const reqSig = walkSig; walkReqSig.current = reqSig; setWalkLoading(true);
    const files = all.map((c) => ({ path: c.file_path, tool: "git", additions: c.additions, deletions: c.deletions, patch: unifiedText(c) }));
    api.walkthrough(files)
      .then((r) => { if (walkReqSig.current !== reqSig) return; setWalk(r); if (r.available && !r.error) writeWalkCache(reqSig, r); })
      .catch((e) => { if (walkReqSig.current === reqSig) setWalk({ available: true, reviewFocus: "", files: [], error: String(e) }); })
      .finally(() => { if (walkReqSig.current === reqSig) setWalkLoading(false); });
  };

  const loadTree = useCallback(async (r: string) => {
    if (!r) return;
    const seq = ++treeSeq.current;
    try { const t = await api.gitTree(r); if (seq !== treeSeq.current) return; setTree(t); if (t.error) flash(false, t.error); }
    catch (e) { if (seq === treeSeq.current) flash(false, String(e)); }
  }, []);
  const rel = (c: GitFileChange) => (c.file_path.startsWith(root + "/") ? c.file_path.slice(root.length + 1) : c.file_path);

  useEffect(() => {
    if (!open) return;
    setToast(null); setTitle(""); setBody(""); setView("changes"); setNewBranch("");
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      const first = repos[0]?.root ?? "";
      setRoot((cur) => cur || first); // the [root, open] effect owns tree loading
    }).catch((e) => flash(false, String(e)));
    requestAnimationFrame(() => frameRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open && root) loadTree(root); }, [root, open, loadTree]);

  // load the data a non-Changes view needs when it (or the repo) becomes active
  const loadView = useCallback(() => {
    if (!open || !root) return;
    if (view === "branches") api.gitBranches(root).then(setBranchData).catch(() => {});
    else if (view === "log") api.gitGraph(root, 500).then((r) => setGraph(r.lines)).catch(() => {});
    else if (view === "stashes") api.gitStashes(root).then((r) => setStashes(r.stashes)).catch(() => {});
    else if (view === "worktrees") api.gitWorktrees(root).then((r) => setWorktrees(r.worktrees)).catch(() => {});
  }, [open, root, view]);
  useEffect(() => { loadView(); }, [loadView]);

  // The working tree changes from outside this app — a commit in a terminal, a
  // branch switch, an agent editing files — and none of that emits an event we
  // could listen for, so an open panel would otherwise sit on whatever it read
  // when it opened. Not while a write is in flight: refreshing mid-stage would
  // fight the optimistic selection the action is about to set.
  usePoll(open && !!root && !busy, () => { loadTree(root); loadView(); });

  const act = async (fn: () => Promise<{ ok: boolean; error?: string; output?: string }>, okMsg?: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) { if (okMsg || r.output) flash(true, okMsg || r.output || "done"); } else flash(false, r.error || "failed");
      await loadTree(root);
      return r.ok;
    } catch (e) { flash(false, String(e)); return false; } finally { setBusy(false); }
  };

  // working tree ops
  const stage = async (c: GitFileChange) => { if (await act(() => api.gitStage(root, [rel(c)]))) setSelKey("s:" + c.file_path); };
  const unstage = async (c: GitFileChange) => { if (await act(() => api.gitUnstage(root, [rel(c)]))) setSelKey("u:" + c.file_path); };
  const discard = (c: GitFileChange) => { if (confirm(`Discard changes to ${baseName(c.file_path)}? This cannot be undone.`)) act(() => api.gitDiscard(root, [rel(c)]), "discarded"); };
  const doCommit = async () => {
    if (!title.trim()) { flash(false, "commit title required"); return; }
    if (await act(() => api.gitCommitStaged(root, title, body), "committed")) { setTitle(""); setBody(""); api.gitGraph(root, 500).then((r) => setGraph(r.lines)).catch(() => {}); }
  };
  // branches
  const reloadBranches = () => api.gitBranches(root).then(setBranchData).catch(() => {});
  const checkout = async (name: string) => { if (await act(() => api.gitCheckout(root, name), `on ${name}`)) { reloadBranches(); setView("changes"); } };
  const createBranch = async () => { const n = newBranch.trim(); if (!n) return; if (await act(() => api.gitBranchCreate(root, n), `created ${n}`)) { setNewBranch(""); reloadBranches(); setView("changes"); } };
  const deleteBranch = (name: string) => { if (confirm(`Delete branch ${name}?`)) act(() => api.gitBranchDelete(root, name, false)).then((ok) => { if (ok) reloadBranches(); }); };
  const mergeBranch = (name: string) => { if (confirm(`Merge ${name} into the current branch?`)) act(() => api.gitMerge(root, name), `merged ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const rebaseBranch = (name: string) => { if (confirm(`Rebase the current branch onto ${name}?`)) act(() => api.gitRebase(root, name), `rebased onto ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const renameBranch = (name: string) => { const to = prompt(`Rename ${name} to:`, name); if (to && to.trim() && to !== name) act(() => api.gitBranchRename(root, name, to.trim()), `renamed → ${to.trim()}`).then((ok) => { if (ok) reloadBranches(); }); };
  // log
  const openCommit = async (hash: string, subject: string) => {
    try { const { changes } = await api.gitCommitDiff(root, hash); setCommitView({ changes, title: `${hash} · ${subject}` }); }
    catch (e) { flash(false, String(e)); }
  };
  const resetTo = (hash: string, mode: "soft" | "mixed" | "hard") => {
    if (mode === "hard" && !confirm(`Hard reset to ${hash}? This DISCARDS working-tree changes.`)) return;
    act(() => api.gitReset(root, hash, mode), `reset --${mode} ${hash}`).then((ok) => { if (ok) api.gitGraph(root, 500).then((r) => setGraph(r.lines)); });
  };
  // worktrees
  const reloadWorktrees = () => api.gitWorktrees(root).then((r) => setWorktrees(r.worktrees)).catch(() => {});
  const addWorktree = async () => {
    const br = newWtBranch.trim(); if (!br) return;
    const path = `${root}-${br.replace(/[\/\s]+/g, "-")}`; // sibling dir named repo-branch
    if (await act(() => api.gitWorktreeAdd(root, path, br, true), `worktree ${wtName(path)}`)) { setNewWtBranch(""); reloadWorktrees(); }
  };
  const removeWorktree = (w: GitWorktree) => { if (confirm(`Remove worktree ${wtName(w.path)}?`)) act(() => api.gitWorktreeRemove(root, w.path, false), "removed worktree").then((ok) => { if (ok) reloadWorktrees(); }); };
  const openWorktree = (w: GitWorktree) => { setRoot(w.path); setRepoOpen(false); setSelKey(null); setView("changes"); };
  // stashes
  const reloadStashes = () => api.gitStashes(root).then((r) => setStashes(r.stashes)).catch(() => {});
  const stashPush = async () => { if (await act(() => api.gitStashPush(root, ""), "stashed")) reloadStashes(); };
  const stashOp = async (op: "apply" | "pop" | "drop", index: number) => {
    if (op === "drop" && !confirm("Drop this stash?")) return;
    const fn = op === "apply" ? api.gitStashApply : op === "pop" ? api.gitStashPop : api.gitStashDrop;
    if (await act(() => fn(root, index), op + "ed")) reloadStashes();
  };

  // keyboard nav (changes view) — lazygit-like: j/k move, s stage, u unstage, x discard
  const moveSel = (dir: 1 | -1) => {
    if (!all.length) return;
    const i = Math.max(0, all.findIndex((c) => selected && keyOf(c) === keyOf(selected)));
    const n = all[(i + dir + all.length) % all.length];
    if (n) { setSelKey(keyOf(n)); requestAnimationFrame(() => frameRef.current?.querySelector('[data-file="active"]')?.scrollIntoView({ block: "nearest" })); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (/input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "")) return;
    if (view !== "changes" || commitView) return;
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (k === "s" && selected && writeEnabled && !selected.staged) { e.preventDefault(); stage(selected); }
    else if (k === "u" && selected && writeEnabled && selected.staged) { e.preventDefault(); unstage(selected); }
    else if (k === "x" && selected && writeEnabled && !selected.staged) { e.preventDefault(); discard(selected); }
  };

  // interactive hunk staging (unified view, modified files)
  const applyHunk = (action: "stage" | "unstage" | "discard", i: number) => {
    if (!selected || !writeEnabled) return;
    if (action === "discard" && !confirm("Discard this hunk? This cannot be undone.")) return;
    act(() => api.gitApplyHunk(root, selected.file_path, selected.staged, action, selected.hunks[i]), `${action}d hunk`);
  };
  const hunkBtn = (label: string, tint: string, onClick: () => void) => (
    <button onClick={onClick} className="text-[9px] px-1.5 py-0.5 rounded" style={{ fontFamily: "system-ui, sans-serif", color: tint, background: "color-mix(in srgb, var(--bg3) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>{label}</button>
  );
  const hunkActionFn = (writeEnabled && selected && selected.status === "modified" && !selected.binary)
    ? (i: number) => (
        <span className="inline-flex items-center gap-1">
          {selected.staged
            ? hunkBtn("－ unstage hunk", "var(--text)", () => applyHunk("unstage", i))
            : <>{hunkBtn("＋ stage hunk", "var(--text)", () => applyHunk("stage", i))}{hunkBtn("↺ discard", "var(--error)", () => applyHunk("discard", i))}</>}
        </span>
      )
    : undefined;

  const repoRef = repos.find((r) => r.root === root);
  const branch = tree?.branch;
  const ViewTab = ({ id, label, n }: { id: View; label: string; n?: number }) => (
    <button onClick={() => setView(id)} className="text-[10.5px] px-2 py-1 rounded-md transition-colors"
      style={{ background: view === id ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: view === id ? "var(--text)" : "var(--text3)", border: `1px solid color-mix(in srgb, var(--border) ${view === id ? 40 : 15}%, transparent)` }}>
      {label}{n != null && n > 0 && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
    </button>
  );

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div ref={frameRef} tabIndex={-1} onKeyDown={onKey}
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[95vw] h-[95vh] rounded-2xl flex flex-col pointer-events-auto outline-none overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
                <style>{SCROLLBAR_CSS}</style>
                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Source control</span>
                  <div className="relative">
                    <button onClick={() => setRepoOpen((o) => !o)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}>
                      <span className="font-medium">{repoRef?.name ?? "repo"}</span><span className="t-dim2">▼</span>
                    </button>
                    {repoOpen && (
                      <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 320, maxHeight: 420, overflow: "hidden" }}>
                        <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="filter repos…" className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                        <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                          {repos.filter((r) => { const q = repoQuery.trim().toLowerCase(); return !q || (r.name + " " + r.branch).toLowerCase().includes(q); }).map((r) => (
                            <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); setRepoQuery(""); setSelKey(null); }} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2" style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                              <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }}>{r.name}</span>
                              <span className="shrink-0 truncate t-dim2 text-[9.5px]" style={{ maxWidth: 150 }} title={r.branch}>{r.branch}</span>
                              {r.dirty > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }}>●{r.dirty}</span>}
                            </button>
                          ))}
                          {!repos.length && <div className="px-3 py-2 t-dim2">no repos seen yet</div>}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-1">
                    <ViewTab id="changes" label="Changes" n={all.length} />
                    <ViewTab id="log" label="Log" />
                    <ViewTab id="branches" label="Branches" n={branchData.branches.length || undefined} />
                    <ViewTab id="worktrees" label="Worktrees" n={worktrees.length || undefined} />
                    <ViewTab id="stashes" label="Stashes" n={stashes.length || undefined} />
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    {branch && <span className="px-2 py-0.5 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--primary-hover)" }}>⎇ {branch.name}{branch.ahead > 0 ? ` ↑${branch.ahead}` : ""}{branch.behind > 0 ? ` ↓${branch.behind}` : ""}</span>}
                    <button disabled={!writeEnabled || busy} onClick={() => act(() => api.gitFetch(root), "fetched")} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", opacity: writeEnabled ? 1 : 0.5 }}>fetch</button>
                    <button disabled={!writeEnabled || busy} onClick={() => act(() => api.gitPull(root), "pulled")} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", opacity: writeEnabled ? 1 : 0.5 }}>↓ pull</button>
                    <button disabled={!writeEnabled || busy} onClick={() => act(() => api.gitPush(root), "pushed")} className="text-[11px] px-2.5 py-1 rounded-lg font-medium" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", opacity: writeEnabled ? 1 : 0.5 }}>↑ push{branch && branch.ahead > 0 ? ` (${branch.ahead})` : ""}</button>
                    <button onClick={() => loadTree(root)} title="Refresh" className="text-[13px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}>⟳</button>
                    <button onClick={onClose} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                  </div>
                </div>

                {view === "changes" ? (
                  <div className="flex-1 min-h-0 flex">
                    <div className="w-[340px] shrink-0 border-r flex flex-col min-h-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                      {!tree?.clean && (
                        <div className="shrink-0 px-2.5 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          <button onClick={() => explain(!!walk)} disabled={walkLoading} className="text-[11px] px-2.5 py-1 rounded-lg w-full" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--info) 13%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 28%, transparent)", opacity: walkLoading ? 0.6 : 1 }}>
                            {walkLoading ? "✨ explaining…" : walk ? "✨ re-explain changes" : "✨ Explain changes"}
                          </button>
                          {(walk?.reviewFocus || walk?.error) && (
                            <div className="mt-1.5 text-[10px] leading-snug" style={{ color: walk?.error ? "var(--warning)" : "var(--text2)" }}>
                              {walk?.reviewFocus ? <><span className="t-dim2 uppercase tracking-wide text-[8.5px] mr-1">focus</span>{walk.reviewFocus}</> : walk?.error}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto py-1">
                        {tree?.clean && <div className="px-3 py-6 text-center t-dim2 text-[11px]">✓ nothing to commit, working tree clean</div>}
                        {!!tree?.staged.length && (
                          <Section title="Staged" count={tree.staged.length} tint="var(--success)" action="unstage all" onAll={writeEnabled ? () => act(() => api.gitUnstageAll(root)) : undefined}>
                            {tree.staged.map((c) => <FileRow key={"s" + c.file_path} c={c} root={root} writeEnabled={writeEnabled} desc={descMap.get(c.file_path)?.description} active={selKey === keyOf(c)} onSelect={() => setSelKey(keyOf(c))} action="unstage" onAction={() => unstage(c)} />)}
                          </Section>
                        )}
                        {!!tree?.unstaged.length && (
                          <Section title="Changes" count={tree.unstaged.length} tint="var(--warning)" action="stage all" onAll={writeEnabled ? () => act(() => api.gitStageAll(root)) : undefined}>
                            {tree.unstaged.map((c) => <FileRow key={"u" + c.file_path} c={c} root={root} writeEnabled={writeEnabled} desc={descMap.get(c.file_path)?.description} active={selKey === keyOf(c)} onSelect={() => setSelKey(keyOf(c))} action="stage" onAction={() => stage(c)} onDiscard={() => discard(c)} />)}
                          </Section>
                        )}
                      </div>
                      <div className="shrink-0 border-t p-2.5 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit(); }} placeholder="Commit message (summary)…" disabled={!writeEnabled} className="w-full px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit(); }} placeholder="Extended description (optional)…" rows={2} disabled={!writeEnabled} className="agx-scroll w-full px-2.5 py-1.5 rounded-lg text-[11px] outline-none resize-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={doCommit} disabled={!writeEnabled || busy || !tree?.staged.length || !title.trim()} className="w-full py-1.5 rounded-lg text-[11.5px] font-semibold" style={{ background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)", opacity: (!writeEnabled || !tree?.staged.length || !title.trim()) ? 0.45 : 1 }}>⎇ Commit {tree?.staged.length ? `${tree.staged.length} staged` : ""}</button>
                        {!writeEnabled && <div className="text-[9.5px] t-dim2 text-center">read-only (AGENTGLASS_GIT_WRITE_DISABLED)</div>}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                      {selected ? (
                        <>
                          <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                            <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: STATUS_TINT[selected.status] }}>{STATUS_LETTER[selected.status]}</span>
                            <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={selected.file_path}>{rel(selected)}</span>
                            <span className="shrink-0 text-[10.5px] tabular-nums flex items-center gap-1.5">
                              {selected.additions > 0 && <span style={{ color: "var(--success)" }}>+{selected.additions}</span>}
                              {selected.deletions > 0 && <span style={{ color: "var(--error)" }}>−{selected.deletions}</span>}
                            </span>
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                              {writeEnabled && (selected.staged ? <Toggle onClick={() => unstage(selected)} title="Unstage this file">－ unstage</Toggle> : <Toggle onClick={() => stage(selected)} title="Stage this file">＋ stage</Toggle>)}
                              <Toggle on={split} onClick={() => setSplit((s) => !s)} title="Split / unified">{split ? "split" : "unified"}</Toggle>
                              <Toggle on={wrap} onClick={() => setWrap((w) => !w)} title="Toggle line wrap">wrap</Toggle>
                              <ThemePicker value={themePref} onChange={setThemePref} />
                              <Toggle on={bold} onClick={() => setBold((b) => !b)} title="Bold keywords, functions & types (Neovim-style)">bold</Toggle>
                            </div>
                          </div>
                          <div className="flex-1 min-h-0 flex relative" style={{ background: "var(--bg)" }}>
                            {selected.binary ? <div className="flex-1 grid place-items-center t-dim2 text-[12px]">binary file — no textual diff</div>
                              : <HiliteCtx.Provider value={selected.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000 ? { ...hilite, theme: null } : hilite}>{split ? <SplitDiff c={selected} wrap={wrap} /> : <UnifiedDiff c={selected} wrap={wrap} hunkAction={hunkActionFn} />}</HiliteCtx.Provider>}
                          </div>
                        </>
                      ) : <div className="flex-1 grid place-items-center t-dim2 text-[12px]">{tree ? "select a file to view its diff" : "loading…"}</div>}
                    </div>
                  </div>
                ) : view === "log" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-auto py-1 text-[11.5px]" style={{ fontFamily: "var(--font-mono, ui-monospace), monospace" }}>
                    {graph.map((l, i) => {
                      const isCommit = !!l.hash;
                      return (
                        <div key={i} onClick={isCommit ? () => openCommit(l.hash!, l.subject || "") : undefined}
                          className={`flex items-center gap-2 px-3 whitespace-pre ${isCommit ? "cursor-pointer hover:brightness-125" : ""}`}
                          style={{ lineHeight: "1.55" }}
                          title={isCommit ? "View this commit's diff" : undefined}
                          onContextMenu={isCommit ? (e) => { e.preventDefault(); const m = prompt(`reset current branch to ${l.hash} — type: soft, mixed, or hard`, "mixed"); if (m === "soft" || m === "mixed" || m === "hard") resetTo(l.hash!, m); } : undefined}>
                          <span style={{ color: "color-mix(in srgb, var(--primary) 75%, var(--text3))" }}>{l.graph}</span>
                          {isCommit && <>
                            <span className="shrink-0 tabular-nums" style={{ color: "var(--primary-hover)" }}>{l.hash}</span>
                            {l.refs && <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 12%, transparent)" }}>{l.refs}</span>}
                            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{l.subject}</span>
                            <span className="shrink-0 text-[9.5px] t-dim2">{l.author}</span>
                            <span className="shrink-0 text-[9.5px] t-dim2 w-24 text-right">{l.date}</span>
                          </>}
                        </div>
                      );
                    })}
                    {!graph.length && <div className="grid place-items-center py-10 t-dim2 text-[12px]" style={{ fontFamily: "system-ui" }}>no commits</div>}
                  </div>
                ) : view === "branches" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <div className="flex items-center gap-2 mb-3 max-w-lg">
                        <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createBranch(); }} placeholder="new-branch-name" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={createBranch} disabled={busy || !newBranch.trim()} className="text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: newBranch.trim() ? 1 : 0.5 }}>+ create & switch</button>
                      </div>
                    )}
                    {branchData.branches.map((b) => {
                      const t = trackChip(b.track);
                      return (
                        <div key={b.name} className="group flex items-center gap-2 px-2.5 py-1.5 rounded-md" style={{ background: b.current ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
                          <span className="w-3 text-center text-[11px] shrink-0" style={{ color: "var(--primary-hover)" }}>{b.current ? "⎇" : ""}</span>
                          <button disabled={b.current || !writeEnabled || busy} onClick={() => checkout(b.name)} className="text-[12px] font-medium text-left shrink-0 truncate" style={{ maxWidth: 340, color: b.current ? "var(--text)" : "var(--text2)", cursor: b.current ? "default" : "pointer" }} title={b.name}>{b.name}</button>
                          {(t.ahead > 0 || t.behind > 0) && (
                            <span className="shrink-0 text-[9.5px] tabular-nums">
                              {t.ahead > 0 && <span style={{ color: "var(--success)" }}>↑{t.ahead}</span>}
                              {t.behind > 0 && <span className="ml-1" style={{ color: "var(--warning)" }}>↓{t.behind}</span>}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[10px] t-dim2">{b.subject}</span>
                          <span className="shrink-0 text-[9.5px] t-dim2">{b.date}</span>
                          {writeEnabled && !b.current && (
                            <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100">
                              <button onClick={() => mergeBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Merge ${b.name} into current`}>merge</button>
                              <button onClick={() => rebaseBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Rebase current onto ${b.name}`}>rebase</button>
                              <button onClick={() => renameBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)" }}>rename</button>
                              <button onClick={() => deleteBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }} title="Delete branch">delete</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : view === "stashes" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && <button onClick={stashPush} disabled={busy || tree?.clean} className="mb-3 text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)", opacity: tree?.clean ? 0.5 : 1 }}>⇩ stash all changes</button>}
                    {stashes.map((s) => (
                      <div key={s.ref} className="group flex items-center gap-3 px-2.5 py-1.5 rounded-md" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 16%, transparent)" }}>
                        <span className="shrink-0 text-[10px] tabular-nums t-dim2">{s.ref}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{s.message}</span>
                        {writeEnabled && (
                          <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100">
                            <button onClick={() => stashOp("apply", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>apply</button>
                            <button onClick={() => stashOp("pop", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }}>pop</button>
                            <button onClick={() => stashOp("drop", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }}>drop</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {!stashes.length && <div className="grid place-items-center py-10 t-dim2 text-[12px]">no stashes</div>}
                  </div>
                ) : (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <div className="flex items-center gap-2 mb-3 max-w-lg">
                        <input value={newWtBranch} onChange={(e) => setNewWtBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addWorktree(); }} placeholder="new-branch → new worktree (sibling dir)" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={addWorktree} disabled={busy || !newWtBranch.trim()} className="text-[11px] px-3 py-1.5 rounded-lg font-medium whitespace-nowrap" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: newWtBranch.trim() ? 1 : 0.5 }}>+ add worktree</button>
                      </div>
                    )}
                    {worktrees.map((w) => (
                      <div key={w.path} className="group flex items-center gap-2 px-2.5 py-1.5 rounded-md" style={{ background: w.current ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
                        <span className="w-3 text-center text-[11px] shrink-0" style={{ color: "var(--primary-hover)" }}>{w.current ? "▸" : ""}</span>
                        <button onClick={() => openWorktree(w)} className="text-[12px] font-medium text-left shrink-0" style={{ color: "var(--text)" }} title={`Open ${w.path}`}>{wtName(w.path)}</button>
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>⎇ {w.branch}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">{w.head}</span>
                        {w.locked && <span className="shrink-0 text-[9px]" style={{ color: "var(--warning)" }}>locked</span>}
                        <span className="min-w-0 flex-1 truncate text-[9.5px] t-dim2">{w.path}</span>
                        {writeEnabled && !w.current && <button onClick={() => removeWorktree(w)} className="shrink-0 text-[10px] opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }} title="Remove worktree">remove</button>}
                      </div>
                    ))}
                    {!worktrees.length && <div className="grid place-items-center py-10 t-dim2 text-[12px]">no worktrees</div>}
                  </div>
                )}

                {view === "changes" && (
                  <div className="shrink-0 px-4 py-1 border-t text-[9.5px] t-dim2 flex items-center gap-3" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <span><b className="font-semibold">j/k</b> file</span>
                    <span><b className="font-semibold">s</b> stage</span>
                    <span><b className="font-semibold">u</b> unstage</span>
                    <span><b className="font-semibold">x</b> discard</span>
                    <span className="ml-auto"><b className="font-semibold">⌘/Ctrl+↵</b> commit</span>
                  </div>
                )}
                {toast && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg text-[11px] shadow-xl" style={{ zIndex: 40, background: "var(--bg3)", border: `1px solid ${toast.ok ? "color-mix(in srgb, var(--success) 50%, transparent)" : "color-mix(in srgb, var(--error) 50%, transparent)"}`, color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</div>}
              </motion.div>
            </div>
            {/* a commit's diff, reusing the full file-changes viewer */}
            <ChangesModal open={!!commitView} onClose={() => setCommitView(null)} onBack={() => setCommitView(null)} backLabel="Log" presetChanges={commitView?.changes} presetTitle={commitView?.title} />
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
