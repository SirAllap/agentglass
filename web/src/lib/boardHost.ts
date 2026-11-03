/*
 * One pull-request board and one task board, shown wherever you last looked.
 *
 * Both can be opened in two places: their view on the rail, and a tab on the
 * floating bench. Two copies was the obvious build and the wrong one. Each
 * panel keeps what you are doing in its own component state — the repository,
 * the scope, the page, the pull request that is open, which files are
 * expanded — so a second copy is a second, different answer: open a pull
 * request in the bench, go to the view, and it is still showing whatever it
 * showed an hour ago. It is also a second board rendering and a second set of
 * polls for a screen you can only read one of at a time.
 *
 * So there is ONE instance of each, rendered once by the workspace into a
 * detached element this module owns, and that element is MOVED into whichever
 * place is showing it. Moving a DOM node does not touch React: the component
 * keeps its state, its data and its drafts. What a move does lose is scroll —
 * an element taken out of the document forgets its offsets — so the offsets
 * are read before and written back after.
 *
 * Which place gets it: the one that came on screen most recently. Looking at
 * the view claims it; switching to the bench tab, or opening the bench on it,
 * claims it back. A place that is on screen without the board says where the
 * board is and offers to bring it — that is the whole cost of there being one.
 * A place that goes OFF screen keeps the board rather than handing it on, so
 * flicking between bench tabs does not move anything; only when the holder
 * goes away entirely (the bench closed, the tab forgotten) does the board go
 * back to a place that still exists.
 *
 * The ceiling, stated: the same board cannot be on screen twice. Seeing one
 * pull request in the view and another in the bench at the same time is two
 * instances, which is the design this replaced.
 */

export type BoardKind = "pr" | "tasks";
export type BoardPlace = "rail" | "bench";

export interface SlotFacts { id: string; visible: boolean; seen: number }

/**
 * Who holds the board, given every place that could.
 *
 * Pure, so the rule is tested without a DOM: the most recently shown place
 * among those on screen; else whoever already has it, if it still exists;
 * else the first place registered. Null only when there is nowhere at all.
 */
export function pickHolder(slots: SlotFacts[], current: string | null): string | null {
  let best: SlotFacts | null = null;
  for (const s of slots) if (s.visible && (!best || s.seen > best.seen)) best = s;
  if (best) return best.id;
  if (current && slots.some((s) => s.id === current)) return current;
  return slots[0]?.id ?? null;
}

interface Slot extends SlotFacts { kind: BoardKind; place: BoardPlace; el: HTMLElement }

const slots = new Map<string, Slot>();
const holder: Record<BoardKind, string | null> = { pr: null, tasks: null };
const nodes: Partial<Record<BoardKind, HTMLElement>> = {};
const listeners = new Set<() => void>();
let clock = 0;

function emit(): void { for (const fn of listeners) fn(); }

export function subscribeBoards(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The element the board is rendered into. Created once and never replaced:
 *  a new element would be a portal to somewhere else, which React answers by
 *  mounting the whole panel again. */
export function boardNode(kind: BoardKind): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let n = nodes[kind];
  if (!n) {
    n = document.createElement("div");
    n.className = "absolute inset-0 flex flex-col min-h-0";
    n.dataset.agxBoard = kind;
    nodes[kind] = n;
  }
  return n;
}

/**
 * Put the board's element inside `into`, keeping every scroll position in it.
 *
 * Read first, while the element is still laid out; `appendChild` detaches and
 * reattaches in one call, and the offsets come back as zero.
 */
function move(node: HTMLElement, into: HTMLElement): void {
  if (node.parentElement === into) return;
  const kept: [Element, number, number][] = [];
  if (node.isConnected) {
    for (const e of node.querySelectorAll("*")) {
      if (e.scrollTop || e.scrollLeft) kept.push([e, e.scrollTop, e.scrollLeft]);
    }
  }
  into.appendChild(node);
  for (const [e, top, left] of kept) { e.scrollTop = top; e.scrollLeft = left; }
}

function settle(kind: BoardKind): void {
  const mine = [...slots.values()].filter((s) => s.kind === kind);
  const next = pickHolder(mine, holder[kind]);
  if (next !== holder[kind]) {
    holder[kind] = next;
    const node = boardNode(kind);
    const to = next ? slots.get(next) : undefined;
    if (node && to) move(node, to.el);
    else node?.remove();
  }
  emit();
}

/** A place the board can be shown in. Returns the way out. */
export function registerSlot(id: string, kind: BoardKind, place: BoardPlace, el: HTMLElement, visible: boolean): () => void {
  slots.set(id, { id, kind, place, el, visible, seen: visible ? ++clock : 0 });
  settle(kind);
  return () => {
    slots.delete(id);
    if (holder[kind] === id) holder[kind] = null;
    settle(kind);
  };
}

/** A place came on screen or left it. Coming on screen is a claim. */
export function setSlotVisible(id: string, visible: boolean): void {
  const s = slots.get(id);
  if (!s || s.visible === visible) return;
  s.visible = visible;
  if (visible) s.seen = ++clock;
  settle(s.kind);
}

/** "Bring it here" — the same claim as coming on screen. */
export function claimSlot(id: string): void {
  const s = slots.get(id);
  if (!s) return;
  s.seen = ++clock;
  settle(s.kind);
}

export const boardHolder = (kind: BoardKind): string | null => holder[kind];

/** Where the board is, for a place that does not have it to say so. */
export function boardPlace(kind: BoardKind): BoardPlace | null {
  const id = holder[kind];
  return id ? slots.get(id)?.place ?? null : null;
}

/** Whether the board is on screen — what its panel's `active` means. */
export function boardActive(kind: BoardKind): boolean {
  const id = holder[kind];
  return !!id && !!slots.get(id)?.visible;
}

/** Whether the bench has ever offered a place for this board — the workspace
 *  mounts the board the first time either the view or the bench asks. */
export function benchWants(kind: BoardKind): boolean {
  for (const s of slots.values()) if (s.kind === kind && s.place === "bench") return true;
  return false;
}
