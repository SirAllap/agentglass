import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { recallScope, rememberScope } from "../../orchestration/orchestrationCopy.ts";
import { choiceFor, pickedProject, projectList, rootFor, type ScopeChoice } from "./scopeModel.ts";

const store = (): Storage | null => { try { return localStorage; } catch { return null; } };

type ReposAll = Awaited<ReturnType<typeof api.gitReposAll>>;
let reposScan: Promise<ReposAll> | null = null;
/**
 * The scanned repo list, once per app session. scan=1 is the explicit "look for projects" sweep (git
 * status on every place an agent ran), so the scope control must not start it on every mount. A failed
 * sweep is forgotten, so the next mount tries again.
 */
export function scannedReposOnce(): Promise<ReposAll> {
  reposScan ??= api.gitReposAll(true).catch((e) => { reposScan = null; throw e; });
  return reposScan;
}
/** Forget the cached sweep (tests; and see invalidateScannedRepos). */
export const resetScannedRepos = () => { reposScan = null; };

/** Fired on window when the cached sweep was dropped, so a mounted scope control reads the list again. */
export const REPOS_CHANGED = "agx:scanned-repos-changed";

/**
 * Drop the cached sweep and tell the mounted scope controls. Called when a project is hidden or shown
 * again (the hidden list changed) and when the window gets focus (a folder may have appeared meanwhile).
 */
export function invalidateScannedRepos() {
  reposScan = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REPOS_CHANGED));
}

let focusHooked = false;
/** One window focus listener for the whole app, not one per mounted control: one sweep per focus. */
function hookFocus() {
  if (focusHooked || typeof window === "undefined") return;
  focusHooked = true;
  window.addEventListener("focus", invalidateScannedRepos);
}

/**
 * The one scope every per-project page reads: the project the app has open and
 * whether the page shows All projects or Only that project. The choice is
 * remembered for the window, so the pages agree and leaving Settings does not
 * read as a value being lost. A remembered project that is not the open one
 * reads as All projects.
 */
export function useScope() {
  const chosen = useRef(recallScope(store()) !== null);
  const [stored, setStored] = useState(() => recallScope(store()) ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [known, setKnown] = useState(false);
  const [listed, setListed] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    void api.projects().then((r) => {
      if (!live) return;
      setOpen(r.workspace ?? r.workspaces?.[0] ?? null);
      setWorkspaces(r.workspaces ?? (r.workspace ? [r.workspace] : []));
      setKnown(true);
    }).catch(() => { /* no project to pick without a list */ });
    // Every project the app knows (scanned folders + recent), the same list the Open projects dialog shows.
    // scan (once per session, scannedReposOnce): without it the menu read only the registered repos (2 on a machine with 13), so it still missed projects the Open projects dialog lists. Hidden ones stay out.
    const readRepos = () => void scannedReposOnce().then((r) => { const hid = new Set(r.hidden ?? []); if (!live) return; setHidden(hid); setListed(r.repos.map((x) => x.root).filter((x) => !hid.has(x))); }).catch(() => { /* the open ones still list */ });
    readRepos();
    hookFocus();
    window.addEventListener(REPOS_CHANGED, readRepos);
    return () => { live = false; window.removeEventListener(REPOS_CHANGED, readRepos); };
  }, []);
  const projects = useMemo(() => projectList(workspaces, open, listed), [workspaces, open, listed]);
  const project = pickedProject(stored, projects, open);
  // Never chosen: the page opens on the project the app shows.
  const choice: ScopeChoice = chosen.current ? choiceFor(stored, project) : project ? "project" : "all";
  const setChoice = useCallback((next: ScopeChoice) => {
    chosen.current = true;
    const root = rootFor(next, project);
    rememberScope(store(), root);
    setStored(root);
  }, [project]);
  /** Scope the page to one project from the list. */
  const pick = useCallback((root: string) => {
    chosen.current = true;
    rememberScope(store(), root);
    setStored(root);
  }, []);
  const controlProps = { project, projects, value: choice, onChange: setChoice, onPick: pick };
  return { project, projects, hidden, known, choice, root: rootFor(choice, project), chosen: chosen.current, setChoice, pick, controlProps };
}
