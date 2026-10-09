/*
 * The state half of saved filter sets: what is stored, which one is on, and the
 * one delete that can still be taken back. The data rules live in
 * lib/filterPresets.ts; this only holds them in React and in localStorage.
 *
 * Why a hook beside the board rather than lines in PrPanel: that file is twelve
 * thousand lines, and this has a state machine of its own (apply, modify,
 * update, delete, undo) that wants to be read in one piece.
 *
 * Reads go through `readPresetMap`, so a value another build wrote in a shape
 * this one does not know is dropped rather than carried in. Storage is the same
 * place and for the same reasons as the live filter's own key (FILTERS_KEY in
 * PrPanel): per repository, in this browser, nothing sent anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { liveCount, type FieldSpec, type FilterSet } from "./tasks/filters.ts";
import {
  ACTIVE_KEY, PRESETS_KEY, addPreset, deletePreset, dropGone, goneValues, isModified, movePreset, presetToFilterSet,
  readActiveMap, readPresetMap, renamePreset, restorePreset, setPresetRules, updatePreset,
  type Edit, type Gone, type Preset, type Removed,
} from "../lib/filterPresets.ts";

/** How long a delete can be taken back. */
export const UNDO_MS = 6000;

const read = (k: string): unknown => {
  try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; }
};
const write = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: it lasts until the page does */ }
};

let seq = 0;
/** Ids that cannot collide with the builder's own `r1`, `r2`…, which it keys its rows by. */
const ruleId = () => `pr${++seq}`;
const presetId = () => `fp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type PresetFailure = Extract<Edit, { ok: false }>["reason"];

export interface PresetsApi {
  presets: Preset[];
  activeId: string | null;
  active: Preset | null;
  /** The live rules differ from the active preset's. Derived on every render. */
  modified: boolean;
  gone: Record<string, Gone[]>;
  undo: { name: string; id: string } | null;
  apply: (id: string) => void;
  saveNew: (name: string) => PresetFailure | null;
  update: () => PresetFailure | null;
  revert: () => void;
  rename: (id: string, name: string) => PresetFailure | null;
  move: (id: string, dir: -1 | 1) => void;
  remove: (id: string) => void;
  restore: () => void;
  removeGone: (id: string) => void;
}

export function useFilterPresets({ repoKey, rules, setRules, fields }: {
  repoKey: string | null;
  rules: FilterSet;
  setRules: (f: FilterSet) => void;
  fields: FieldSpec[];
}): PresetsApi {
  const [map, setMap] = useState(() => readPresetMap(read(PRESETS_KEY)));
  const [actives, setActives] = useState(() => readActiveMap(read(ACTIVE_KEY)));
  const [removed, setRemoved] = useState<Removed | null>(null);
  // The latest of each, for actions that need an answer now: a rename must say
  // "taken" before the next render, not after it.
  const mapRef = useRef(map);
  mapRef.current = map;

  const key = repoKey ?? "";
  const cur = () => mapRef.current[key] ?? [];
  const presets = useMemo(() => (repoKey ? map[repoKey] ?? [] : []), [map, repoKey]);

  const commit = useCallback((list: Preset[]) => {
    if (!repoKey) return;
    // `mapRef` is kept current by the storage listener below, so another
    // window's other repositories are not written back as they were at open.
    const next = { ...mapRef.current, [repoKey]: list };
    mapRef.current = next;
    setMap(next);
    write(PRESETS_KEY, next);
  }, [repoKey]);

  const setActive = useCallback((id: string | null) => {
    if (!repoKey) return;
    setActives((cur) => {
      if ((cur[repoKey] ?? null) === id) return cur;
      const next = { ...cur };
      if (id) next[repoKey] = id; else delete next[repoKey];
      write(ACTIVE_KEY, next);
      return next;
    });
  }, [repoKey]);

  /* On only while there is something on: "Clear all" (or deleting the last
     rule) is no preset. The stored id is forgotten then, not merely hidden, so
     building a different filter afterwards is not measured against the old one. */
  const hasRules = liveCount(rules) > 0;
  const stored = actives[key] ?? null;
  const active = hasRules && stored ? presets.find((p) => p.id === stored) ?? null : null;
  /* Forgotten on the TRANSITION to no rules inside one repository, not whenever
     there are none: on a repository switch the first render has the new key and
     the old rules (the panel loads the new ones in an effect), and "no rules"
     there is not the person clearing anything. */
  const before = useRef({ key, hasRules });
  useEffect(() => {
    const b = before.current;
    before.current = { key, hasRules };
    if (b.key === key && b.hasRules && !hasRules && stored) setActive(null);
  }, [key, hasRules, stored, setActive]);

  // Another window wrote: take its lists rather than overwrite them on the next save.
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === PRESETS_KEY) { const m = readPresetMap(read(PRESETS_KEY)); mapRef.current = m; setMap(m); }
      else if (e.key === ACTIVE_KEY) setActives(readActiveMap(read(ACTIVE_KEY)));
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const apply = useCallback((id: string) => {
    const p = mapRef.current[key]?.find((x) => x.id === id);
    if (!p) return;
    setRules(presetToFilterSet(p, ruleId));
    setActive(id);
  }, [key, setRules, setActive]);

  const saveNew = useCallback((name: string): PresetFailure | null => {
    const r = addPreset(cur(), name, rules, presetId());
    if (!r.ok) return r.reason;
    commit(r.list);
    setActive(r.preset.id);
    return null;
  }, [key, rules, commit, setActive]);

  const update = useCallback((): PresetFailure | null => {
    if (!active) return "missing";
    const r = updatePreset(cur(), active.id, rules);
    if (!r.ok) return r.reason;
    commit(r.list);
    return null;
  }, [key, active, rules, commit]);

  const revert = useCallback(() => { if (active) apply(active.id); }, [active, apply]);

  const rename = useCallback((id: string, name: string): PresetFailure | null => {
    const r = renamePreset(cur(), id, name);
    if (!r.ok) return r.reason;
    commit(r.list);
    return null;
  }, [key, commit]);

  const move = useCallback((id: string, dir: -1 | 1) => {
    const list = cur();
    const next = movePreset(list, id, dir);
    if (next !== list) commit(next);
  }, [key, commit]);

  const remove = useCallback((id: string) => {
    const d = deletePreset(cur(), id);
    if (!d) return;
    commit(d.list);
    if (stored === id) setActive(null);
    setRemoved(d.removed);
  }, [key, stored, commit, setActive]);

  /* Six seconds, and a second delete replaces the first's chance: one undo, the
     last one, is what a toast can honestly offer. */
  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [removed]);
  // The repository changed under the toast: its undo belongs to the other list.
  useEffect(() => { setRemoved(null); }, [repoKey]);

  const restore = useCallback(() => {
    if (!removed) return;
    const next = restorePreset(cur(), removed);
    setRemoved(null);
    if (next) commit(next);
  }, [key, removed, commit]);

  const gone = useMemo(() => {
    const out: Record<string, Gone[]> = {};
    for (const p of presets) {
      const g = goneValues(p.rules, fields);
      if (g.length) out[p.id] = g;
    }
    return out;
  }, [presets, fields]);

  const removeGone = useCallback((id: string) => {
    const list = cur();
    const p = list.find((x) => x.id === id);
    if (!p) return;
    const rulesNow = dropGone(p.rules, fields);
    // Nothing left would be a preset that filters nothing; the menu offers
    // Edit rule or Delete for that, and this is the second lock.
    if (!rulesNow.length) return;
    commit(setPresetRules(list, id, rulesNow));
    // The board follows the repair when this is the preset on it and the person
    // has not edited it since; unsaved edits are theirs and stay.
    if (stored === id && !isModified(p, rules)) setRules(presetToFilterSet({ join: p.join, rules: rulesNow }, ruleId));
  }, [key, fields, stored, rules, commit, setRules]);

  const modified = useMemo(() => !!active && isModified(active, rules), [active, rules]);
  const undo = useMemo(() => (removed ? { name: removed.preset.name, id: removed.preset.id } : null), [removed]);
  // One object per change of what it holds, not one per render of the panel:
  // the row is memoised on it, and the Alt+1..9 listener hangs off it.
  return useMemo(() => ({
    presets, activeId: active?.id ?? null, active, modified, gone, undo,
    apply, saveNew, update, revert, rename, move, remove, restore, removeGone,
  }), [presets, active, modified, gone, undo, apply, saveNew, update, revert, rename, move, remove, restore, removeGone]);
}
