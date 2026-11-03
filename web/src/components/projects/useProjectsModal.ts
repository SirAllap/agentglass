// The Open projects modal's state and actions — everything but the drawing.
//
// Reads come from `GET /git/repos?all=1`; writes are the routes the old picker
// used (roots, hidden, workspace, clone, new). Nothing here is new on the wire
// except the read-only folder check.
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitRepoRef } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { autoPick, withOpenFolders, clickScope, explainOpen, initialTicks, markAnswered, nextScope, rootsToAdd, type OpenRow } from "../../lib/projectPick.ts";
import { SOURCE_ALL, tabsByRoot, type Source } from "../../lib/projectsView.ts";
import { folderToJoin, tildify } from "../../lib/projectsPaths.ts";

export type PaneName = "list" | "folder" | "github" | "clone" | "new" | "result";
export interface Toast { id: number; text: string; undo?: () => void; action?: { label: string; run: () => void } }

/** How long a toast with Undo stays: long enough to read and reach the key. */
export const TOAST_MS = 8000;
/** The "Opened N" state shows this long before the page reloads onto the new scope. */
const OPENED_HOLD_MS = 450;

export function useProjectsModal(o: { open: boolean; workspaces: readonly string[]; known: boolean; onClose: () => void }) {
  const { open, workspaces, onClose } = o;
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [source, setSource] = useState<Source>(SOURCE_ALL);
  const [query, setQuery] = useState("");
  const [hot, setHot] = useState<string | null>(null);
  const [pane, setPane] = useState<PaneName>("list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [results, setResults] = useState<OpenRow[] | null>(null);
  const [opened, setOpened] = useState(false);
  /** The folder last forgotten, so an emptied list says so instead of looking like a first run. */
  const [forgotFolder, setForgotFolder] = useState<{ path: string; count: number } | null>(null);
  const [paneRows, setPaneRows] = useState<Awaited<ReturnType<typeof api.agentPanes>>["panes"]>([]);
  const toastSeq = useRef(0);

  const say = (text: string, extra: Pick<Toast, "undo" | "action"> = {}) => setToast({ id: ++toastSeq.current, text, ...extra });

  /** Only the newest read may draw the list: a slow sweep that landed last
   *  would otherwise put its results under the folders. */
  const loadSeq = useRef(0);
  /** Whole machine (no project open) reads past the folders too, which is what fills "Not on your list". */
  const wide = o.known && !workspaces.length;
  const load = (scan = wide): Promise<GitRepoRef[]> => {
    const n = ++loadSeq.current;
    return api.gitReposAll(scan)
      .then(({ repos, hidden, roots }) => {
        const all = withOpenFolders(repos, workspaces);
        if (n === loadSeq.current) { setRepos(all); setHidden(hidden ?? []); setRoots(roots ?? []); }
        return all;
      })
      .catch(() => { if (n === loadSeq.current) setRepos([]); return []; });
  };

  useEffect(() => {
    if (!open) return;
    setError(""); setPane("list"); setShowHidden(false); setSource(SOURCE_ALL); setQuery(""); setHot(null);
    setToast(null); setResults(null); setOpened(false); setForgotFolder(null); setBusy(false);
    void load().then((listed) => setTicked(initialTicks(workspaces, listed)));
    // One read per opening, never polled: the Tabs column is a glance, not a gauge.
    api.agentPanes().then((r) => setPaneRows(r.panes ?? [])).catch(() => setPaneRows([]));
    // `workspaces` is read once per opening: the list must not re-tick itself
    // under somebody who is halfway through choosing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const failed = (e: unknown) => { setBusy(false); setError(e instanceof Error ? e.message : String(e)); };

  /** Open these projects, together. Anything outside the added folders joins
   *  the list as a folder of its own first (see rootsToAdd), or it would be
   *  missing next time. */
  const openScope = async (list: string[], foldersNow: readonly string[] = roots) => {
    if (busy) return;
    markAnswered();
    // Already there — nothing to change. An empty list is the whole machine.
    if (list.length ? !nextScope(list, workspaces) : !workspaces.length) { onClose(); return; }
    setBusy(true); setError("");
    if (list.length > 1) { setResults(list.map((path) => ({ path, state: "opening" as const }))); setPane("result"); }
    const refuse = async (why: string) => {
      const exists: Record<string, boolean> = {};
      await Promise.all(list.map((p) => api.fsPrecheck(p).then((r) => { exists[p] = r.exists; }).catch(() => { /* unknown counts as present */ })));
      setResults(explainOpen(list, exists, why));
      setPane("result"); setBusy(false);
    };
    try {
      for (const p of rootsToAdd(list, foldersNow)) {
        const r = await api.setProjectRoot(p, true);
        if (!r.ok) { await refuse(r.error || "Could not add that folder to the list"); return; }
      }
      const res = await api.setWorkspaces(list);
      if (!res.ok) { await refuse(res.error || "Could not switch project"); return; }
      if (res.note) console.warn(`[agentglass] ${res.note}`);
      else if (!res.persisted) console.warn("[agentglass] project choice applied but could not be saved — it won't survive a server restart");
      setResults(list.map((path) => ({ path, state: "ok" as const })));
      // Everything on screen — events, repos, sessions — belongs to the old
      // scope. A clean reload is the honest way to rescope all of it; with
      // several projects the result stays up for a moment first.
      if (list.length > 1) { setOpened(true); setTimeout(() => location.reload(), OPENED_HOLD_MS); } else location.reload();
    } catch (e) { failed(e); }
  };
  const close = () => { markAnswered(); onClose(); };
  const choose = (root: string) => { const next = clickScope(root, workspaces); if (next) void openScope(next); else close(); };
  const back = () => { setPane("list"); setError(""); };

  /** Add a folder to the list; says how many projects it brought (and opens
   *  the project at once when it held exactly one and nothing is open). */
  const addRoot = async (dir: string): Promise<boolean> => {
    if (busy || !dir.trim()) return false;
    setBusy(true); setError("");
    try {
      const before = new Set((repos ?? []).map((r) => r.root));
      const r = await api.setProjectRoot(dir.trim(), true);
      if (!r.ok) { failed(r.error || "Could not add that folder"); return false; }
      if (r.note) setError(r.note);
      const listed = await load();
      setBusy(false);
      const fresh = listed.filter((x) => !before.has(x.root)).length;
      const added = dir.trim();
      setForgotFolder(null); setPane("list"); setSource({ kind: "folder", root: added.replace(/\/+$/, "") });
      say(fresh ? `Added ${added} · ${fresh} project${fresh === 1 ? "" : "s"}` : `Added ${added} · no git repositories in it yet`,
        { undo: () => void forgetFolder(added, true) });
      const only = autoPick(listed, workspaces);
      if (only) void openScope([only], r.roots);
      return true;
    } catch (e) { failed(e); return false; }
  };

  /** Take a folder off the list. The folder itself is never touched. */
  const forgetFolder = async (dir: string, quiet = false) => {
    if (busy) return;
    const count = (repos ?? []).filter((r) => r.root === dir || r.root.startsWith(dir.replace(/\/+$/, "") + "/")).length;
    try {
      const r = await api.setProjectRoot(dir, false);
      if (!r.ok) { setError(r.error || "Could not save that"); return; }
      if (r.note) setError(r.note);
      setSource((s) => (s.kind === "folder" && s.root === dir.replace(/\/+$/, "") ? SOURCE_ALL : s));
      await load();
      if (quiet) return;
      if (!r.roots.length) setForgotFolder({ path: dir, count });
      say(`Forgot ${tildify(dir)} · files untouched`, { undo: () => { setForgotFolder(null); void api.setProjectRoot(dir, true).then(() => load()); } });
    } catch (e) { setError(String(e)); }
  };

  /** Take a project off the list, or put it back. Optimistic — a local call, and a
   *  round trip before the row moves makes it feel broken; a failure puts it back. */
  const toggleHidden = (root: string, name?: string) => {
    const wasHidden = hidden.includes(root);
    const flip = (on: boolean) => setHidden((h) => (on ? [...h, root] : h.filter((p) => p !== root)));
    flip(!wasHidden);
    if (!wasHidden) say(`Forgot ${name ?? root} · files untouched`, { undo: () => toggleHidden(root, name) });
    api.hideProject(root, !wasHidden)
      .then((r) => { if (r.ok) setHidden(r.hidden); else { flip(wasHidden); setError(r.error || "Could not save that"); } })
      .catch((e) => { flip(wasHidden); setError(String(e)); });
  };

  const tickOnly = (next: string[]) => setTicked(next);
  const toggleTick = (root: string) => setTicked((t) => (t.includes(root) ? t.filter((p) => p !== root) : [...t, root]));

  /** A clone or a new project: join the folder it sits in (or itself when that
   *  folder is refused), then open it. One entry per folder, not per project. */
  const adopt = async (path: string, parent: string) => {
    let folders: readonly string[] = roots;
    const want = folderToJoin(path, parent, roots);
    if (want) {
      let r = await api.setProjectRoot(want, true);
      if (!r.ok && want !== path) r = await api.setProjectRoot(path, true);
      if (r.ok) folders = r.roots;
    }
    choose2(path, folders);
  };
  const choose2 = (root: string, foldersNow: readonly string[]) => {
    const next = clickScope(root, workspaces);
    if (next) void openScope(next, foldersNow); else close();
  };

  const tabs = useMemo(() => tabsByRoot(paneRows, (repos ?? []).map((r) => r.root)), [paneRows, repos]);

  return {
    tabs, repos, roots, hidden, showHidden, setShowHidden, ticked, setTicked: tickOnly, toggleTick, source, setSource, query, setQuery, hot, setHot,
    pane, setPane, busy, setBusy, error, setError, toast, setToast, say, results, setResults, opened, forgotFolder, setForgotFolder,
    load, openScope, choose, close, back, addRoot, forgetFolder, toggleHidden, adopt,
  };
}
