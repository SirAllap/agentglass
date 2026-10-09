// "Show me this path in the finder", from anywhere that has one.
//
// A terminal link cannot reach the palette's state, which lives in App. An
// event on window is the whole channel: the sender says where, App opens the
// palette on its Machine tab and hands the palette the same target.

import type { ControlCmd } from "../../../shared/types.ts";

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

/**
 * What a remote `{"cmd":"open","what":"finder"}` asks of the finder, or null for
 * any other command. The decision lives here rather than in App's switch so a
 * test can reach it: the server already vets the spelling, and this is the
 * second look at the one field that becomes a path in a request, because a
 * `control` frame is data off a socket and not something this window wrote.
 */
export function finderFromControl(cmd: ControlCmd): { path: string; kind: "dir" | "file" } | null {
  if (cmd.cmd !== "open" || cmd.what !== "finder") return null;
  if (typeof cmd.path !== "string" || !cmd.path.startsWith("/")) return null;
  return { path: cmd.path, kind: cmd.kind === "dir" ? "dir" : "file" };
}
