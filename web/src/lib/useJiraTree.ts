/*
 * ONE hook for everything the Jira sidebar knows: the spaces the person added,
 * each space's tree, the picker's project list, what this sidebar remembers
 * (open, hidden, pinned, the selection per space), and the site's address.
 *
 * It is a small store behind `useSyncExternalStore` rather than state in one
 * component, because the sidebar and the Add dialog are mounted in different
 * places and have to agree on the list the moment it changes. Nothing polls: a
 * space is read when it is opened, again when asked ("Read this space again"),
 * and the server holds its own minute.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { JiraPickerProject, JiraSpace, JiraSpacesEdit } from "../../../shared/jiraSpaces.ts";
import { EMPTY_PREFS, keyS, parsePrefs, shapesText, type TreeShape, type SpaceRead, type TreePrefs, type TreeSelection, type TreeTarget } from "./jiraTree.ts";

export const TREE_KEY = "agentglass.jira.tree";

export interface PickerState { state: "idle" | "loading" | "ready" | "error"; projects: JiraPickerProject[]; error?: string }

interface Snap {
  listed: boolean;
  listError?: string;
  spaces: JiraSpace[];
  reads: Record<string, SpaceRead | undefined>;
  prefs: TreePrefs;
  site: string | null;
  connected: boolean | null;
  picker: PickerState;
}

const read = (): TreePrefs => { try { return parsePrefs(localStorage.getItem(TREE_KEY)); } catch { return EMPTY_PREFS; } };
let snap: Snap = { listed: false, spaces: [], reads: {}, prefs: EMPTY_PREFS, site: null, connected: null, picker: { state: "idle", projects: [] } };
let loadedPrefs = false;
const subs = new Set<() => void>();
const set = (patch: Partial<Snap>): void => { snap = { ...snap, ...patch }; subs.forEach((f) => f()); };
const prefsNow = (): TreePrefs => { if (!loadedPrefs) { loadedPrefs = true; snap = { ...snap, prefs: read() }; } return snap.prefs; };
const subscribe = (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; };
const getSnap = (): Snap => { prefsNow(); return snap; };

function setPrefs(f: (p: TreePrefs) => TreePrefs): void {
  const next = f(prefsNow());
  try { localStorage.setItem(TREE_KEY, JSON.stringify(next)); } catch { /* private mode: the sidebar still works for this window */ }
  set({ prefs: next });
}

/** The settings door's two ends: every space's layout as `INF:epics,ORB:flat` ("" is all as they were). */
export const treeShapesNow = (): string => shapesText(prefsNow().shape);
export const setTreeShapes = (m: Record<string, TreeShape>): void => setPrefs((p) => ({ ...p, shape: m }));

const seq: Record<string, number> = {};
async function readSpace(key: string, fresh = false): Promise<void> {
  const n = (seq[key] = (seq[key] ?? 0) + 1);
  const before = snap.reads[key];
  set({ reads: { ...snap.reads, [key]: { state: "loading", tree: before?.tree } } });
  let next: SpaceRead;
  try {
    const r = await api.jiraSpaceTree(key, { fresh });
    next = r.ok ? { state: "ready", tree: r } : { state: "error", error: r.error, throttled: r.throttled, staleAt: r.staleAt, tree: before?.tree };
  } catch { next = { state: "error", error: "Could not reach agentglass", tree: before?.tree }; }
  if (n !== seq[key]) return;
  set({ reads: { ...snap.reads, [key]: next } });
}

let listing: Promise<void> | null = null;
function loadList(): Promise<void> {
  listing ??= (async () => {
    try {
      const [r, st] = await Promise.all([api.jiraSpaces(), api.jiraStatus().catch(() => null)]);
      set({ listed: true, listError: undefined, spaces: r.spaces, site: st?.site ?? null, connected: st ? st.connected : null });
    } catch { set({ listed: true, listError: "Could not read your spaces" }); }
    finally { listing = null; }
  })();
  return listing;
}

let pickSeq = 0;
async function loadPicker(q: string): Promise<void> {
  const n = ++pickSeq;
  set({ picker: { state: "loading", projects: snap.picker.projects } });
  try {
    const r = await api.jiraSpacePicker(q);
    if (n !== pickSeq) return;
    set({ picker: r.ok ? { state: "ready", projects: r.projects } : { state: "error", projects: [], error: r.error || "Jira did not answer" } });
  } catch { if (n === pickSeq) set({ picker: { state: "error", projects: [], error: "Could not reach agentglass" } }); }
}

async function edit(e: JiraSpacesEdit): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await api.editJiraSpaces(e);
    if (!r.ok) return { ok: false, error: r.error };
    set({ spaces: r.spaces });
    if ("add" in e) void readSpace(e.add);
    return { ok: true };
  } catch { return { ok: false, error: "Could not reach agentglass" }; }
}

/** Test seam: forget everything, as a fresh window would. */
export function __resetJiraTree(): void {
  snap = { listed: false, spaces: [], reads: {}, prefs: EMPTY_PREFS, site: null, connected: null, picker: { state: "idle", projects: [] } };
  loadedPrefs = false; listing = null; for (const k of Object.keys(seq)) delete seq[k]; subs.forEach((f) => f());
}

export function useJiraTree(enabled: boolean) {
  const s = useSyncExternalStore(subscribe, getSnap);
  useEffect(() => { if (enabled && !s.listed) void loadList(); }, [enabled, s.listed]);
  // A space is read when it is open and nothing has asked yet.
  useEffect(() => {
    if (!enabled || !s.listed) return;
    s.spaces.forEach((sp, i) => {
      if (s.reads[sp.key]) return;
      if (s.prefs.open[keyS(sp.key)] ?? i === 0) void readSpace(sp.key);
    });
  }, [enabled, s.listed, s.spaces, s.reads, s.prefs.open]);

  const selection: TreeSelection | null = s.prefs.last && s.prefs.sel[s.prefs.last] ? { space: s.prefs.last, ...s.prefs.sel[s.prefs.last]! } : null;
  const select = useCallback((sel: TreeSelection | null) => {
    if (!sel) { setPrefs((p) => ({ ...p, last: null })); return; }
    const { space, ...target } = sel;
    setPrefs((p) => ({ ...p, last: space, sel: { ...p.sel, [space]: target as TreeTarget } }));
  }, []);
  const toggle = useCallback((key: string, to: boolean) => setPrefs((p) => ({ ...p, open: { ...p.open, [key]: to } })), []);
  const flag = useCallback((field: "all" | "hideEmpty" | "hidden" | "pinned", key: string, on: boolean) =>
    setPrefs((p) => {
      const m = { ...p[field] };
      if (on) m[key] = true; else delete m[key];
      return { ...p, [field]: m };
    }), []);

  /** One space's layout; "both" (the tree as it was) is stored as nothing. */
  const setShape = useCallback((space: string, shape: TreeShape) =>
    setPrefs((p) => {
      const m = { ...p.shape };
      if (shape === "both") delete m[space]; else m[space] = shape;
      return { ...p, shape: m };
    }), []);

  return {
    ...s,
    setShape,
    /** The seam: the epic, component, space or board last chosen, and the space it belongs to. Null when the pane is on something else (Assigned to me, Looked up). */
    selection,
    select,
    toggle,
    flag,
    setPrefs,
    reload: loadList,
    read: readSpace,
    edit,
    loadPicker,
  };
}
export type JiraTreeApi = ReturnType<typeof useJiraTree>;
