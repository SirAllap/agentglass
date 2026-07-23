/**
 * "Git changed" — one signal, every consumer.
 *
 * The panels each cached or polled git state on their own clock: the repo
 * dropdown on a 5s server cache, the notch's behind-count on a 90s poll, the
 * working tree on 2.5s. So a pull updated the header immediately, left the
 * dropdown claiming "behind 351" until the next action, and left the notch
 * wrong until you closed the workspace and opened it again. Each was correct
 * in isolation and the app as a whole was lying.
 *
 * The server knows the moment anything mutates — every write goes through one
 * function — so it says so on the socket the client already holds, and
 * everything that shows git state listens here. No new polling, and it also
 * covers the case a client-side hook never could: a `git pull` typed into the
 * app's own terminal.
 */

const listeners = new Set<() => void>();

/** Called by the live socket when the server reports a mutation. */
export function gitChanged(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribeGitChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
