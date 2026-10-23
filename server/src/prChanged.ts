/*
 * "This pull request's head or labels changed", worked out from reads the app
 * already makes.
 *
 * A review plugin used to hear about a pull request only when the person
 * opened it (`pr-open`). Putting the label that asks for a review, or pushing
 * a new head, told it nothing: the list answers from a 120 s cache and the
 * watcher ticks every 120 s, so the review started about five minutes late,
 * and the plugin polled to make up for it.
 *
 * Nothing here asks GitHub for anything. Every place that already holds a
 * pull request's row or detail (the list refresh, the detail load, the label
 * editor's own re-read) hands it to `observePr`, and a change against what was
 * seen last time becomes one `pr-changed` event.
 *
 * Rules, each one a measured reason:
 *  - The first sight of a pull request is a baseline, never an event. A list
 *    of forty open pull requests read at boot would otherwise wake a reviewer
 *    forty times for nothing that happened.
 *  - A field the read did not carry is not a change. The list's first pass has
 *    labels and no head; the second pass adds the head. Learning a head for
 *    the first time is a baseline too.
 *  - Order is not content. Labels are compared sorted.
 *  - A burst (a label added and another removed, a push and a label) is one
 *    event with the final state, compared with what the plugin was last told.
 *    A change that is undone inside the window is no event at all.
 *  - The title and body are never carried: the event says which pull request
 *    changed and to what, and the plugin asks for the rest.
 *
 * The ceiling: this is in memory. After a restart the next read of each pull
 * request is a first sight again, so a change made while the app was down is
 * not announced.
 */

export interface PrChangedEvent {
  type: "pr-changed";
  repo: string;
  number: number;
  head: string;
  labels: string[];
  added: string[];
  removed: string[];
  headChanged: boolean;
  at: number;
}

const MAX_LABELS = 50;
const MAX_LABEL_LEN = 100;
/** Pull requests remembered. Oldest dropped; a dropped one is simply a first sight again. */
const MAX_TRACKED = 2000;

let coalesceMs = 2000;
let guardMs = 3000;

interface Tracked {
  repo: string;
  number: number;
  /** What the plugins were last told, or the baseline. "" = head not known yet. */
  head: string;
  labels: string[];
  /** The newest read. */
  latestHead: string;
  latestLabels: string[];
  /** False until a read carried labels: that read is the baseline, not a removal. */
  labelsKnown: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const tracked = new Map<string, Tracked>();
const refreshed = new Map<string, number>();
let listener: ((ev: PrChangedEvent) => void) | null = null;

/** index.ts hands the delivery in; this module reaches no plugin itself. */
export function onPrChanged(cb: ((ev: PrChangedEvent) => void) | null): void { listener = cb; }

export function normalizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const l of raw) {
    if (typeof l !== "string") continue;
    const t = l.trim().slice(0, MAX_LABEL_LEN);
    if (t) seen.add(t);
  }
  return [...seen].sort().slice(0, MAX_LABELS);
}

const HEAD = /^[0-9a-f]{40}$/i;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function fire(key: string): void {
  const t = tracked.get(key);
  if (!t) return;
  t.timer = null;
  const headChanged = !!t.latestHead && !!t.head && t.latestHead !== t.head;
  const labelsChanged = !same(t.latestLabels, t.labels);
  if (!headChanged && !labelsChanged) return;
  const added = t.latestLabels.filter((l) => !t.labels.includes(l));
  const removed = t.labels.filter((l) => !t.latestLabels.includes(l));
  t.head = t.latestHead || t.head;
  t.labels = t.latestLabels;
  listener?.({
    type: "pr-changed", repo: t.repo, number: t.number, head: t.head,
    labels: t.labels, added, removed, headChanged, at: Date.now(),
  });
}

/**
 * One read of a pull request. `head` and `labels` are whatever that read
 * carried; leave one out when it did not.
 */
export function observePr(repo: string, repoKey: string, number: number, seen: { head?: unknown; labels?: unknown }): void {
  const key = `${repoKey}#${number}`;
  const head = typeof seen.head === "string" && HEAD.test(seen.head) ? seen.head.toLowerCase() : "";
  const labels = Array.isArray(seen.labels) ? normalizeLabels(seen.labels) : null;
  let t = tracked.get(key);
  if (!t) {
    if (!head && !labels) return;
    t = { repo, number, head, labels: labels ?? [], latestHead: head, latestLabels: labels ?? [], labelsKnown: !!labels, timer: null };
    tracked.set(key, t);
    if (tracked.size > MAX_TRACKED) {
      const oldest = tracked.keys().next().value as string;
      const o = tracked.get(oldest);
      if (o?.timer) clearTimeout(o.timer);
      tracked.delete(oldest);
    }
    return;
  }
  if (head) {
    if (!t.head) { t.head = head; t.latestHead = head; } else t.latestHead = head;
  }
  if (labels) {
    if (!t.labelsKnown) { t.labelsKnown = true; t.labels = labels; t.latestLabels = labels; } else t.latestLabels = labels;
  }
  const differs = (!!t.latestHead && !!t.head && t.latestHead !== t.head) || !same(t.latestLabels, t.labels);
  if (differs && !t.timer) {
    t.timer = setTimeout(() => fire(key), coalesceMs);
    (t.timer as { unref?: () => void }).unref?.();
  }
}

/** True once per pull request per window: the instant refresh after an
 *  in-app label change must not become a loop of reads. */
export function claimRefresh(repoKey: string, number: number, now = Date.now()): boolean {
  const key = `${repoKey}#${number}`;
  const last = refreshed.get(key);
  if (last !== undefined && now - last < guardMs) return false;
  refreshed.delete(key);
  refreshed.set(key, now);
  if (refreshed.size > MAX_TRACKED) refreshed.delete(refreshed.keys().next().value as string);
  return true;
}

/** Every running plugin that declares `prNotes`, the same set `pr-open` goes to. */
export function deliverPrChanged(
  ev: PrChangedEvent,
  plugins: { name: string; running: boolean; prNotes: boolean }[],
  push: (plugin: string, ev: PrChangedEvent) => void,
): number {
  let n = 0;
  for (const p of plugins) if (p.running && p.prNotes) { push(p.name, ev); n++; }
  return n;
}

/** Test seam. */
export function __resetPrChanged(opts: { coalesceMs?: number; guardMs?: number } = {}): void {
  for (const t of tracked.values()) if (t.timer) clearTimeout(t.timer);
  tracked.clear();
  refreshed.clear();
  listener = null;
  coalesceMs = opts.coalesceMs ?? 2000;
  guardMs = opts.guardMs ?? 3000;
}
export const __trackedCount = (): number => tracked.size;
