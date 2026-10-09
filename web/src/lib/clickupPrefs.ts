/*
 * How this workspace uses ClickUp, read once and shared.
 *
 * The same shape as clickupSetup: a surface that is not the settings page (the
 * pull-request sidebar deciding whether to offer the hand-off) asks here, and
 * twenty cards are one read. Held for a minute, and replaced the moment the
 * settings page saves, so a switch flipped there is seen by the sidebar that is
 * already open and not a minute later.
 *
 * Null is "not known yet", which callers must treat as OFF: the settings that
 * gate a write start off, and a control that flashes on and disappears once the
 * answer arrives is worse than one that appears a beat late.
 *
 * Null is also "no ClickUp here": nothing is requested until the setup read
 * says a token exists, so a machine that never connected makes no ClickUp-shaped
 * call for a setting nobody can use. The setup read is local and already shared
 * with the pull-request masthead.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { clickupSetup } from "./clickupSetup.ts";
import type { ClickUpPrefs } from "../../../shared/providers.ts";

const TTL = 60_000;
let held: { at: number; value: ClickUpPrefs } | null = null;
let inflight: Promise<ClickUpPrefs | null> | null = null;
const listeners = new Set<(p: ClickUpPrefs) => void>();

const fresh = (): ClickUpPrefs | null => (held && Date.now() - held.at < TTL ? held.value : null);

export function clickupPrefs(): Promise<ClickUpPrefs | null> {
  const now = fresh();
  if (now) return Promise.resolve(now);
  // A failure is not cached: a server down for a moment should not hide the
  // control for the next minute. It answers null, which reads as off.
  inflight ??= clickupSetup()
    .then((s) => (s.connected ? api.clickupPrefs() : null))
    .then((r) => {
      if (!r?.ok || !r.prefs) return null;
      held = { at: Date.now(), value: r.prefs };
      return r.prefs;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** For the moment the credential changes: what was read under the old one goes. */
export function __forgetClickupPrefs(): void { held = null; }

/** A save landed: everyone watching sees the saved settings at once. */
export function clickupPrefsSaved(p: ClickUpPrefs): void {
  held = { at: Date.now(), value: p };
  for (const l of listeners) l(p);
}

export function useClickupPrefs(): ClickUpPrefs | null {
  const [prefs, setPrefs] = useState<ClickUpPrefs | null>(fresh);
  useEffect(() => {
    let live = true;
    void clickupPrefs().then((v) => { if (live && v) setPrefs(v); });
    listeners.add(setPrefs);
    return () => { live = false; listeners.delete(setPrefs); };
  }, []);
  return prefs;
}
