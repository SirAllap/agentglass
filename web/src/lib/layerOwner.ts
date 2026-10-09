/*
 * Who a floating layer belongs to, so it can go when its owner does.
 *
 * Menus, pickers and dialogs are portaled to the body, correctly: a popover
 * anchored inside content that scrolls is clipped by something eventually. The
 * price is that they stop belonging to the DOM of whatever opened them, so when
 * the bench was hidden with the chord, a picker opened from a card inside it
 * stayed floating over the view until a click landed somewhere. Nothing told it
 * the window it came from was gone.
 *
 * So a layer records its owner when it OPENS — not when the owner hides: a board
 * is carried back to its view as the bench closes, and asked afterwards, its
 * trigger is no longer inside the bench. The owner announces that it is hidden
 * once, on the toggle itself, and every layer with that owner closes. A layer
 * opened outside the bench has no owner and never hears it.
 *
 * Only the bench is an owner today. The shape (a name, an announce, a watch) is
 * what a second one would use; it is not a registry.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export const BENCH_OWNER = "bench";

/** Marks the bench window's root element. */
export const OWNER_ATTR = "data-bench-root";

/** Who owns the layers opened below this point in the React tree. A board
 *  carried into the bench says so, because its elements are in the bench's DOM
 *  only while it is there. */
export const LayerOwner = createContext<string | null>(null);

type Hidden = () => void;
const watchers = new Map<string, Set<Hidden>>();

/** The owner announces it is hidden. Every layer watching it closes. */
export function announceHidden(owner: string): void {
  for (const fn of [...(watchers.get(owner) ?? [])]) fn();
}

/** Calls `onHidden` when `owner` is announced hidden. A null owner is a layer
 *  opened outside any owner: nothing to watch. */
export function watchOwner(owner: string | null, onHidden: Hidden): () => void {
  if (!owner) return () => {};
  let set = watchers.get(owner);
  if (!set) watchers.set(owner, (set = new Set()));
  set.add(onHidden);
  return () => { set!.delete(onHidden); };
}

/** The owner a trigger sits inside, or null. */
export function ownerOfElement(el: Element | null | undefined): string | null {
  return el?.closest?.(`[${OWNER_ATTR}]`) ? BENCH_OWNER : null;
}

/** The DOM answer first (an element inside the bench window is the bench's),
 *  then the React one (a board in the bench, whose popovers have no anchor). */
export function decideOwner(el: Element | null | undefined, inherited: string | null): string | null {
  return ownerOfElement(el) ?? inherited;
}

/**
 * A question put to the person (a confirm, a merge) is a layer too, and its
 * answer is a promise somebody is awaiting: when its owner is hidden it is
 * answered with `cancel` — a "no", never a "yes". `asked` is whatever is on
 * screen (null when nothing is). Returns the note to make at the moment of
 * asking, while the button that asked still has the focus.
 */
export function useOwnedQuestion(asked: unknown, cancel: () => void): () => void {
  const inherited = useContext(LayerOwner);
  const owner = useRef<string | null>(null);
  const answer = useRef(cancel);
  answer.current = cancel;
  useEffect(() => {
    if (!asked) return;
    return watchOwner(owner.current, () => answer.current());
  }, [asked]);
  return () => {
    owner.current = decideOwner(typeof document === "undefined" ? null : document.activeElement, inherited);
  };
}

type Source = RefObject<Element | null> | Element | null | undefined;

/**
 * Close this layer when the thing that opened it is hidden.
 *
 * `open` is for a component that is mounted while closed (a Select): the owner
 * is read each time it goes from closed to open. `from` is the trigger when
 * there is one; `at` is where a menu was asked for when there is only a point
 * (a right-click), read on the first render, before the menu's own catcher is
 * in the page to be the answer.
 */
export function useCloseWithOwner(
  onClose: () => void,
  o: { open?: boolean; from?: Source; at?: { x: number; y: number } } = {},
): void {
  const inherited = useContext(LayerOwner);
  const open = o.open ?? true;
  const [atOwner] = useState(() =>
    o.at && typeof document !== "undefined" ? ownerOfElement(document.elementFromPoint(o.at.x, o.at.y)) : null);
  const close = useRef(onClose);
  close.current = onClose;
  const from = useRef(o.from);
  from.current = o.from;
  useEffect(() => {
    if (!open) return;
    const src = from.current;
    const el = src && "current" in src ? src.current : src;
    return watchOwner(decideOwner(el, atOwner ?? inherited), () => close.current());
  }, [open]);
}
