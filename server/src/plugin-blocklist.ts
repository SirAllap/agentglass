/**
 * The kill list: a plugin key we already know is bad, checked before it is
 * ever allowed to run, regardless of what its own manifest or a stale
 * approval says. A local file for now — the mechanism has to exist before
 * the day it is needed, not get built the day something already ran.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginsConfigDir } from "./plugins.ts";

export interface BlockEntry {
  pluginKey: string;
  reason: string;
  link: string | null;
}

export function blocklistPath(): string {
  return join(pluginsConfigDir(), "blocklist.json");
}

/** Corrupt or absent reads as "nothing blocked" — the same fail-open-on-parse
 *  the manifest and lease stores already use, because a bad file taking the
 *  server down is worse than a blocklist that momentarily has no effect. A
 *  malformed individual entry is dropped rather than widened into a block on
 *  an empty key. */
export function readBlocklist(): BlockEntry[] {
  const p = blocklistPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(raw)) return [];
    const out: BlockEntry[] = [];
    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const key = (e as Record<string, unknown>).pluginKey;
      const reason = (e as Record<string, unknown>).reason;
      const link = (e as Record<string, unknown>).link;
      if (typeof key !== "string" || !key.trim()) continue;
      if (typeof reason !== "string" || !reason.trim()) continue;
      out.push({ pluginKey: key.trim(), reason: reason.trim(), link: typeof link === "string" && link.trim() ? link.trim() : null });
    }
    return out;
  } catch {
    return [];
  }
}

export function blockedEntry(pluginKey: string): BlockEntry | null {
  return readBlocklist().find((e) => e.pluginKey === pluginKey) ?? null;
}
