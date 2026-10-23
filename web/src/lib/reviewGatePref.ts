// Whether open critical or high findings from a local review hold a pull
// request out of the "Green, ready to land" lane.
//
// OFF by default, and the default is the whole point: the board a person had
// before this setting existed must draw exactly as it did. Turning it on is
// saying "a reviewer I trust found something, and I want the board to agree
// with it". The chip on the card says the same thing without moving anything.
//
// In localStorage like the other board preferences: it decides what this
// window draws, and a round trip would put a fetch in front of the board.
// The per-repository override the idea came with is the next thing after this
// and is not here.

const KEY = "agentglass.pr.reviewGate";
export const REVIEW_GATE_DEFAULT = false;

const listeners = new Set<() => void>();

export function reviewGateOn(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    // The raw string, as ciNotifyPref reads it: a cast would make "0" and an
    // absent key the same thing and the default unreachable.
    if (raw === null) return REVIEW_GATE_DEFAULT;
    return raw === "1";
  } catch { return REVIEW_GATE_DEFAULT; }
}

export function setReviewGate(on: boolean): void {
  try {
    // The default is not written down: a default worth storing is one that
    // will disagree with the code the day it changes.
    if (on === REVIEW_GATE_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, on ? "1" : "0");
  } catch { /* private mode */ }
  for (const l of listeners) l();
}

export function onReviewGate(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
