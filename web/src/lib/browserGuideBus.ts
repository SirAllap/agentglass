/*
 * The seam between guide mode's two panel halves. The drive side (the relay's
 * `guide`/`point` asks and the guest's isolated observer) emits GuideEvents
 * here; the panel folds them into its activity state and draws the bubble.
 * The person's answers (OK, Back, Stop, Done) go the other way, to whatever
 * is holding the agent's `guide next`. Events, never polling.
 */
import type { GuideAnswer, GuideEvent } from "./browserAgentActivity.ts";

type Fn<T> = (v: T) => void;
const events = new Set<Fn<GuideEvent>>();
const answers = new Set<Fn<{ tab: string; answer: GuideAnswer }>>();

export function emitGuideEvent(ev: GuideEvent): void { for (const f of events) f(ev); }
export function onGuideEvent(f: Fn<GuideEvent>): () => void { events.add(f); return () => { events.delete(f); }; }

export function answerGuide(tab: string, answer: GuideAnswer): void { for (const f of answers) f({ tab, answer }); }
export function onGuideAnswer(f: Fn<{ tab: string; answer: GuideAnswer }>): () => void { answers.add(f); return () => { answers.delete(f); }; }

/** What a `guide next` answers: the person's button, their click on the target, or the page changing. */
export type GuideNextEvent = GuideAnswer | "click" | "navigated" | "closed" | "suggest-inserted" | "regenerate" | "input" | "submit";
/** `note`: the person's one line on "Suggest another" ("shorter"), only with regenerate. */
export interface GuideNext { event: GuideNextEvent; url?: string; note?: string }

/*
 * The other end of `guide next`, per tab. One answer per step: the first thing
 * the person does reaches the agent; a second press, a later rect, a link's
 * navigation after its click are the same step and are dropped. Stop always
 * gets through. With no `guide next` waiting, the answer is HELD and the next
 * one returns it at once, so Stop pressed between two asks still ends the lock.
 */
const waiting = new Map<string, (n: GuideNext | null) => void>();
const held = new Map<string, GuideNext>();
const answered = new Set<string>();

export function deliverGuide(tab: string, n: GuideNext): void {
  const terminal = n.event === "stop" || n.event === "closed";
  if (answered.has(tab) && !terminal) return;
  answered.add(tab);
  const w = waiting.get(tab);
  if (w) { waiting.delete(tab); w(n); return; }
  if (!terminal && held.has(tab)) return;
  held.set(tab, n);
}

/** News for the agent that is not the step's answer (the person put the
 *  card's draft in the field): a waiting `guide next` hears it, else it waits
 *  in line ahead of the answer. It never ends the step or blocks its answer. */
const notes = new Map<string, GuideNext[]>();
export function noteGuide(tab: string, n: GuideNext): void {
  const w = waiting.get(tab);
  if (w) { waiting.delete(tab); w(n); return; }
  const q = notes.get(tab) ?? [];
  q.push(n);
  notes.set(tab, q);
}

/** A new `point`: the step before it is answered and gone, except a Stop not yet heard. */
export function newGuideStep(tab: string): void {
  answered.delete(tab);
  notes.delete(tab);
  const h = held.get(tab);
  if (h && h.event !== "stop" && h.event !== "closed") held.delete(tab);
}

/** The Stop (or close) held for this tab and not yet heard by a `guide next`, if any. */
export function heldGuideEnd(tab: string): GuideNext | null {
  const h = held.get(tab);
  return h && (h.event === "stop" || h.event === "closed") ? h : null;
}

/** The longest a guide step waits: the timeout arrives from a CLI, and setTimeout fires at once past 2^31 ms. */
const MAX_WAIT_MS = 60 * 60_000;

/** Wait up to `ms` for this step's answer; null when nothing came. A newer wait on the same tab ends the older one with null. */
export function waitGuideNext(tab: string, ms: number): Promise<GuideNext | null> {
  const q = notes.get(tab);
  if (q?.length) { const n = q.shift()!; if (!q.length) notes.delete(tab); return Promise.resolve(n); }
  const h = held.get(tab);
  if (h) { held.delete(tab); return Promise.resolve(h); }
  waiting.get(tab)?.(null);
  return new Promise((res) => {
    const f = (n: GuideNext | null) => { clearTimeout(t); if (waiting.get(tab) === f) waiting.delete(tab); res(n); };
    const t = setTimeout(() => f(null), Math.min(Math.max(0, ms), MAX_WAIT_MS)); // loop-ok: one deadline per guide next
    waiting.set(tab, f);
  });
}

/** Guide start or end: nothing of an earlier guide on this tab carries over. A waiting next hears null. */
export function clearGuideTab(tab: string): void {
  answered.delete(tab); held.delete(tab); notes.delete(tab);
  const w = waiting.get(tab);
  if (w) { waiting.delete(tab); w(null); }
}

/** Tests: forget every tab. */
export function resetGuideBus(): void {
  for (const t of [...waiting.keys()]) clearGuideTab(t);
  held.clear(); answered.clear(); notes.clear();
}
