// Cache the answer. Never cache the failure.
//
// The lazy-loading pattern this app uses everywhere is `p ??= import(...)`: one
// promise, shared by every caller, so a library is fetched once. It has one sharp
// edge, and it cost a real bug — a rejected promise is a perfectly good cached
// value, so ONE failed chunk fetch is remembered for the life of the page.
//
// Measured shape of that failure: the syntax highlighter's chunks are fetched
// from the local server the first time a code block needs colour. Install a build
// and the server restarts under a window that is still open; a request that lands
// in that second fails, the promise rejects, and from then on every code block in
// the app is flat grey with nothing on screen to say why. Restarting the app
// "fixed" it, which is how it was reported.
//
// So: hold the promise while it is pending or fulfilled, and drop it the moment it
// rejects, so the next caller starts a fresh attempt. Nothing retries on its own —
// that is the caller's decision, and a caller with nothing to show still has the
// old behaviour.

/**
 * Wrap a maker so its result is shared, and its failures are not.
 *
 * The rejection is still passed on to whoever asked: this changes what is
 * REMEMBERED, never what a caller is told.
 */
export function onceOk<T>(make: () => Promise<T>): () => Promise<T> {
  let held: Promise<T> | null = null;
  return () => {
    if (!held) {
      held = make().catch((e) => {
        // Cleared BEFORE the rejection travels, so a caller that retries
        // synchronously in its own catch gets a new attempt rather than this one.
        held = null;
        throw e;
      });
    }
    return held;
  };
}
