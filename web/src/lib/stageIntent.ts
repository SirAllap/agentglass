/**
 * A prepared dialog asked for from outside, held until the pull request it is
 * about has loaded.
 *
 * The same one-slot mailbox as gitModalIntent.ts and viewModalIntent.ts, for the
 * same reason: the sender (a control command) does not know whether the pull
 * request panel is mounted or which pull request it is showing. What travels is
 * the draft and who wrote it, never a request to send anything: the panel
 * reads it, opens its own merge dialog, comment box, review form or move dialog
 * filled in, and the person's press on that dialog is the effect. Nothing in
 * this file touches the network; web/test/ui-stage-guard.test.ts holds it to that.
 */
import type { UiArgs } from "../../../shared/uiActions.ts";

export type Staged =
  | { id: "pr.merge.stage"; a: UiArgs<"pr.merge.stage"> }
  | { id: "pr.comment.stage"; a: UiArgs<"pr.comment.stage"> }
  | { id: "pr.review.stage"; a: UiArgs<"pr.review.stage"> }
  | { id: "card.move.stage"; a: UiArgs<"card.move.stage"> };

/** What the panel receives: the draft, the name the caller stamped on it (an
 *  untrusted label: any caller picks its own), and a rising number so asking
 *  for the same dialog twice is two requests. */
export type StageRequest = Staged & { by: string; n: number; at: number };

/** Long enough for a pull request to be located and read; short enough that a
 *  request nobody was there for does not open at the next unrelated visit. */
export const STAGE_TTL_MS = 60_000;

let pending: StageRequest | null = null;
let seq = 0;
const subs = new Set<() => void>();

export function latchStage(s: Staged, by: string | undefined): void {
  pending = { ...s, by: by?.trim() || "an agent", n: ++seq, at: Date.now() };
  for (const fn of subs) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** The fresh request, left in place until the panel has acted on it. */
export function peekStage(now: number = Date.now()): StageRequest | null {
  return pending && now - pending.at <= STAGE_TTL_MS ? pending : null;
}

/** Cleared by the panel once it has acted, not on arrival. */
export function clearStage(): void {
  pending = null;
  for (const fn of subs) {
    try { fn(); } catch { /* as above */ }
  }
}

export function subscribeStage(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/*
 * Text an agent left in a box the person owns (a comment, a review), by the box's
 * own storage key. The box shows who wrote it until it is sent or dismissed, and
 * holds its send button back for a moment when the mark is new. The text lives
 * where the box keeps every draft (localStorage), so the mark lives there too,
 * under its own key: a mark that did not survive a reload would turn the agent's
 * words into the person's.
 */
const MARKS_KEY = "agentglass.pr.prepared";
const prepared = new Map<string, { by: string; n: number }>();
/** The number of the newest mark each box has ever had, kept after the mark is
 *  cleared: a box that remounts when a stage arrives keys on this, so clearing a
 *  mark (a send, a dismiss) is not a reason to remount it. */
const lastMark = new Map<string, number>();
const preparedSubs = new Set<() => void>();
let preparedVersion = 0;
let hydrated = false;

function persist(): void {
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(Object.fromEntries([...prepared].map(([k, v]) => [k, v.by])))); } catch { /* no storage: the mark lasts as long as the window */ }
}
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = JSON.parse(localStorage.getItem(MARKS_KEY) || "{}") as Record<string, unknown>;
    for (const [k, by] of Object.entries(raw)) if (typeof by === "string" && !prepared.has(k)) { prepared.set(k, { by: by.slice(0, 64), n: ++seq }); lastMark.set(k, seq); }
  } catch { /* unreadable: no marks */ }
}
const bump = (): void => { preparedVersion++; for (const fn of preparedSubs) { try { fn(); } catch { /* as above */ } } };

export function markPrepared(key: string, by: string): void {
  hydrate();
  prepared.set(key, { by, n: ++seq });
  lastMark.set(key, seq);
  persist();
  bump();
}
export function clearPrepared(key: string): void {
  hydrate();
  if (prepared.delete(key)) { persist(); bump(); }
}
export function preparedFor(key: string): { by: string; n: number } | null { hydrate(); return prepared.get(key) ?? null; }
/** The newest mark number this box has had, 0 for none; stable across a clear. */
export function markedAt(key: string): number { hydrate(); return lastMark.get(key) ?? 0; }
export const subscribePrepared = (fn: () => void): (() => void) => { preparedSubs.add(fn); return () => { preparedSubs.delete(fn); }; };
/** A snapshot for useSyncExternalStore: it changes whenever any mark does. */
export const preparedSnapshot = (): number => preparedVersion;
