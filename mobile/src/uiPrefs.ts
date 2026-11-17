/*
 * Two appearance choices that change how the app is DRAWN, not what it says.
 *
 *   density       Default, or Roomier: the step above the 44 px tap floor the
 *                 rows already keep. It widens the floor every row, list and
 *                 sheet pays, which is the one place that can change it.
 *   reduceMotion  No slide, no spring: a sheet appears, a row does not scale.
 *                 Android's own "remove animations" is a developer setting, and
 *                 an app that only honoured that would ignore the people who
 *                 turn animations off for motion sickness and never touch
 *                 developer options.
 *
 * A module singleton with a subscription, in the shape termPrefs.ts uses, and
 * for the same reason: the value is read while rendering two components that
 * share no parent, and it is written from Settings.
 */
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

const KEY = "agentglass.uiPrefs.v1";

export type Density = "default" | "roomier";

interface Prefs {
  density: Density;
  reduceMotion: boolean;
}

const DEFAULTS: Prefs = { density: "default", reduceMotion: false };

let prefs: Prefs = { ...DEFAULTS };
let chosen = false;
const listeners = new Set<() => void>();

/** The extra height a row, list row or sheet row takes. 0 or 8, so a screen
 *  drawn with the default is not moved by a preference nobody set. */
export function rowRoom(): number {
  return prefs.density === "roomier" ? 8 : 0;
}

export const reducesMotion = (): boolean => prefs.reduceMotion;
export const density = (): Density => prefs.density;

export function onUiPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setUiPrefs(next: Partial<Prefs>): void {
  chosen = true;
  prefs = {
    density: next.density ?? prefs.density,
    reduceMotion: next.reduceMotion ?? prefs.reduceMotion,
  };
  for (const fn of listeners) fn();
  void keystore()?.setItemAsync(KEY, JSON.stringify(prefs)).catch(() => {
    // Live for this run; see termPrefs.ts.
  });
}

function read(raw: string | null): Prefs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      density: v.density === "roomier" ? "roomier" : "default",
      reduceMotion: v.reduceMotion === true,
    };
  } catch {
    return null;
  }
}

void (async () => {
  try {
    const stored = read(await keystore()?.getItemAsync(KEY) ?? null);
    if (chosen || !stored) return;
    prefs = stored;
    for (const fn of listeners) fn();
  } catch {
    // The defaults stand.
  }
})();
