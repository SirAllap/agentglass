/*
 * What gets opened, counted on this machine so the next cut is made on numbers.
 *
 * Each time the person opens a view, a Settings page, a panel or a modal the
 * window adds one to that id. The counts leave in batches to POST /usage/opens
 * (server/src/usageopens.ts), which keeps them in one small file in the state
 * dir; nothing is sent anywhere else and nothing is polled. A batch goes when
 * the first open of it is 15 seconds old, or as soon as the window is hidden.
 *
 * The ids are this file's own names (`view:git`, `settings:about`,
 * `panel:skills`, `machine:ports`) and never a title, a path or anything typed.
 * What it does not count: the bench, the Git modals and the dashboard's own
 * cards. Those are the next family to add if the numbers say they matter.
 */
import { useEffect, useRef } from "react";
import { IS_DEMO, SERVER, authHeaders } from "./api.ts";

const BATCH_MS = 15_000;

const pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

/** Count one open of `id`. */
export function noteOpen(id: string): void {
  if (IS_DEMO) return;
  pending.set(id, (pending.get(id) ?? 0) + 1);
  wire();
  if (!timer) timer = setTimeout(() => { void flushOpens(); }, BATCH_MS);
}

/** Send what has been counted. A failed send puts the counts back for the next batch. */
export async function flushOpens(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending.size) return;
  const opens = Object.fromEntries(pending);
  pending.clear();
  try {
    // `keepalive` so a flush on the way out of the page still goes; the plain
    // `post` helper waits for the server to be up first, which an unload cannot.
    const r = await fetch(SERVER + "/usage/opens", {
      method: "POST", keepalive: true,
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ opens }),
    });
    if (!r.ok && r.status >= 500) throw new Error(String(r.status));
  } catch {
    // Back into the table, not rescheduled: the next open starts the next batch,
    // so an unreachable server is not asked again on a clock.
    for (const [id, n] of Object.entries(opens)) pending.set(id, (pending.get(id) ?? 0) + n);
  }
}

function wire(): void {
  if (wired || typeof document === "undefined") return;
  wired = true;
  document.addEventListener("visibilitychange", () => { if (document.hidden) void flushOpens(); });
  window.addEventListener("pagehide", () => { void flushOpens(); });
}

export type OpenSnapshot = Record<string, string | boolean | null>;

/** The ids that became open between two snapshots: a view that changed, a modal that went from shut to open, a machine tab that changed. */
export function opensBetween(prev: OpenSnapshot | null, next: OpenSnapshot): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(next)) {
    if (!v || (prev && prev[key] === v)) continue;
    if (key === "view") out.push(`view:${v}`);
    else if (key === "machine") out.push(`machine:${v}`);
    else out.push(`panel:${key}`);
  }
  return out;
}

/** Count the opens in `snap` each time it changes. The first snapshot counts: the window opens on a view. */
export function useUsageOpens(snap: OpenSnapshot): void {
  const prev = useRef<OpenSnapshot | null>(null);
  const key = JSON.stringify(snap);
  useEffect(() => {
    for (const id of opensBetween(prev.current, snap)) noteOpen(id);
    prev.current = snap;
  }, [key]);
}

/** For tests: forget everything counted and the timer. */
export function __resetUsageOpens(): void {
  pending.clear();
  if (timer) { clearTimeout(timer); timer = null; }
}
