/*
 * How far this phone has been told, per computer: the cursor of the newest
 * open alert it has seen (watchAlerts.ts). What a reconnect reads back starts there, so the
 * summary after a night offline holds only what is new, and an app restarted
 * with the same alert still open does not announce it again.
 *
 * Kept in the keystore for the reason talkPref.ts is, and read lazily so
 * `bun test` (no keystore) gets a plain in-memory map.
 */
import type { Cursor } from "./watchAlerts.ts";

interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

function keystore(): KeystoreModule | null {
  try {
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null;
  }
}

const key = (hostId: string): string => `agentglass.watch.cursor.${hostId}`;
const held = new Map<string, Cursor>();

/** What was stored, or null when it is not a cursor. Ids are kept to a few: they are the
 *  alerts that share the newest second, not a history. */
export function parseCursor(raw: unknown): Cursor | null {
  try {
    const v = JSON.parse(String(raw)) as { at?: unknown; ids?: unknown };
    if (typeof v.at !== "number" || !Number.isFinite(v.at) || !Array.isArray(v.ids)) return null;
    return { at: v.at, ids: v.ids.filter((x): x is string => typeof x === "string").slice(0, 50) };
  } catch {
    return null;
  }
}

export interface SinceStore {
  /** null: this computer has never been caught up with. */
  get(hostId: string): Promise<Cursor | null>;
  set(hostId: string, at: Cursor): Promise<void>;
}

export const sinceStore: SinceStore = {
  async get(hostId) {
    const have = held.get(hostId);
    if (have) return have;
    try {
      const c = parseCursor(await keystore()?.getItemAsync(key(hostId)));
      if (c) { held.set(hostId, c); return c; }
    } catch {
      // Unreadable is treated as never caught up: the next pass starts quietly.
    }
    return null;
  },
  async set(hostId, at) {
    held.set(hostId, at);
    try {
      await keystore()?.setItemAsync(key(hostId), JSON.stringify(at));
    } catch {
      // Held for this run; a restart starts quietly rather than loudly.
    }
  },
};
