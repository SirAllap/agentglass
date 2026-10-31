import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { onPolarisChanged } from "../../lib/polarisLive.ts";
import type { ItemsAnswer, SettingsAnswer, SettingsChange } from "../../../../shared/polaris.ts";

/*
 * What the window reads of Polaris, and the one write it makes.
 *
 * Settings are read when a page opens and when the project changes; items are read
 * with them and again after a click, a refresh, or the server's word that a pull request
 * event arrived (a "polaris" frame on the socket the window already has). Nothing polls.
 */

const REACH = "Could not reach the server.";

export function usePolarisSettings(root: string) {
  const [answer, setAnswer] = useState<SettingsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(() => {
    void api.polarisSettings(root || undefined).then((r) => {
      if (!alive.current) return;
      if (r.ok) { setAnswer(r); setError(null); } else setError(r.error);
    }).catch(() => { if (alive.current) setError(REACH); });
  }, [root]);
  // A different project is a different answer: drop the old one so it is never shown under the new name.
  useEffect(() => { setAnswer(null); load(); }, [load]);
  useEffect(() => onPolarisChanged(load), [load]);

  /** The server's sentence when it refused, or null when it saved. */
  const save = useCallback(async (change: SettingsChange): Promise<string | null> => {
    setBusy(true);
    const r = await api.polarisSettingsSave(change, root || undefined).catch(() => ({ ok: false, error: REACH } as const));
    if (!alive.current) return null;
    setBusy(false);
    if (!r.ok) { setError(r.error); return r.error; }
    setAnswer(r); setError(null);
    return null;
  }, [root]);

  return { answer, error, busy, save, reload: load };
}

export function usePolarisItems(root: string, active: boolean) {
  const [settings, setSettings] = useState<SettingsAnswer | null>(null);
  const [items, setItems] = useState<ItemsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(() => {
    if (!root) return;
    void api.polarisSettings(root).then(async (s) => {
      if (!alive.current) return;
      if (!s.ok) { setSettings(null); setItems(null); setError(s.error); return; }
      setSettings(s);
      if (!s.enabled) { setItems(null); setError(null); return; }
      const i = await api.polarisItems(root);
      if (!alive.current) return;
      if (i.ok) { setItems(i); setError(null); } else setError(i.error);
    }).catch(() => { if (alive.current) setError(REACH); });
  }, [root]);
  useEffect(() => { setSettings(null); setItems(null); setError(null); if (active) reload(); }, [active, reload]);
  useEffect(() => (active ? onPolarisChanged(reload) : undefined), [active, reload]);

  return { settings, items, error, reload };
}
