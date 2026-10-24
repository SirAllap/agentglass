/*
 * The system keyring as an optional home for the secrets agentglass writes
 * itself: the ClickUp and Jira tokens (credentials.ts) and the keys of plugin
 * `secret` fields (plugins.ts). Off unless the person turns it on.
 *
 * With it on, the file keeps `KEYRING_MARK` where the secret was, and the value
 * lives in the desktop keyring. This module is the part both stores share: the
 * backend, the in-memory copy the synchronous readers use, and the two writes
 * (`sealValue`, `dropValue`). Moving everything across when the switch changes
 * is keyringSwitch.ts.
 *
 * Four rules, each one a way to lose or leak a secret:
 *
 *   1. The keyring is written FIRST and read back; only then does a file get the
 *      mark. A secret is never in neither place.
 *   2. A keyring that cannot be written to REFUSES the write. It never falls
 *      back to a plain file: the person asked for the secret not to be there.
 *   3. Nothing here prompts. Locked is reported as locked.
 *   4. A value never leaves through a status, an error or a log. `held` is a
 *      count, errors name a reason ("keyring locked"), ids are not secrets.
 *
 * Why a copy in memory: every reader of a token is synchronous (`secretFor` has
 * dozens of callers) and the keyring is a socket. The map is filled once at boot
 * (`hydrateKeyring`) and kept in step by the writes. A marked secret that is not
 * in the map reads as absent, which is what a locked keyring should look like to
 * a feature: not connected, with `missingSecretWhy` saying the true reason.
 *
 * The ceiling: Linux Secret Service only. On macOS and Windows the switch
 * reports "unavailable" and says why; those keychains are the next thing after
 * this and are not here.
 */
import { secretsKeyring } from "./config.ts";
import {
  KeyringError, keyringAvailability, keyringDrop, keyringGet, keyringPut,
  type KeyringState,
} from "./secretservice.ts";

export { KeyringError };
export type { KeyringState };

/** What the file holds in place of a secret that lives in the keyring. */
export const KEYRING_MARK = "agentglass:keyring:v1";

export interface SecretBackend {
  availability(): Promise<KeyringState>;
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  del(id: string): Promise<void>;
}

const attrsOf = (id: string): Record<string, string> => ({ application: "agentglass", id });

const secretService: SecretBackend = {
  availability: () => (process.platform === "linux" ? keyringAvailability() : Promise.resolve("unavailable")),
  get: (id) => keyringGet(attrsOf(id)),
  set: (id, value) => keyringPut(attrsOf(id), `agentglass ${id}`, value),
  del: (id) => keyringDrop(attrsOf(id)),
};

let override: SecretBackend | null = null;
/** Test seam: a fake keyring. A suite must never touch the developer's own. */
export function __setBackend(b: SecretBackend | null): void { override = b; forgetAll(); lastState = "unknown"; }
export const backend = (): SecretBackend => override ?? secretService;

/** The secrets that live in the keyring, by id, as of the last read or write. */
const held = new Map<string, string>();
/**
 * When each id in `held` was last set or dropped by a WRITE, on a counter, and
 * when the whole map was last emptied. `hydrateKeyring` reads the keyring one
 * item at a time and can be slow (a boot, a rehydrate against a prompting
 * daemon); a token stored while its read is in flight must not be overwritten
 * by the older value that read then returns. Measured: the process kept using
 * the old token, while the keyring held the new one, until the next restart.
 */
const touched = new Map<string, number>();
let tick = 0;
let clearedAt = 0;
const setHeld = (id: string, v: string): void => { held.set(id, v); touched.set(id, ++tick); };
const dropHeld = (id: string): void => { held.delete(id); touched.set(id, ++tick); };
let lastState: KeyringState | "unknown" = "unknown";

export const keyringEnabled = (): boolean => secretsKeyring();

const WHY: Record<KeyringState, string> = {
  ready: "",
  locked: "keyring locked",
  unavailable: "keyring unavailable",
};

/** Why the row cannot be used, in one line: names the platform when that is the reason. */
export function whyNot(state: KeyringState): string {
  if (state === "unavailable" && process.platform !== "linux" && !override) return "the system keyring is supported on Linux only";
  return WHY[state];
}

/** How each store names a secret in the keyring. Ids, not values. */
export const credentialId = (provider: string): string => `credentials/${provider}`;
export const pluginKeyId = (plugin: string, key: string): string => `plugin/${plugin}/${key}`;

/** A file's value for a secret, turned into the secret: itself, or the keyring's
 *  copy when it is the mark. null when the mark has nothing behind it (locked,
 *  unavailable, or the item is gone). */
export function unsealed(id: string, fileValue: string): string | null {
  return fileValue === KEYRING_MARK ? (held.get(id) ?? null) : fileValue;
}

/** Remember a value the keyring holds (the migration fills the map before the
 *  files carry the mark, so readers never see a mark with nothing behind it). */
export function remember(id: string, value: string): void { setHeld(id, value); }
export function forget(id: string): void { dropHeld(id); }
export function forgetAll(): void { held.clear(); clearedAt = ++tick; }

/**
 * One keyring operation at a time. Every write that awaits the keyring between
 * reading a file and writing it (a token stored, a key saved, a key dropped, the
 * whole move) runs inside this, so none of them can read a file, wait, and then
 * write back a copy another one has since changed: that is how a secret is lost.
 * A failure does not stop the queue.
 */
let tail: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

/** The backend when it can be written to now; otherwise a KeyringError naming why. */
export async function readyBackend(): Promise<SecretBackend> {
  const b = backend();
  let state: KeyringState;
  try { state = await b.availability(); } catch { state = "unavailable"; }
  lastState = state;
  if (state !== "ready") throw new KeyringError(state, WHY[state]);
  return b;
}

/**
 * What goes in the file for `value`: the value itself while the keyring is off,
 * the mark once the keyring holds it and gave it back. Throws, and changes
 * nothing, when the keyring cannot keep it. An existing item that the write
 * damaged is put back, because the file still points at it.
 */
export async function sealValue(id: string, value: string): Promise<string> {
  if (!keyringEnabled() || value === "") return value;
  const b = await readyBackend();
  // What the keyring itself holds, not this process's copy: the copy is empty
  // after a hydrate that failed, and a rollback to "nothing" would delete an
  // item the file still points at.
  let before: string | null = null;
  try { before = await b.get(id); } catch { /* reads as nothing to put back */ }
  await b.set(id, value);
  let same = false;
  try { same = (await b.get(id)) === value; } catch { /* reads as not kept */ }
  if (!same) {
    try { if (before !== null) await b.set(id, before); else await b.del(id); } catch { /* best effort */ }
    throw new Error("the keyring did not keep it, so nothing was changed");
  }
  setHeld(id, value);
  return KEYRING_MARK;
}

/** Take a secret out of the keyring, before the file forgets it. Throws, and
 *  changes nothing, when the keyring cannot do it. */
export async function dropValue(id: string, fileValue?: string): Promise<void> {
  // A file that carries the mark points at the item whatever the setting says:
  // a move that stopped after the files were marked and before the switch was
  // saved leaves exactly that, and skipping the delete would orphan the item.
  if (!keyringEnabled() && fileValue !== KEYRING_MARK) return;
  const b = await readyBackend();
  await b.del(id);
  dropHeld(id);
}

/**
 * Fill the map from the keyring for the secrets the files point at. Never
 * throws and never holds the boot for more than five seconds: a keyring that
 * does not answer is a keyring that is unavailable, and the app starts without
 * those secrets. Safe to call again once the keyring is unlocked.
 */
export async function hydrateKeyring(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const work = (async () => {
    const b = await readyBackend();
    try {
      for (const id of ids) {
        const started = tick;
        const v = await b.get(id);
        // A write finished while this read was out: its value is the newer one.
        if (clearedAt > started || (touched.get(id) ?? 0) > started) continue;
        if (v === null) held.delete(id); else held.set(id, v);
      }
    } catch (e) {
      // The keyring said ready and then failed: say so, or the feature that
      // finds no token gets no reason at all.
      lastState = e instanceof KeyringError ? e.state : "unavailable";
      throw e;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((res) => { timer = setTimeout(() => { if (lastState === "unknown") lastState = "unavailable"; res(); }, 5000); });
  try { await Promise.race([work, cap]); } catch { /* lastState already says why */ } finally { clearTimeout(timer); }
}

export interface KeyringStatus {
  enabled: boolean;
  state: KeyringState;
  why?: string;
  /** How many secrets the keyring holds for this process. Never which, never what. */
  held: number;
}

export async function keyringStatus(): Promise<KeyringStatus> {
  let state: KeyringState;
  try { state = await backend().availability(); } catch { state = "unavailable"; }
  lastState = state;
  return { enabled: keyringEnabled(), state, ...(state === "ready" ? {} : { why: whyNot(state) }), held: held.size };
}

/** Why a feature that finds no token should say the keyring is the reason, or
 *  null when it is not (the switch is off, or the keyring answered). */
export function missingSecretWhy(): string | null {
  if (!keyringEnabled() || lastState === "unknown" || lastState === "ready") return null;
  return WHY[lastState];
}

/** What to tell the person when a locked keyring is why a disconnect, removal or
 *  replacement was refused: the way out, in the order they do it. `verb` is the
 *  action they meant ("disconnect", "remove it"). null for any other failure. */
export function unlockFirst(e: unknown, verb: string): string | null {
  return e instanceof KeyringError && e.state === "locked" ? `Unlock the system keyring first, then ${verb}` : null;
}

/** A keyring error as the one line a caller may show. */
export function reasonOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "the keyring did not answer";
}

/** What the keyring holds for `id` now, to put back if the save it was part of fails. */
export async function priorValue(id: string): Promise<string | null> {
  try { return await backend().get(id); } catch { return null; }
}
export async function putBack(id: string, prior: string | null): Promise<void> {
  try {
    const b = backend();
    if (prior === null) { await b.del(id); dropHeld(id); } else { await b.set(id, prior); setHeld(id, prior); }
  } catch { /* best effort: the file still points at the item */ }
}
