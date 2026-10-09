// The pull requests a stack's bases come from, for the bases the list does not hold.
//
// A board holds the lists it fetched, and the base of a stacked pull request is
// often not in them: somebody else's, merged, closed. Finding it is one cached
// request on the server (`prForHead`) per BRANCH, so this asks for each branch
// at most once per window however many cards sit on it, two at a time, and only
// for what `needsLookup` says is still unknown. Nothing here runs on a timer:
// it is asked when the cards on screen change, and asking again inside the
// window is free. What is not answered is simply absent, and the card says
// nothing — see prStack.ts.

import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { StackPr } from "./prStack.ts";

/** Found: the pull request moves slowly. None: somebody may open one soon. A failed ask is not "none". */
const FOUND_MS = 5 * 60_000;
const NONE_MS = 90_000;
const FAILED_MS = 60_000;
const AT_ONCE = 2;

type Entry = { at: number; pr: StackPr | null | "failed" };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; root: string; branch: string }[] = [];
const listeners = new Set<() => void>();
let running = 0;
let version = 0;

const keyOf = (root: string, branch: string) => `${root}\u0000${branch}`;
const fresh = (e: Entry | undefined): e is Entry =>
  !!e && Date.now() - e.at < (e.pr === "failed" ? FAILED_MS : e.pr ? FOUND_MS : NONE_MS);

function tell(): void { version++; for (const l of listeners) l(); }

function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const job = waiting.shift()!;
    running++;
    inflight.add(job.key);
    api.prForHead(job.root, job.branch)
      .then((r) => {
        seen.set(job.key, { at: Date.now(), pr: !r.ok ? "failed" : r.pr ? {
          number: r.pr.number, state: r.pr.state, isDraft: r.pr.isDraft,
          headRefName: r.pr.headRefName, baseRefName: r.pr.baseRefName } : null });
      })
      .catch(() => { seen.set(job.key, { at: Date.now(), pr: "failed" }); })
      .finally(() => { running--; inflight.delete(job.key); tell(); pump(); });
  }
}

/** Ask for these branches' pull requests. Anything fresh, queued or in flight is left alone. */
export function askBases(root: string, branches: readonly string[]): void {
  if (!root) return;
  for (const branch of branches) {
    const key = keyOf(root, branch);
    if (fresh(seen.get(key)) || inflight.has(key) || waiting.some((w) => w.key === key)) continue;
    waiting.push({ key, root, branch });
  }
  pump();
}

/** What has been found for this checkout: a pull request, or null for "none ever". Unanswered and failed are absent. */
export function foundBases(root: string): Map<string, StackPr | null> {
  const out = new Map<string, StackPr | null>();
  const prefix = `${root}\u0000`;
  for (const [k, e] of seen) if (k.startsWith(prefix) && fresh(e) && e.pr !== "failed") out.set(k.slice(prefix.length), e.pr);
  return out;
}

export function onBases(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Re-renders whoever calls it when an answer lands. */
export function useBasesVersion(): number {
  return useSyncExternalStore(onBases, () => version, () => 0);
}

/** For tests: forget everything. */
export function resetBases(): void { seen.clear(); inflight.clear(); waiting.length = 0; running = 0; version = 0; }
