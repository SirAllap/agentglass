/**
 * Whether the launch cover plays (Settings ▸ Size and startup).
 *
 * On by default. Off, the window shows the plain boot screen it always had —
 * the mark, still, and one line — and the app replaces it the moment React
 * mounts, loading its panels in plain sight.
 *
 * Read by web/index.html's boot script before anything else is drawn, which
 * is why the key is spelled out there as well; web/test/cover.test.ts holds the
 * two spellings to each other.
 */
export const SPLASH_KEY = "agentglass-splash";

export function splashOn(): boolean {
  try { return localStorage.getItem(SPLASH_KEY) !== "off"; } catch { return true; }
}

export function setSplashOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SPLASH_KEY);
    else localStorage.setItem(SPLASH_KEY, "off");
  } catch { /* private mode: nothing to remember it in */ }
}
