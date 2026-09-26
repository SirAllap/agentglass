/*
 * How much of a pull request's conversation may buzz THIS phone.
 *
 * A device preference, not a desktop one: the desk's equivalent
 * (web/src/lib/talkNotify.ts) lives in that browser's localStorage, and this
 * is the same choice made for a pocket instead of a tab. It never reaches the
 * server — there is no `NotifyKind` for it — because "should this phone buzz"
 * is a fact about the phone, the same way the Android channel and the
 * columns preference are.
 *
 * Module singleton with a subscription, in the shape termPrefs.ts already
 * uses: read by the live socket's frame handler before any screen has
 * mounted, written from Settings, and neither owns the value.
 */
interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

/** Required lazily and by a literal name so Metro can still resolve it at
 *  build time (see termPrefs.ts) — and so `bun test`, which has no keystore,
 *  gets `null` rather than a throw. */
function keystore(): KeystoreModule | null {
  try {
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null;
  }
}

const KEY = "agentglass.pr.talkPref";

/**
 * off        nothing buzzes. The live tick still moves the badge and
 *            refetches the screen open on it — that is the quiet half of
 *            this feature and stays on regardless.
 * reviews    only a review coming back — the verdict, whatever it is.
 * everything a comment and a review both.
 *
 * OFF is the default here and "everything" is the desk's, because a phone
 * asks to be interrupted in a pocket and a browser tab does not: the desk's
 * default was a considered "what was asked for", and copying that value onto
 * every device that ever pairs would buzz a phone nobody asked to be buzzed
 * on the first launch.
 */
export type TalkPref = "off" | "reviews" | "everything";

let pref: TalkPref = "off";
/** Set once somebody chooses in this run, so the stored value read at startup
 *  cannot land late and undo a choice made before it arrived. */
let chosen = false;
const listeners = new Set<() => void>();

export const talkPref = (): TalkPref => pref;

export function onTalkPref(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setTalkPref(next: TalkPref): void {
  chosen = true;
  pref = next;
  for (const fn of [...listeners]) fn();
  void keystore()?.setItemAsync(KEY, next).catch(() => {
    // Stays live for this run. A keystore that will not write leaves nothing
    // for this phone to act on differently.
  });
}

/** Read once, at startup — see termPrefs.ts for why this runs at module scope
 *  rather than from a hook, and why landing late is fine. */
void (async () => {
  try {
    const raw = await keystore()?.getItemAsync(KEY);
    if (!chosen && (raw === "off" || raw === "reviews" || raw === "everything")) {
      pref = raw;
      for (const fn of [...listeners]) fn();
    }
  } catch {
    // Left at the default, which is silence — the safe side of a guess.
  }
})();
