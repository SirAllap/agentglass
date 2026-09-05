// What is covering the app right now.
//
// One reason this exists: the browser's inspector is a view the SHELL owns,
// floating over the window at a rectangle this side reports. It knows nothing
// about our DOM, so it sits over anything drawn in front of it — measured, with
// Settings open on top of the browser and the inspector cheerfully on top of
// Settings.
//
// So a modal says it is there, and whoever floats something over the window
// gets out of the way. A registry rather than a boolean: two overlays can be
// open at once (Settings over the palette), and the last one to close is the
// one that decides nothing is covering the app any more.

const open = new Set<string>();
const watchers = new Set<() => void>();

const tell = () => { for (const fn of watchers) fn(); };

/** Mark an overlay open, and get back the function that closes it — so a
 *  component can `useEffect(() => overlayOpen("settings"), [])` and be correct
 *  whichever way it unmounts. */
export function overlayOpen(id: string): () => void {
  open.add(id);
  tell();
  return () => { open.delete(id); tell(); };
}

export function anyOverlayOpen(): boolean { return open.size > 0; }

export function subscribeOverlays(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/** Test seam: a suite that opened one and threw does not poison the next. */
export function __resetOverlays(): void { open.clear(); tell(); }
