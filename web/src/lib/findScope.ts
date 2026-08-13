/*
 * One find bar for the whole app, and the rule for what it searches.
 *
 * There were five finders before this — the diff's, the markdown viewer's, the
 * terminal's, the browser's, the board's filter — each with its own key and its
 * own idea of what "find" means, and four views with nothing at all. So Ctrl+F
 * in a pull request's description did what the browser's own find does: search
 * every view stacked behind it too, because the workspace keeps them mounted.
 *
 * The thing that makes this hard is not searching. It is deciding WHERE, and
 * the answer is not "the view you are looking at":
 *
 *   - the workspace keeps every visited view mounted and hides the inactive
 *     ones with `visibility: hidden` (Workspace.tsx), so the document holds
 *     several screens' worth of text nobody can see;
 *   - thirty components render through `Portal` into `document.body` — Settings,
 *     a card, the file viewer — so half the app is NOT inside its view's box.
 *
 * Hence a STACK of scopes rather than a pointer to a view. The active view
 * pushes itself; anything that opens over it pushes itself on top; the find bar
 * searches whatever is on top, which is what somebody looking at a dialog means
 * by "this page". It is the same rule a browser applies to a <dialog>.
 *
 * A view whose content is not DOM — the terminal's canvas, the browser's
 * webview — registers an ENGINE instead, and the bar drives that. Nothing about
 * those two changes except which key opens them.
 */

import { useEffect } from "react";
import { domFinder } from "./domFind.ts";

/** What the bar drives. A view with its own way of searching implements this
 *  and registers it; everything else gets the DOM one. */
export interface FindEngine {
  /** Search, paint, and answer with the number of matches. */
  search(query: string): number;
  /** Move to the next or previous match, and reveal it. */
  step(dir: 1 | -1): void;
  /** Take the highlights down. */
  clear(): void;
  /** Which match is current, 1-based, or 0 when there are none. */
  at(): number;
  /** Said on the bar when a view searches something other than the page —
   *  "terminal", "page in the browser". Absent for the ordinary case. */
  label?: string;
}

type Scope = { el: HTMLElement; rank: number };

/* Higher wins. A view is 0; anything that opens over one is 1 or more, so a
   card open over the board searches the card. Menus and toasts do not push at
   all — see `Portal`'s `scope` prop. */
const scopes: Scope[] = [];
let engines: (() => FindEngine | null)[] = [];

export type FindState = {
  open: boolean;
  query: string;
  /** Matches in the current scope, and which one you are on (1-based). */
  total: number;
  at: number;
  /** From the engine, when it is not the page. */
  label?: string;
};

let state: FindState = { open: false, query: "", total: 0, at: 0 };
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

export function subscribeFind(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export const findState = (): FindState => state;

/**
 * The element the bar searches: the topmost scope that is actually showing
 * something.
 *
 * The "actually showing" half is not defensive — it is the whole correctness of
 * this. A `Portal` creates its host div when the component MOUNTS, and the
 * dialogs that use one are mounted for the life of the app with their contents
 * behind an `open &&`. Measured in the running app: five empty host divs on the
 * stack at rank 1, all of them beating the view underneath, so every search
 * answered 0 of 0 over a screen full of the word.
 *
 * An element with no children is nobody's screen; one whose box is hidden is
 * not either. Both are cheap to ask and neither can be got wrong by a caller.
 */
export function topScope(): HTMLElement | null {
  let best: Scope | null = null;
  for (const s of scopes) {
    if (!showing(s.el)) continue;
    if (!best || s.rank >= best.rank) best = s;
  }
  return best?.el ?? null;
}

type MaybeVisible = HTMLElement & { checkVisibility?: () => boolean };
function showing(el: HTMLElement | null): boolean {
  if (!el || !el.childElementCount) return false;
  const e = el as MaybeVisible;
  return typeof e.checkVisibility === "function" ? e.checkVisibility() : !!el.offsetParent;
}

/**
 * Put an element on the stack while it is on screen. Returns the way off.
 *
 * `rank` rather than "last one wins": effects run in mount order, and a card
 * that opens over the board must win whether it mounted before or after the
 * view it covers.
 */
export function pushScope(el: HTMLElement, rank = 0): () => void {
  const entry = { el, rank };
  scopes.push(entry);
  return () => {
    const i = scopes.indexOf(entry);
    if (i !== -1) scopes.splice(i, 1);
  };
}

/**
 * The same thing for a surface that is not a Portal — a dialog drawn inside its
 * own panel, like the card a board opens over its table.
 *
 * A hook rather than a prop because these are plain divs, and the alternative
 * is every one of them repeating the same effect.
 */
export function useFindScope(ref: { current: HTMLElement | null }, active: boolean, rank = 1): void {
  useEffect(() => {
    if (!active || !ref.current) return;
    return pushScope(ref.current, rank);
  }, [ref, active, rank]);
}

/**
 * A view that already has a find of its own, and wants the chord.
 *
 * The terminal and the browser are the two, and neither is a DOM search: one
 * paints its buffer to a canvas, the other lives in a `<webview>`. Both have a
 * working find bar, with a highlight and a counter this could not improve on.
 * So they take the keystroke instead of being reimplemented — the promise of
 * "one key to search" is about the KEY, not about owning every engine.
 *
 * A claim answers true when it took it. Registered last-wins, like the engines.
 */
const claims: (() => boolean)[] = [];
export function registerClaim(fn: () => boolean): () => void {
  claims.push(fn);
  return () => {
    const i = claims.indexOf(fn);
    if (i !== -1) claims.splice(i, 1);
  };
}

/** True when a view took the chord for its own bar. The shell then does
 *  nothing: opening ours on top would be two bars for one keypress. */
export function claimFind(): boolean {
  for (let i = claims.length - 1; i >= 0; i--) if (claims[i]!()) return true;
  return false;
}

/** A view that searches something that is not the DOM registers here. The last
 *  registration that answers with an engine wins, so a terminal pane with focus
 *  beats the view around it. */
export function registerEngine(fn: () => FindEngine | null): () => void {
  engines = [...engines, fn];
  return () => { engines = engines.filter((f) => f !== fn); };
}

function engine(): FindEngine {
  for (let i = engines.length - 1; i >= 0; i--) {
    const e = engines[i]!();
    if (e) return e;
  }
  return domFinder(topScope());
}

/* The engine in use for as long as the bar is open. Held rather than looked up
   per keystroke: stepping through matches must not land in a different engine
   because focus moved while you were reading. */
let live: FindEngine | null = null;

export function openFind(seed = ""): void {
  live = engine();
  state = { open: true, query: seed, total: 0, at: 0, label: live.label };
  if (seed) runQuery(seed);
  else emit();
}

export function closeFind(): void {
  live?.clear();
  live = null;
  state = { open: false, query: "", total: 0, at: 0 };
  emit();
}

export function runQuery(q: string): void {
  if (!state.open) return;
  if (!live) live = engine();
  const total = q ? live.search(q) : (live.clear(), 0);
  state = { ...state, query: q, total, at: live.at(), label: live.label };
  emit();
}

export function stepFind(dir: 1 | -1): void {
  if (!state.open || !live || !state.total) return;
  live.step(dir);
  state = { ...state, at: live.at() };
  emit();
}

/**
 * Re-run the search in place — for a view that has just rendered more of itself.
 *
 * Keeps the query and the position, because the caller is saying "there is more
 * text now", not "search for something else".
 */
export function refreshFind(): void {
  if (!state.open || !state.query) return;
  runQuery(state.query);
}

/**
 * Whether this keystroke belongs to somebody else.
 *
 * Two owners, and both were decided before this existed: a terminal's keys
 * belong to the program inside it (Ctrl+F is readline's forward-char, which is
 * why the terminal's own find is Ctrl+Shift+F), and a `<webview>` has Chromium's
 * find in it. Taking Ctrl+F from either would fix nothing and break something.
 */
export function findChordIsOursToTake(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return true;
  return !el.closest(".xterm, webview");
}
