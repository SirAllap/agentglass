/*
 * The banners for notifications the person asked for.
 *
 * Everything else agentglass raises is a quiet badge or a toast that goes away.
 * A PR watch they armed is a promise, so what it raises stays until they deal
 * with it: they open it, press Escape on it, or close it. Nothing here has a
 * timer.
 *
 * Three rules, each one a thing that went wrong or would:
 *  - at most three are drawn; older ones fold into "+N" and come back out as the
 *    newer ones are answered, so a burst cannot cover the window;
 *  - one that was closed is not raised again, by id or by key, whichever window
 *    or poll brings it back;
 *  - closing tells the server, which tells every other window and the phone.
 *
 * The store holds data and answers; drawing is AskedBanners.tsx.
 */
import { useSyncExternalStore } from "react";
import type { AskedAlert } from "../../../shared/notifyPayload.ts";
import { api } from "./api.ts";

/** How many are drawn at once. */
export const MAX_SHOWN = 3;

let open: AskedAlert[] = [];
/** Ids and keys of what has been answered, so the same event is not raised again. Memory only: the server's key is what survives a restart. */
const answered = new Set<string>();
const subs = new Set<() => void>();
const changed = () => { for (const fn of subs) fn(); };

/** Newest first, split into what is drawn and how many are folded away. */
export function layoutBanners(list: readonly AskedAlert[], max = MAX_SHOWN): { shown: AskedAlert[]; more: number } {
  const ordered = [...list].sort((a, b) => b.firedAt - a.firedAt);
  return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
}

/** Raise one. A no-op for something already showing or already answered. */
export function showAsked(a: AskedAlert): void {
  if (answered.has(a.id) || answered.has(a.key)) return;
  if (open.some((x) => x.id === a.id || x.key === a.key)) return;
  open = [...open, a];
  changed();
  if (a.seenAt === null) void api.askedSeen(a.id).catch(() => {}); // a restored one was drawn before: its first sight is already on record
}

function drop(id: string): AskedAlert | undefined {
  const hit = open.find((x) => x.id === id);
  if (!hit) return undefined;
  answered.add(hit.id); answered.add(hit.key);
  open = open.filter((x) => x.id !== id);
  changed();
  return hit;
}

/** The person answered it here: tell the server, which closes it everywhere. */
export function closeAsked(id: string, acted: boolean): void {
  if (!drop(id)) return;
  void api.askedClose(id, acted).catch(() => {});
}

/** Another window (or the phone) answered it: take it down without telling the server again. */
export function closedElsewhere(id: string): void { drop(id); }

/** What the server is still holding for this person: asked again on every (re)connect, so a reload or a restart brings the banners back. */
export async function restoreAsked(): Promise<void> {
  try {
    const r = await api.askedAlerts();
    for (const a of r?.open ?? []) showAsked(a);
  } catch { /* the next connect asks again */ }
}

/** What is waiting right now. */
export const askedNow = (): readonly AskedAlert[] => open;

export function useAskedBanners(): AskedAlert[] {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    () => open,
    () => open,
  );
}

/** Tests only. */
export function __resetAskedBanners(): void { open = []; answered.clear(); changed(); }
