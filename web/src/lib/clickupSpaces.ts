/*
 * The spaces of this workspace and the statuses each one has, read once and shared.
 *
 * Same idea as clickupSetup and clickupPrefs: a picker, the "What we found" card
 * and the map's coverage lines are one read, not three. The server holds the
 * answer ten minutes and says so; this holds it as long, and a Re-read press
 * goes past both. A pick never asks anything: the statuses are already here.
 *
 * A refusal is not kept. It is shown as one (the rate limit is said in words)
 * and the last good answer stays on screen beside it, labelled stale, so a
 * picker that cannot be refreshed is still readable and a step is never
 * rewritten from nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { ClickUpSpace } from "../../../shared/providers.ts";

const TTL = 10 * 60_000;
/** How many times in a row the server has said "still reading the cards". The server waits for them
 *  itself, so each ask is up to nine seconds; after this many the page stops waiting and says so. */
export const MAX_PENDING = 6;
let pendingTries = 0;
/** The pause between asks: the server's own wait does the waiting, this only spaces the next ask. */
export const PENDING_RETRY_MS = 1_500;

/**
 * What an answer from the server is to the page. "pending" is not an answer about the spaces: it is
 * the cards not being read yet, and every space in it is marked as not known. After MAX_PENDING of
 * them in a row it becomes what the server says when the cards cannot be read: every space, with a
 * sentence, and nothing selected for the person (see defaultUnit).
 */
export function readAnswer(r: { spaces?: ClickUpSpace[]; source?: string; note?: string }, tries: number):
  | { kind: "pending" }
  | { kind: "spaces"; spaces: ClickUpSpace[]; note?: string } {
  const spaces = r.spaces ?? [];
  if (r.source !== "pending") return { kind: "spaces", spaces, ...(r.source === "spaces" && r.note ? { note: r.note } : null) };
  if (tries < MAX_PENDING) return { kind: "pending" };
  return {
    kind: "spaces",
    spaces: spaces.map(({ pending: _p, counted: _c, ...s }) => s),
    note: "Your cards did not load, so every list is counted and none is picked for you. Re-read to try again.",
  };
}

/** An answer that could not narrow to the person's own spaces (no cards read yet) is asked again soon:
 *  the server answers it from memory, so this costs a local call and no ClickUp request. */
const TTL_UNNARROWED = 20_000;

/** The server is still reading the person's cards, which is what decides the default spaces. */
export const PENDING_CARDS = "cards";

export type SpacesState =
  | { kind: "loading"; stale?: ClickUpSpace[]; why?: typeof PENDING_CARDS }
  | { kind: "ok"; spaces: ClickUpSpace[]; at: number; note?: string }
  | { kind: "empty"; at: number }
  | { kind: "error"; error: string; throttled: boolean; unauthorised?: boolean; stale?: ClickUpSpace[]; staleAt?: number };

let held: { spaces: ClickUpSpace[]; at: number; note?: string } | null = null;
let inflight: Promise<SpacesState> | null = null;
/** Bumped when the credential changes: an answer that left before that is for the old one and is dropped. */
let epoch = 0;
const listeners = new Set<(s: SpacesState) => void>();

const fresh = (): SpacesState | null => {
  if (!held || Date.now() - held.at >= (held.note ? TTL_UNNARROWED : TTL)) return null;
  return held.spaces.length ? { kind: "ok", spaces: held.spaces, at: held.at, ...(held.note ? { note: held.note } : null) } : { kind: "empty", at: held.at };
};

/** Read the spaces. `force` is the Re-read press and goes past every cache. `local` goes past this
 *  one only: a changed pick of spaces is a new answer from what the server already holds, and asks
 *  ClickUp for nothing. */
export function readSpaces(force = false, local = false): Promise<SpacesState> {
  if (force) pendingTries = 0;
  const now = force || local ? null : fresh();
  if (now) return Promise.resolve(now);
  /* A Re-read press must reach ClickUp, so it does not share a read already in the air: that one
     may have been answered from the server's memo. */
  if (inflight && !force && !local) return inflight;
  const mine = epoch;
  const p: Promise<SpacesState> = api.clickupStatusSpaces(force)
    .then((r): SpacesState => {
      if (r.ok) {
        const a = readAnswer(r, ++pendingTries);
        if (a.kind === "pending") return { kind: "loading", why: PENDING_CARDS };
        pendingTries = 0;
        const { spaces, note } = a;
        if (mine === epoch) held = { spaces, at: Date.now(), ...(note ? { note } : null) };
        return spaces.length ? { kind: "ok", spaces, at: Date.now(), ...(note ? { note } : null) } : { kind: "empty", at: Date.now() };
      }
      return { kind: "error", error: r.error || "ClickUp did not answer", throttled: r.throttled === true, unauthorised: r.unauthorised === true, stale: mine === epoch ? held?.spaces : undefined, staleAt: mine === epoch ? held?.at : undefined };
    })
    .catch((): SpacesState => ({ kind: "error", error: "Could not reach the server", throttled: false, stale: mine === epoch ? held?.spaces : undefined, staleAt: mine === epoch ? held?.at : undefined }))
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

/** The names of the spaces this page last read, by id; empty before the first read. Synchronous, for words
 *  that have to be said now (a chip announcing a change) and may fall back to the id. */
export const spaceNamesNow = (): ReadonlyMap<string, string> => new Map((held?.spaces ?? []).filter((s) => !s.fromList).map((s) => [s.id, s.name]));

/** The pick of counted spaces changed (a row, an agent, an undo): read the answer again past the held
 *  one, tell every holder, and ask ClickUp for nothing. */
export function recountSpaces(): void {
  void readSpaces(false, true).then((s) => { for (const l of listeners) l(s); });
}

/** The credential changed: what was read under the old one goes. */
export function __forgetClickupSpaces(): void { held = null; inflight = null; pendingTries = 0; epoch++; }

export function useClickupSpaces(enabled = true): { state: SpacesState; reread: () => void; recount: () => void } {
  const [state, setState] = useState<SpacesState>(() => fresh() ?? { kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listeners.add(setState);
    void readSpaces().then((s) => { if (live) setState(s); });
    return () => { live = false; listeners.delete(setState); };
  }, [enabled]);
  /* The server is still reading the cards: ask again shortly (its own wait is the long part), and stop
     after MAX_PENDING asks. A local read; ClickUp is asked for nothing by it. */
  const waiting = state.kind === "loading" && state.why === PENDING_CARDS;
  useEffect(() => {
    if (!enabled || !waiting) return;
    const t = setTimeout(() => { void readSpaces(false, true).then((s) => { setState(s); for (const l of listeners) l(s); }); }, PENDING_RETRY_MS);
    return () => clearTimeout(t);
  }, [enabled, waiting, state]);
  const reread = useCallback(() => {
    setState((s) => ({ kind: "loading", stale: s.kind === "ok" ? s.spaces : s.kind === "error" ? s.stale : undefined }));
    void readSpaces(true).then((s) => { setState(s); for (const l of listeners) l(s); });
  }, []);
  /* The pick of counted spaces changed: the spaces stay on screen while the new answer comes. */
  const recount = useCallback(() => { recountSpaces(); }, []);
  return { state, reread, recount };
}
