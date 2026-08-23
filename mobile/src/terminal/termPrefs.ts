/*
 * What this phone remembers about how it draws a terminal.
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

const KEY = "agentglass.term.v1";

/**
 * How many columns the phone asks the pane for.
 *
 * Orca calls the same setting a text size and scales the type; this app has
 * always expressed it as columns, and the two are the same dial read from
 * opposite ends — fewer columns is bigger text. Columns is the honest unit
 * here because it is what actually goes down the socket, and because the note
 * this screen already draws when a pane is wider than the phone is counted in
 * them.
 *
 * TWO rungs, and the reason is measured rather than conservative. The note over
 * `columns` in app/(tabs)/terminal.tsx has the numbers: at this phone's 412
 * CSS px, 60 columns is a 6.85px cell and 80 is 5.15px, but 120 is 3.43px —
 * above the font floor, so nothing overlaps and a screenshot merely looks like
 * small text. It is not small text. At that size the glyph is clipped inside
 * its own cell and characters change identity: `#472` read back as `#4/2` and
 * `faf0e9d` as `tat0e9d`, a seven without its bar being a slash. A width
 * control that misreports the commit somebody is looking at is worse than one
 * that does not offer the rung, and 100 is not offered either because nobody
 * has measured it.
 *
 * Stored because it is a property of the PHONE — its screen, and whose eyes
 * are on it — rather than of any pane, so re-choosing it on every attach was
 * work nobody should have to repeat.
 */
export const COLUMNS = [60, 80] as const;
export const DEFAULT_COLUMNS = 80;

interface Prefs {
  layout: KeyLayout;
  columns: number;
}

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

let prefs: Prefs = { layout: DEFAULT_LAYOUT, columns: DEFAULT_COLUMNS };
const listeners = new Set<() => void>();

export const keyLayout = (): KeyLayout => prefs.layout;
export const termColumns = (): number => prefs.columns;

/** Told, rather than polled. The terminal and the settings screen are both on
 *  screen at different times and neither owns the value. */
export function onTermPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setKeyLayout(next: KeyLayout): void {
  save({ ...prefs, layout: next });
}

/** Clamped to the offered set rather than trusted: this ends up in a
 *  `resize-window` on somebody's machine, and a number from a stored value is
 *  a number from an older build. */
export function setTermColumns(next: number): void {
  const want = COLUMNS.includes(next as typeof COLUMNS[number]) ? next : DEFAULT_COLUMNS;
  save({ ...prefs, columns: want });
}

function save(next: Prefs): void {
  prefs = next;
  for (const fn of [...listeners]) fn();
  void keystore()?.setItemAsync(KEY, JSON.stringify({
    layout: JSON.parse(serialise(next.layout)) as unknown,
    columns: next.columns,
  }))
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
    if (!raw) return;
    const stored = JSON.parse(raw) as { layout?: unknown; columns?: unknown };
    const layout = parse(stored.layout ? JSON.stringify(stored.layout) : null);
    const columns = typeof stored.columns === "number"
      && COLUMNS.includes(stored.columns as typeof COLUMNS[number])
      ? stored.columns : DEFAULT_COLUMNS;
    prefs = { layout, columns };
    for (const fn of [...listeners]) fn();
  } catch {
    // Left at the default, which is a working bar.
  }
})();
