// "Something on screen owns the zoom right now."
//
// The application zooms itself on Ctrl+wheel and ⌘=/⌘−/⌘0 — see App.tsx — and both
// handlers are bound at the WINDOW, in the capture phase, so they run before anything
// a component attaches to its own node. That is right for a shortcut that has to work
// wherever the pointer is, and wrong the moment something on screen is a better answer
// to "zoom".
//
// Measured, after two attempts that did not work: with the image viewer open, a
// Ctrl+wheel zoomed the interface AND the picture, because the window's capture
// listener fired first and the viewer's own listener fired afterwards on the way up.
// A renderer cannot preventDefault its way out of that — the two handlers are both
// ours.
//
// So the app asks first. One owner at a time, named for what it is, and the app's zoom
// stands down while somebody holds it.

let owner: string | null = null;

/** Take the zoom. Returns the release, so a caller cannot forget which name it used. */
export function claimZoom(name: string): () => void {
  owner = name;
  return () => { if (owner === name) owner = null; };
}

/** Is somebody else answering the zoom gestures? */
export const zoomTaken = (): boolean => owner !== null;

/** Who, for a test or a log. */
export const zoomOwner = (): string | null => owner;
