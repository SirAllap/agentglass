/*
 * One pull request, read once, however many panes are looking at it.
 *
 * Three of them are now: the overview, the diff and the threads, and until
 * this they each fetched `/prs/detail` for themselves. That was harmless while
 * they were three screens — you were only ever on one — and stopped being
 * harmless the moment they became segments of one, because all three can be
 * mounted at the same time.
 *
 * The cost was the smaller half. The real one is that three copies of the same
 * answer disagree: resolve a thread in the Threads pane, which re-reads after
 * every write, and the Overview behind it still says "3 open" because nobody
 * told it. A number that is wrong on the screen you came from reads as the
 * write not having taken.
 *
 * So there is one copy per pull request, and a write anywhere re-reads it for
 * everybody. A module-level store rather than context, for the reason
 * card-edits.ts gives for its listeners: a pane is also a route, so the three
 * share no ancestor short of the root, and a context at the root re-renders
 * the app to change one count.
 */
import { useCallback, useEffect, useState } from "react";
import type { PrDetail } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";

interface Entry {
  detail: PrDetail | null;
  error: string | null;
  /** The read in flight, so three panes mounting together make one request
   *  rather than three — the same join the server does for `gh pr diff`. */
  reading: Promise<void> | null;
  listeners: Set<() => void>;
}

const store = new Map<string, Entry>();

const keyOf = (root: string, number: string): string => `${root}#${number}`;

function entryFor(key: string): Entry {
  const found = store.get(key);
  if (found) return found;
  const made: Entry = { detail: null, error: null, reading: null, listeners: new Set() };
  store.set(key, made);
  return made;
}

function tell(entry: Entry): void {
  for (const listen of entry.listeners) listen();
}

async function read(host: Host, root: string, number: string, entry: Entry): Promise<void> {
  const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
  const answer = await ask<{ ok: boolean; detail?: PrDetail; error?: string }>(host, `/prs/detail?${query}`);
  if (!answer.ok) { entry.error = answer.error; tell(entry); return; }
  if (!answer.value.ok || !answer.value.detail) {
    entry.error = answer.value.error || "That pull request could not be read.";
    tell(entry);
    return;
  }
  entry.error = null;
  entry.detail = answer.value.detail;
  tell(entry);
}

/**
 * Read it, or join the read already in flight.
 *
 * The join is the point and not an optimisation: three panes mount together
 * when a review opens, and without it that is three requests for one answer —
 * the same join the server makes for `gh pr diff`, made on this side for the
 * same reason.
 *
 * Exported so it can be tested without a renderer. There is none in this
 * project, and "three callers, one request" is a fact about this function
 * rather than about a screen.
 */
export async function readPrDetail(host: Host | null, root: string, number: string): Promise<void> {
  if (!host || !root || !number) return;
  const entry = entryFor(keyOf(root, number));
  if (entry.reading) return entry.reading;
  const run = read(host, root, number, entry).finally(() => { entry.reading = null; });
  entry.reading = run;
  return run;
}

/** What is held for one pull request, for a test that wants to look. */
export function prDetailNow(root: string, number: string): PrDetail | null {
  return store.get(keyOf(root, number))?.detail ?? null;
}

/**
 * The detail, and the way to ask for it again.
 *
 * `reload` is what every write calls: it always goes to the server — never a
 * cached answer — because what a thread looks like after a reply is GitHub's
 * answer and not this app's guess, which is the rule `useThreadActions`
 * already states.
 *
 * The first mount fetches; the second and third join the same promise. What is
 * kept between visits is deliberate: coming back to a pull request shows what
 * it said last time WHILE the fresh read is in flight, rather than an empty
 * screen for a second.
 */
export function usePrDetail(host: Host | null, root: string, number: string): {
  detail: PrDetail | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const key = keyOf(root, number);
  const entry = entryFor(key);
  const [, repaint] = useState(0);

  useEffect(() => {
    const listen = (): void => repaint((n) => n + 1);
    entry.listeners.add(listen);
    return () => { entry.listeners.delete(listen); };
  }, [entry]);

  const reload = useCallback(
    async (): Promise<void> => readPrDetail(host, root, number),
    [host, root, number],
  );

  useEffect(() => { void reload(); }, [reload]);

  return { detail: entry.detail, error: entry.error, reload };
}

/** Drop what is held for one pull request. Only tests need this: the store is
 *  a handful of objects and a phone that reviewed forty pull requests in a
 *  session has bigger things in memory than forty titles. */
export function forgetPrDetail(root: string, number: string): void {
  store.delete(keyOf(root, number));
}
