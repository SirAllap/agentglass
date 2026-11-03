import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { PilotSettings } from "../../lib/flightPilot.ts";
import { DEFAULT_PILOT_SETTINGS, FIELDS, PILOT_KEYS, decode, encode, noteFor, type Field, type RowNote } from "../../lib/pilotSettings.ts";

const NET = { ok: false, error: "could not reach the server" } as { ok: boolean; applied?: boolean; error?: string };

/*
 * THE PILOT SETTINGS OF ONE PROJECT, one door call per key.
 *
 * A read that comes back not-ok is a key the engine has not shipped yet: the row
 * keeps its default and says so only if the person changes it. Only a read that
 * cannot reach the server at all, for every key, is a failed load. A write is
 * optimistic and rolls back on any refusal, so a control never shows a value
 * the engine did not take. A rollback only happens if the control still shows
 * what that write put there, so a quick second edit is not undone by the first.
 */
export function usePilotSettings(root: string, onSaved: () => void) {
  const [settings, setSettings] = useState<PilotSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notes, setNotes] = useState<Partial<Record<Field, RowNote>>>({});
  const [saving, setSaving] = useState<Partial<Record<Field, number>>>({});
  const cur = useRef<PilotSettings | null>(null);
  const live = useRef(true);
  const reads = useRef(0);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(async () => {
    const n = ++reads.current;
    setLoadError("");
    const got = await Promise.all(FIELDS.map((f) => {
      const k = PILOT_KEYS[f];
      return api.settingAt(k.id, k.scope === "project" ? root : "").then((r) => ({ f, r })).catch(() => ({ f, r: null }));
    }));
    if (!live.current || n !== reads.current) return;
    if (got.every((g) => g.r === null)) { setLoadError("could not reach the server"); return; }
    const next: Record<string, unknown> = { ...DEFAULT_PILOT_SETTINGS };
    for (const { f, r } of got) {
      const v = r?.ok ? decode(f, r.value) : undefined;
      if (v !== undefined) next[f] = v;
    }
    cur.current = next as unknown as PilotSettings;
    setSettings(cur.current);
  }, [root]);
  useEffect(() => { setSettings(null); cur.current = null; void load(); }, [load]);

  const put = (f: Field, v: unknown) => { cur.current = { ...cur.current!, [f]: v } as PilotSettings; setSettings(cur.current); };
  const bump = (f: Field, d: number) => setSaving((s) => ({ ...s, [f]: Math.max(0, (s[f] ?? 0) + d) }));

  const write = async (f: Field, value: unknown) => {
    const prev = cur.current![f];
    put(f, value); bump(f, 1);
    setNotes((m) => ({ ...m, [f]: undefined }));
    const k = PILOT_KEYS[f];
    const r = await api.settingAtSet(k.id, encode(f, value as never), k.scope === "project" ? root : "").catch(() => NET);
    if (!live.current) return;
    bump(f, -1);
    const note = noteFor(r);
    setNotes((m) => ({ ...m, [f]: note ?? undefined }));
    if (!note) { onSaved(); return; }
    if (JSON.stringify(cur.current?.[f]) === JSON.stringify(value)) put(f, prev);
  };

  const change = useCallback((patch: Partial<PilotSettings>) => {
    if (!cur.current) return;
    for (const f of Object.keys(patch) as Field[]) void write(f, patch[f]);
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps

  return { settings, loadError, notes, saving, change, reload: load };
}
