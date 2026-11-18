/*
 * Quiet hours, as this phone remembers them.
 *
 * A device preference, like talkPref.ts: whether this phone rings at night is a
 * fact about the phone and the pocket it is in, not about the computer. The
 * mock says "Quiet hours are a rule on the computer too"; the computer has no
 * such setting today, so this is the phone's own and the sheet says so — a rule
 * drawn as a server rule that only ever reached one device would be a lie the
 * next phone discovers.
 *
 * Module singleton with a subscription, in the shape termPrefs.ts uses: read by
 * the live socket's frame handler before any screen has mounted, written from
 * the Settings sheet, and neither owns the value.
 */
import { QUIET_DEFAULT, sanitizeQuiet, type QuietPref } from "../model/quietHours.ts";

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

const KEY = "agentglass.quiet.v1";

let pref: QuietPref = { ...QUIET_DEFAULT };
/** Set once somebody saves in this run, so the stored value read at startup
 *  cannot land late and undo a choice already made. */
let chosen = false;
const listeners = new Set<() => void>();

export const quietPref = (): QuietPref => pref;

export function onQuietPref(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setQuietPref(next: QuietPref): void {
  chosen = true;
  pref = sanitizeQuiet(next);
  for (const fn of listeners) fn();
  void keystore()?.setItemAsync(KEY, JSON.stringify(pref)).catch(() => {
    // Stays live for this run: a keystore that will not write is not a reason
    // to go on ringing through the hours somebody just chose.
  });
}

void (async () => {
  try {
    const raw = await keystore()?.getItemAsync(KEY);
    if (chosen || !raw) return;
    pref = sanitizeQuiet(JSON.parse(raw));
    for (const fn of listeners) fn();
  } catch {
    // Unreadable or hand-edited: the default window stands.
  }
})();
