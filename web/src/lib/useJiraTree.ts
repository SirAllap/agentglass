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
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { JiraPickerProject, JiraProjectBoard, JiraSpace, JiraSpacesEdit } from "../../../shared/jiraSpaces.ts";
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
  /** A space's own boards, for its "Column order from board" picker. Read once, on first open of the picker. */
  boards: Record<string, { state: "loading" | "ready" | "error"; boards: JiraProjectBoard[] }>;
}

const read = (): TreePrefs => { try { return parsePrefs(localStorage.getItem(TREE_KEY)); } catch { return EMPTY_PREFS; } };
let snap: Snap = { listed: false, spaces: [], reads: {}, prefs: EMPTY_PREFS, site: null, connected: null, picker: { state: "idle", projects: [] }, boards: {} };
let loadedPrefs = false;
const subs = new Set<() => void>();
const set = (patch: Partial<Snap>): void => { snap = { ...snap, ...patch }; subs.forEach((f) => f()); };
const prefsNow = (): TreePrefs => { if (!loadedPrefs) { loadedPrefs = true; snap = { ...snap, prefs: read() }; } return snap.prefs; };
const subscribe = (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; };
const getSnap = (): Snap => { prefsNow(); return snap; };
/** The sidebar's spaces and what was read of them, for the jump box: it only looks, it never asks the site for a space. */
export const subscribeJiraTree = subscribe;
export const jiraTreeNow = getSnap;

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

/** A failed read is not the space's state: it is asked again when the space is opened, when the tab is shown and on a refresh. */
export function retryFailedReads(only?: string): void {
  // A throttled space waits out the server's hold; the rest go a few at a time, so thirty failures are not thirty calls at once.
  const keys = Object.entries(snap.reads).filter(([k, r]) => r?.state === "error" && !r.throttled && (only === undefined || only === k)).map(([k]) => k);
  let next = 0;
  const lane = async (): Promise<void> => { while (next < keys.length) await readSpace(keys[next++]!); };
  for (let i = 0; i < Math.min(RETRY_LANES, keys.length); i++) void lane();
}
const RETRY_LANES = 3;

let listing: Promise<void> | null = null;
function loadList(): Promise<void> {
  listing ??= (async () => {
    try {
      const [r, st] = await Promise.all([api.jiraSpaces(), api.jiraStatus().catch(() => null)]);
      set({ listed: true, listError: undefined, spaces: r.spaces, site: st?.site ?? null, connected: st ? st.connected : null });
      retryFailedReads();
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

/** A project's own boards, for its "Column order" picker. Read once per window: the server already holds it ten minutes. */
async function loadBoards(key: string): Promise<void> {
  if (snap.boards[key]) return;
  set({ boards: { ...snap.boards, [key]: { state: "loading", boards: [] } } });
  try {
    const r = await api.jiraProjectBoards(key);
    set({ boards: { ...snap.boards, [key]: { state: r.ok ? "ready" : "error", boards: r.boards ?? [] } } });
  } catch { set({ boards: { ...snap.boards, [key]: { state: "error", boards: [] } } }); }
}

/** The space's own pick for its column order; `undefined` goes back to Automatic. */
async function setColumnBoard(key: string, boardId: string | undefined): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await api.jiraSetSpaceColumnBoard(key, boardId);
    if (!r.ok) return { ok: false, error: r.error };
    set({ spaces: r.spaces });
    return { ok: true };
  } catch { return { ok: false, error: "Could not reach agentglass" }; }
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
  snap = { listed: false, spaces: [], reads: {}, prefs: EMPTY_PREFS, site: null, connected: null, picker: { state: "idle", projects: [] }, boards: {} };
  loadedPrefs = false; listing = null; for (const k of Object.keys(seq)) delete seq[k]; subs.forEach((f) => f());
}

export function useJiraTree(enabled: boolean) {
  const s = useSyncExternalStore(subscribe, getSnap);
  useEffect(() => { if (enabled && !s.listed) void loadList(); }, [enabled, s.listed]);
  // The tab shown again: a read that failed while it was away is asked once more (not on every state change, or a space that keeps failing would loop). The first load retries through loadList, so this skips it.
  const shown = useRef(false);
  useEffect(() => { if (enabled && shown.current && s.listed) retryFailedReads(); shown.current = enabled; }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const toggle = useCallback((key: string, to: boolean, rawSpace?: string) => {
    setPrefs((p) => ({ ...p, open: { ...p.open, [key]: to } }));
    const space = rawSpace ?? Object.keys(snap.reads).find((k) => keyS(k) === key);
    if (to && space) retryFailedReads(space);
  }, []);
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
    loadBoards,
    setColumnBoard,
  };
}
export type JiraTreeApi = ReturnType<typeof useJiraTree>;
