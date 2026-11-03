/*
 * The OpenCode console API key, when the person has one.
 *
 * The local panel counts this PC's turns and never needs a key. A key only buys
 * the console's own numbers, which cover every machine on the plan, so it is
 * optional and the app works without it.
 *
 * Same rules as credentials.ts, and for the same reason: 0600 at creation AND
 * chmod'd afterwards, nothing here returns the key to a caller that serialises,
 * and it is never logged. `hasUsageKey` is what a route may send; `usageKey` is
 * for the server's own fetch.
 *
 * The ceiling: this file is not in the system keyring yet. The keyring covers
 * the provider tokens and plugin fields; moving this one across is the next
 * thing after this and is not here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEY_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "opencode-usage-key",
);

let overridePath: string | null = null;
/** Test seam: point the store somewhere disposable, never the real config. */
export function __setUsageKeyPath(p: string | null): void { overridePath = p; }
const path = (): string => overridePath ?? KEY_PATH;

/** A key pasted with a trailing newline is the same key; an empty one is not. */
const clean = (raw: string): string => raw.trim();

export function usageKey(): string | null {
  try {
    const k = clean(readFileSync(path(), "utf8"));
    return k || null;
  } catch {
    return null;
  }
}

export const hasUsageKey = (): boolean => usageKey() !== null;

/** Store it. Throws when the file cannot be written; the caller says so. */
export function setUsageKey(raw: string): void {
  const key = clean(raw);
  if (!key) throw new Error("an empty key is not a key");
  const p = path();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, key + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

export function clearUsageKey(): void {
  try { rmSync(path()); } catch { /* nothing stored */ }
}
