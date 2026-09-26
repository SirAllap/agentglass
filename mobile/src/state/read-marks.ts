/*
 * The phone's copy of the read marks, and the one place it talks to the server
 * about them.
 *
 * The server holds a timestamp per pull request (`/marks`, S1) and tells every
 * device when one moves. The desk keeps its own in localStorage as a cache; the
 * phone has no such thing worth keeping — a mark is only ever read next to a
 * pull request the server just listed — so this is memory, refilled by one GET
 * whenever the socket comes up, and moved by the `marks` frames after it.
 *
 * A module-level store rather than context, for the reason pr-detail.ts gives:
 * the list, a pull request and its panes share no ancestor short of the root.
 *
 * The ceiling: a write that fails (offline, a phone paired read-only) is kept
 * here and not retried. The next open of that pull request writes it again,
 * which is the whole recovery; the desk queues and replays, this does not.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MarkRow, PrDetail } from "../../../shared/types.ts";
import { bootstrapSince, newestAt, prMarkKey } from "../../../shared/prUnread.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { applyMarkRows, type Seen } from "../model/readMarks.ts";

let seen: Seen = {};
/** Whether this connection has read the server's marks yet, and the read in
 *  flight — so the socket coming up and a screen opening share one request. */
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const set = (next: Seen): void => {
  if (next === seen) return;
  seen = next;
  for (const fn of listeners) fn();
};

/** What is held, for a test and for code that is not a component. */
export function seenNow(): Seen { return seen; }

/** Marks from the server: a GET's rows or a `marks` frame's. */
export function applyMarks(rows: MarkRow[]): void { set(applyMarkRows(seen, rows)); }

/** Forget everything, on a change of computer: its marks are not this one's. */
export function resetMarks(): void { loaded = false; set({}); }

/** Everything the server holds for pull requests. Once per connection: the
 *  frames keep it current, and a socket that has just come back is exactly when
 *  a frame was missed. */
export function loadPrMarks(host: Host): Promise<void> {
  loading ??= ask<{ marks: MarkRow[] }>(host, "/marks?kind=pr").then((answer) => {
    if (answer.ok && Array.isArray(answer.value.marks)) { applyMarks(answer.value.marks); loaded = true; }
  }).finally(() => { loading = null; });
  return loading;
}

/**
 * Say a pull request has been read up to `at`.
 *
 * Local first, so the badge is gone the moment the screen opens rather than a
 * round trip later; never backwards, because the server takes the newest of
 * every device and an older write here would only be refused there.
 */
export async function markPrRead(host: Host, key: string, at: number): Promise<void> {
  if (!(at > (seen[key] ?? 0))) return;
  applyMarks([{ kind: "pr", key, seenAt: at, state: "", updatedAt: 0 }]);
  const answer = await ask<{ ok: boolean; changed?: MarkRow[] }>(host, "/marks", {
    method: "POST",
    body: { ops: [{ kind: "pr", key, seenAt: at }] },
  });
  if (answer.ok && Array.isArray(answer.value.changed)) applyMarks(answer.value.changed);
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** The marks, for a screen that draws by them. */
export function useSeenMarks(): Seen {
  return useSyncExternalStore(subscribe, seenNow, seenNow);
}

/**
 * Opening a pull request: what this visit is measured against, and the mark
 * moving to now.
 *
 * The divider needs the OLD mark and the badge needs the new one, so the old is
 * read once — the first time the detail is here — and held for as long as the
 * screen is. A desk that reads the same pull request meanwhile clears the phone's
 * list live, and must not make the divider vanish under the reader.
 *
 * The marks are asked for first when this connection has not yet. They are
 * normally here already, filled when the socket came up, but a pull request
 * opened straight from a link on a cold start would otherwise find none and fall back to "since your last word",
 * which is the wrong answer for one you had read to the end on the desk.
 *
 * Null until decided, and 0 stays 0: never looked and never spoke says nothing.
 */
export function useReadOnOpen(host: Host | null, detail: PrDetail | null): number | null {
  const [since, setSince] = useState<number | null>(null);
  const decided = since !== null;
  useEffect(() => {
    if (!host || !detail || decided) return;
    let gone = false;
    void (async () => {
      if (!loaded) await loadPrMarks(host);
      if (gone) return;
      const key = prMarkKey(detail);
      setSince(seen[key] ?? bootstrapSince(detail));
      // Never behind the newest remark: a phone whose clock runs slow would
      // otherwise leave the last thing said still "new" after reading it.
      const newest = newestAt(detail);
      await markPrRead(host, key, Math.max(Date.now(), newest));
    })();
    return () => { gone = true; };
  }, [host, detail, decided]);
  return since;
}
