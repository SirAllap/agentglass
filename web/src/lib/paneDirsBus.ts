/**
 * "A pane's directory may have moved" — the server pushes it (a `panedirs`
 * frame) when tmux reports a window or pane-path change, so the terminal reads
 * `pane-dirs` then and not on a 4 s beat. Same shape as gitBus.ts.
 */
const listeners = new Set<() => void>();

export function paneDirsChanged(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribePaneDirsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
