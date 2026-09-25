// "Show me this path in the finder", from anywhere that has one.
//
// A terminal link cannot reach the palette's state, which lives in App. An
// event on window is the whole channel: the sender says where, App opens the
// palette on its Machine tab and hands the palette the same target.

export interface FinderTarget {
  /** Absolute. A folder opens as the listing; a file opens its folder with the file selected. */
  path: string;
  kind: "dir" | "file";
  /** Bumps on every request, so asking for the same path twice re-runs it. */
  n: number;
}

const EVENT = "agx:finder-at";
let counter = 0;

export function openFinderAt(path: string, kind: "dir" | "file"): void {
  window.dispatchEvent(new CustomEvent<FinderTarget>(EVENT, { detail: { path, kind, n: ++counter } }));
}

export function onFinderAt(fn: (t: FinderTarget) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<FinderTarget>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
