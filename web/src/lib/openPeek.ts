/*
 * "Open this file in the viewer."
 *
 * A one-slot request, the same shape and for the same reason as prJump: the
 * viewer is mounted at the shell (it is a modal over everything), and the views
 * that want to open a file — File changes, Source control — are not its parent.
 *
 * It exists because the answer to "open this" used to be two different things:
 * the pull request opened the modal with an editor in it, and the other two
 * shelled out to whatever nvim happened to be running, which on a machine with
 * none copied a command to the clipboard and called it done. One verb, one
 * behaviour.
 */
import type { Peek } from "../components/PeekFile.tsx";

let pending: (Peek & { n: number }) | null = null;
const subs = new Set<() => void>();
let seq = 0;

export function subscribePeek(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function peekRequest(): (Peek & { n: number }) | null { return pending; }

/** Ask for it. `n` rises per request, so opening the same file twice is two
 *  arrivals rather than one that looks already served. */
export function openPeek(peek: Peek): void {
  pending = { ...peek, n: ++seq };
  subs.forEach((f) => f());
}

/** Cleared by whoever served it, not on arrival: a request made while the shell
 *  was still mounting must not be dropped on the way in. */
export function clearPeek(): void {
  pending = null;
  subs.forEach((f) => f());
}
