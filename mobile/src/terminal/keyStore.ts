/*
 * The chosen key bar, remembered.
 *
 * A module singleton with a subscription, which is the shape theme.ts already
 * uses and for the same reasons: the value is read by a screen's first frame,
 * it is written from a different screen, and both have to see the same thing
 * without either one owning it.
 *
 * ── the keystore, again, for something that is not a secret ──────────────
 * `expo-secure-store` is what this app has — the paired credential, the theme
 * and the seen-map all live there. A second storage library for one small
 * object would be a dependency, a build question on three platforms, and
 * another thing that can fail on a cold start. Its size limit does not bind
 * here: this is at most seventeen short ids.
 *
 * ── every failure is the default ─────────────────────────────────────────
 * A read that fails, a value from an older build, a write that is refused: all
 * of them end at the catalogue's own order with nothing hidden, which is a key
 * bar that works. The opposite failure — refusing to draw a bar because a
 * preference could not be read — is a terminal you cannot type Escape into.
 */
import { DEFAULT_LAYOUT, parse, serialise, type KeyLayout } from "./keyLayout.ts";

const KEY = "agentglass.keybar.v1";

/** The one module read here, required lazily and by a literal name.
 *
 *  Metro resolves `require` at BUILD time by reading the string, so a shared
 *  helper taking a module name compiles to a require of something the bundle
 *  does not contain — the argument is set out at length in theme.ts. This file
 *  is also imported by `bun test`, where there is no phone and no keystore,
 *  and the `null` is what makes that work rather than throw. */
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

let layout: KeyLayout = DEFAULT_LAYOUT;
const listeners = new Set<() => void>();

export const keyLayout = (): KeyLayout => layout;

/** Told, rather than polled. The terminal and the settings screen are both on
 *  screen at different times and neither owns the value. */
export function onKeyLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setKeyLayout(next: KeyLayout): void {
  layout = next;
  for (const fn of [...listeners]) fn();
  void keystore()?.setItemAsync(KEY, serialise(next))
    .catch(() => {
      // The choice stays live for this run. Refusing the change instead would
      // be a settings screen that does nothing, for a reason nobody holding a
      // phone can act on.
    });
}

/*
 * Read once, at startup.
 *
 * At module scope rather than from a hook, for the reason theme.ts gives about
 * `C`: the terminal's first frame draws this bar, so the read has to be in
 * flight before that screen mounts. Landing late is handled — the listeners
 * fire and the bar redraws — which is why this is not awaited anywhere.
 */
void (async () => {
  try {
    const raw = await keystore()?.getItemAsync(KEY);
    const got = parse(raw);
    if (got.order.length || got.hidden.length) {
      layout = got;
      for (const fn of [...listeners]) fn();
    }
  } catch {
    // Left at the default, which is a working bar.
  }
})();
