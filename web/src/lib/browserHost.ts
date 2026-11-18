/*
 * One browser, shown wherever you last looked.
 *
 * The bench used to mount a second copy of the browser (`scope="bench"`), with
 * its own strip saved under its own key. That is the same mistake the boards
 * avoid (see boardHost.ts): open a profile page in the view, open the bench, and
 * it showed some other set of tabs, as if there were two browsers.
 *
 * There is ONE BrowserView, mounted by the workspace in its view box. A
 * `<webview>` guest dies when its element is detached, so unlike a board the
 * browser is NOT moved in the DOM. Its box stays where it is and, while the
 * bench holds the browser, is laid over the bench's slot with fixed position.
 * This module decides who holds it and where the box goes; it never touches
 * the page.
 *
 * Who holds it is boardHost's rule: the place that came on screen most recently.
 */
import { pickHolder, type SlotFacts } from "./boardHost.ts";
import { subscribeBench } from "./benchStore.ts";

export type BrowserPlace = "rail" | "bench";

export interface BrowserFrame { x: number; y: number; w: number; h: number }

interface Slot extends SlotFacts { place: BrowserPlace; el: HTMLElement | null }

/**
 * The holder's place, given every place that could hold it. Pure.
 * Null only when there is no place at all.
 */
export function browserPlaceOf(slots: (SlotFacts & { place: BrowserPlace })[], current: string | null): BrowserPlace | null {
  const id = pickHolder(slots, current);
  return slots.find((s) => s.id === id)?.place ?? null;
}

/**
 * Where the browser's box goes. The bench's rectangle while the bench holds it
 * and shows it; null means "stay in your view box". Pure.
 */
export function floatingFrame(place: BrowserPlace | null, benchOn: boolean, rect: BrowserFrame | null): BrowserFrame | null {
  return place === "bench" && benchOn && rect && rect.w > 0 && rect.h > 0 ? rect : null;
}

const slots = new Map<string, Slot>();
let holder: string | null = null;
let clock = 0;
let rect: BrowserFrame | null = null;
let watching: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void { for (const fn of listeners) fn(); }

export function subscribeBrowser(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A native view cannot be clipped by CSS, so it stops short of the bench's
 *  rounded bottom corners: the rect loses `radius` px at the bottom. Pure. */
export function insetBottom(r: BrowserFrame, radius: number, winBottom?: number): BrowserFrame {
  const rad = Math.max(0, radius);
  /* Only a slot that reaches the window's bottom edge meets the corner. */
  if (winBottom !== undefined && winBottom - (r.y + r.h) > rad) return r;
  return { x: r.x, y: r.y, w: r.w, h: Math.max(0, r.h - rad) };
}

/** The bench window's own corner radius (its `rounded-xl` token), not a number of ours. */
function benchRadius(el: HTMLElement): { radius: number; bottom?: number } {
  const win = el.closest("[data-bench-window]");
  return win
    ? { radius: parseFloat(getComputedStyle(win).borderBottomLeftRadius) || 0, bottom: win.getBoundingClientRect().bottom }
    : { radius: 0 };
}

function measure(): void {
  const el = holder ? slots.get(holder)?.el : null;
  const r = el?.getBoundingClientRect();
  const c = el ? benchRadius(el) : null;
  const next = r && c ? insetBottom({ x: r.left, y: r.top, w: r.width, h: r.height }, c.radius, c.bottom) : null;
  if (next?.x === rect?.x && next?.y === rect?.y && next?.w === rect?.w && next?.h === rect?.h) return;
  rect = next;
  emit();
}

/** Re-measure when the bench slot resizes, the window resizes or the bench is
 *  dragged (its geometry is in benchStore). Events only, no timer. */
function watch(): void {
  watching?.();
  watching = null;
  const el = holder ? slots.get(holder)?.el : null;
  if (!el || typeof ResizeObserver === "undefined") { measure(); return; }
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  const off = subscribeBench(measure);
  window.addEventListener("resize", measure);
  watching = () => { ro.disconnect(); off(); window.removeEventListener("resize", measure); };
  measure();
}

function settle(): void {
  const next = pickHolder([...slots.values()], holder);
  if (next !== holder) {
    holder = next;
    watch();
  }
  emit();
}

/** A place the browser can be shown in. `el` is the box the browser is laid
 *  over (the bench's slot); the view's own place passes null. */
export function registerBrowserSlot(id: string, place: BrowserPlace, el: HTMLElement | null, visible: boolean): () => void {
  slots.set(id, { id, place, el, visible, seen: visible ? ++clock : 0 });
  settle();
  return () => {
    slots.delete(id);
    if (holder === id) holder = null;
    settle();
  };
}

export function setBrowserSlotVisible(id: string, visible: boolean): void {
  const s = slots.get(id);
  if (!s || s.visible === visible) return;
  s.visible = visible;
  if (visible) s.seen = ++clock;
  settle();
}

export function claimBrowserSlot(id: string): void {
  const s = slots.get(id);
  if (!s) return;
  s.seen = ++clock;
  settle();
}

/** The bench's open transition scales and slides it; a transform fires no
 *  ResizeObserver, so the bench calls this when that transition ends and the
 *  rect becomes the settled one. */
export function remeasureBrowser(): void { measure(); }

export const browserHolder = (): string | null => holder;
export const browserPlace = (): BrowserPlace | null => (holder ? slots.get(holder)?.place ?? null : null);
/** Whether the place holding the browser is on screen — what the panel's `active` means. */
export const browserActive = (): boolean => !!holder && !!slots.get(holder)?.visible;
/** Whether the bench has ever offered a place — the workspace then mounts the browser. */
export function benchWantsBrowser(): boolean {
  for (const s of slots.values()) if (s.place === "bench") return true;
  return false;
}
/** The bench's rectangle, only while the bench holds the browser and shows it. */
export const browserFrame = (): BrowserFrame | null => floatingFrame(browserPlace(), browserActive(), rect);
