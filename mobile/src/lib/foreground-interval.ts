/*
 * An interval that exists only while the app is in the foreground. A timer
 * that stays armed in a pocket wakes the process just to return early; this one
 * is cleared on the way out and re-armed on the way back. `app` is AppState,
 * passed in so this file imports nothing from react-native.
 */
export interface AppLike {
  currentState: string;
  addEventListener(type: "change", cb: (state: string) => void): { remove(): void };
}

/** Runs `fn` every `ms` while active. Returns the cleanup. */
export function foregroundInterval(app: AppLike, fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = (): void => { if (!timer) timer = setInterval(fn, ms); };
  const stop = (): void => { if (timer) { clearInterval(timer); timer = null; } };
  if (app.currentState === "active") start();
  // Coming back to the foreground looks at once: waiting a whole period shows stale data.
  const sub = app.addEventListener("change", (s) => { if (s === "active") { if (!timer) fn(); start(); } else stop(); });
  return () => { stop(); sub.remove(); };
}
