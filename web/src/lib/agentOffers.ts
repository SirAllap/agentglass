/*
 * The opens an agent asked for while the person was typing, waiting for them.
 *
 * `routeControl` is the decision for one incoming command (pure: it reads
 * nothing but its arguments); the store below holds what it queued; the chip
 * (components/AgentOffers.tsx) shows the store. An offer leaves three ways: the
 * person clicks it (it runs), dismisses it (it never does), or they stop
 * touching the keyboard for IDLE_APPLY_MS (it runs, oldest first, so the
 * newest ends up on screen).
 *
 * One offer per door and arguments: an agent that asks for the same page twice
 * has one chip, not two. A newer offer for the same door replaces the old one's
 * place at the end of the line.
 */
import type { ControlCmd } from "../../../shared/types.ts";
import type { UiPresent } from "../../../shared/uiActions.ts";
import { defOf, labelOf } from "./offerLabels.ts";
import { decidePresent, idleDueAt, lastInputAt, MAX_OFFERS, type FocusKind } from "./quietPresent.ts";

export type Route = { route: "apply" } | { route: "queue"; key: string; label: string };

/** Apply now, or queue behind a chip. A command that names no door, or one with
 *  no words for a chip, is applied: holding what cannot be named would be a
 *  silent drop. */
export function routeControl(cmd: ControlCmd, present: UiPresent, focus: FocusKind, sinceInputMs: number): Route {
  const d = defOf(cmd);
  if (!d) return { route: "apply" };
  const verdict = decidePresent({ present, kind: d.def.kind, inPlace: d.def.inPlace === true, focus, sinceInputMs });
  if (verdict === "apply") return { route: "apply" };
  const label = labelOf(cmd);
  if (!label) return { route: "apply" };
  return { route: "queue", key: `${d.id}:${JSON.stringify(d.cmd.args)}`, label };
}

export interface Offer {
  key: string;
  /** The name the caller stamped itself with, if it did. */
  as?: string;
  label: string;
  heldAt: number;
  apply: () => void;
}

let items: Offer[] = [];
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

export const offers = {
  list: (): readonly Offer[] => items,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  hold(o: Offer): void {
    items = [...items.filter((x) => x.key !== o.key), o].slice(-MAX_OFFERS);
    emit();
  },
  /** The person clicked it: take it off the line and run it. */
  accept(key: string): void {
    const o = items.find((x) => x.key === key);
    if (!o) return;
    items = items.filter((x) => x.key !== key);
    emit();
    o.apply();
  },
  dismiss(key: string): void {
    if (!items.some((x) => x.key === key)) return;
    items = items.filter((x) => x.key !== key);
    emit();
  },
  clear(): void { items = []; emit(); },
};

/** The keys that have waited out an idle stretch by `now`, oldest first. */
export function idleDue(list: readonly Offer[], lastInput: number | null, now: number): string[] {
  return list.filter((o) => idleDueAt(lastInput, o.heldAt) <= now).map((o) => o.key);
}

/**
 * Applies offers once the person has gone quiet. One timer, set only while
 * something is waiting and aimed at the earliest moment anything could be due;
 * typing does not touch it, the timer wakes, finds the clock moved, and sleeps
 * again. Nothing runs when the line is empty.
 */
export function attachIdleApply(now: () => number = Date.now): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    const list = offers.list();
    if (!list.length) return;
    const due = Math.min(...list.map((o) => idleDueAt(lastInputAt(), o.heldAt)));
    timer = setTimeout(fire, Math.max(0, due - now()));
  };
  const fire = () => {
    for (const k of idleDue(offers.list(), lastInputAt(), now())) offers.accept(k);
    arm();
  };
  const off = offers.subscribe(arm);
  arm();
  return () => { off(); clearTimeout(timer); };
}
