import { CANVAS_FLOW_MARKS, type CanvasEasing } from "../../../shared/pluginCanvas.ts";
import { RIDE_LATE_MS, TweenBudget, easingCss, pathData, planTween, rideDelay, travelFrames, type Point } from "./canvasGeometry.ts";

/**
 * Everything on a live canvas that moves, run through the Web Animations API
 * and nothing else.
 *
 * Two rules hold every motion here to one shape. Only `transform` and `opacity`
 * change, so nothing moves the layout and the browser can hand the work to the
 * compositor; and every start goes through `plan`, which says no under
 * reduced motion, while the canvas is hidden or off screen, and once the cap
 * of running one-shots is full. "No" is not an error: the scene has already
 * changed, the motion is the only thing skipped.
 */

export const ENTER_MS = 180;
export const EXIT_MS = 160;
export const FLIP_MS = 220;
export const TRAVEL_MS = 600;
/** How long a change stays marked under reduced motion. */
export const MARK_MS = 1200;
/** One `pulse` cycle is never shorter than this: under 3 Hz whatever a plugin asks. */
const PULSE_MIN_MS = 350;
const PULSE_MS = 600;
/** How long past its own duration a motion may run before it is ended by hand. */
const BACKSTOP_MS = 500;
/** Marks riding a `flowing` wire, and how long one takes to cross it. */
export const FLOW_MARKS = CANVAS_FLOW_MARKS;
/** Settling: enters and exits alike. An exit that eases IN starts slowly and
 *  ends fast, which reads as hesitation on the way out; exits are also the
 *  shorter of the two (EXIT_MS < ENTER_MS). */
export const SETTLE = "cubic-bezier(0.23, 1, 0.32, 1)";
export const FLOW_MS = 2400;
/** A `busy` trace on a board: one brighter mark, faster. */
export const FLOW_BUSY_MS = 1100;

export class CanvasMotion {
  readonly budget = new TweenBudget();
  reduced = false;
  paused = false;
  private readonly tweens = new Set<Animation>();
  private readonly loops = new Map<Element, { anim: Animation; sig: string }>();
  /** An `exit` that leaves its node in place holds the node faded out until
   *  something else is asked of it. */
  private readonly held = new Map<Element, Animation>();
  /** When the last ride on each board trace started (performance.now()). */
  private readonly rides = new Map<string, number>();
  /** Elements marked lit under reduced motion, with the timer that clears each. */
  private readonly marks = new Map<Element, ReturnType<typeof setTimeout>>();
  /** The fade a waiting ride leaves with, per element, so it can be cancelled with the ride. */
  private readonly fades = new Map<Element, Animation>();

  plan(ms: number | undefined, fallback: number): number {
    return planTween(this.budget, ms, fallback, this.reduced, this.paused);
  }

  /** Run keyframes in a slot `plan` (or `budget.acquire`) already granted. */
  private start(el: Element, frames: Keyframe[], duration: number, easing: string, fill: FillMode = "none", onEnd?: () => void, delay = 0): Animation | null {
    if (typeof el.animate !== "function") { this.budget.release(); onEnd?.(); return null; }
    const anim = el.animate(frames, { duration, easing, fill, delay });
    this.tweens.add(anim);
    // A page whose animation clock is not running (a window that is occluded,
    // a frame that is never painted) never finishes anything, and a full
    // budget of motions that cannot end would leave ghosts in the layer and
    // every later change skipped. The clock of the timer is the backstop.
    const backstop = setTimeout(() => { if (this.tweens.has(anim)) anim.finish(); }, delay + duration + BACKSTOP_MS);
    const done = () => {
      if (!this.tweens.delete(anim)) return;
      clearTimeout(backstop);
      this.budget.release();
      onEnd?.();
    };
    anim.onfinish = done;
    anim.oncancel = done;
    return anim;
  }

  private release(el: Element): void {
    this.held.get(el)?.cancel();
    this.held.delete(el);
    this.fades.get(el)?.cancel();
    this.fades.delete(el);
  }

  /** End every one-shot running on `el` now, so it can be measured at rest. */
  stop(el: Element): void {
    this.release(el);
    for (const a of [...this.tweens]) if ((a.effect as KeyframeEffect | null)?.target === el) a.cancel();
  }

  enter(el: Element, ms?: number): void {
    const d = this.plan(ms, ENTER_MS);
    if (d === 0) return;
    this.release(el);
    this.start(el, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], d, SETTLE);
  }

  /** `animate exit` on a node that stays: fade it out and keep it faded. */
  fadeOut(el: Element, ms?: number): void {
    const d = this.plan(ms, EXIT_MS);
    if (d === 0) return;
    this.release(el);
    // The natural pattern is fade, then remove, and React drops the element
    // without telling this class: anything held that is no longer in the page
    // is let go here, so what is held stays bounded by what is on screen.
    for (const held of [...this.held.keys()]) if (held.isConnected === false) this.held.delete(held);
    const a = this.start(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px)" }], d, SETTLE, "forwards");
    if (a) this.held.set(el, a);
  }

  pulse(el: Element, ms?: number): void {
    const d = this.plan(Math.max(ms ?? PULSE_MS, PULSE_MIN_MS), PULSE_MS);
    if (d === 0) return;
    this.release(el);
    this.start(el, [{ opacity: 1, transform: "none" }, { opacity: 0.75, transform: "scale(1.04)", offset: 0.5 }, { opacity: 1, transform: "none" }], d, easingCss("ease-in-out"));
  }

  /** A removed node leaving: a copy of it, held at its old place in `layer`,
   *  fades and drops while the layout closes up underneath. */
  exitClone(el: HTMLElement, layer: HTMLElement, origin: { left: number; top: number }, ms?: number, scale = 1): void {
    const d = this.plan(ms, EXIT_MS);
    if (d === 0) return;
    // Inside a scaled board the layer is in board units: the screen box is
    // divided back, or the copy would land off its node and at the wrong size.
    const b = el.getBoundingClientRect(), k = scale > 0 ? scale : 1;
    const r = { left: origin.left + (b.left - origin.left) / k, top: origin.top + (b.top - origin.top) / k, width: b.width / k, height: b.height / k };
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    Object.assign(ghost.style, {
      position: "absolute", margin: "0", pointerEvents: "none",
      left: `${r.left - origin.left}px`, top: `${r.top - origin.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    });
    layer.appendChild(ghost);
    this.start(ghost, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px)" }], d, SETTLE, "forwards", () => ghost.remove());
  }

  /** FLIP: the node is already where it belongs; start it from where it was. */
  shift(el: Element, dx: number, dy: number): void {
    // The slot was taken by planFlip's `grant`.
    this.release(el);
    this.start(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], this.reduced ? 0 : FLIP_MS, easingCss("ease-out"));
  }

  /** A node riding a wire, then resting where the layout put it. */
  travel(el: Element, route: readonly Point[], landing: Point, ms: number | undefined, easing: CanvasEasing | undefined, delay = 0): boolean {
    const d = this.plan(ms, TRAVEL_MS);
    if (d === 0) return false;
    this.release(el);
    const frames = travelFrames(route, landing).map((f) => ({ offset: f.offset, transform: `translate(${f.dx}px, ${f.dy}px)` }));
    // Distance sets the speed between waypoints, so the curve shapes the whole
    // ride rather than each leg. A ride that waits its turn is held at the
    // start of the route, invisible (fill backwards), and fades in as it
    // leaves: sitting visible at the start, the waiting ones would stack.
    this.start(el, frames, d, easingCss(easing), delay > 0 ? "backwards" : "none", undefined, delay);
    if (delay > 0 && typeof el.animate === "function") {
      const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, delay, fill: "backwards" });
      this.fades.set(el, fade);
      fade.onfinish = () => { if (this.fades.get(el) === fade) this.fades.delete(el); };
    }
    return true;
  }

  /**
   * When a ride along a board trace may start, spaced behind the last one on
   * the same trace by at least `gap` (`rideDelay`): the delay, or null when
   * it would start so late that the token should land in place. Asking does
   * not take the turn; `rideTaken` does, once the ride has really started, so
   * a ride the budget refused leaves the trace free for the next.
   */
  rideTurn(edge: string, now: number, gap?: number): number | null {
    // A trace nobody has ridden for longer than any queue can wait is forgotten,
    // so a scene that keeps replacing its traces does not grow this map.
    for (const [k, at] of this.rides) if (at < now - RIDE_LATE_MS * 4) this.rides.delete(k);
    return rideDelay(this.rides.get(edge), now, gap);
  }

  rideTaken(edge: string, start: number): void { this.rides.set(edge, start); }

  /** Whether a one-shot could start now at all: checked before any arithmetic is spent on one. */
  canStart(): boolean { return !this.reduced && !this.paused && this.budget.running < this.budget.cap; }

  /** Marks that ride a wire for as long as it is `flowing`. `wanted` is every
   *  mark that should be running now; the rest are stopped, and one whose
   *  route changed starts over. Loops are not counted as one-shots: their
   *  count is capped where they are chosen (`loopingIds`). */
  syncFlows(wanted: ReadonlyMap<Element, { route: readonly Point[]; delay: number; ms?: number }>): void {
    const sig = (w: { route: readonly Point[]; ms?: number }) => `${w.ms ?? FLOW_MS}${pathData(w.route)}`;
    for (const [el, cur] of this.loops) {
      const w = wanted.get(el);
      if (!w || this.reduced || sig(w) !== cur.sig) { cur.anim.cancel(); this.loops.delete(el); }
    }
    if (this.reduced) return;
    for (const [el, w] of wanted) {
      if (this.loops.has(el) || typeof el.animate !== "function" || w.route.length < 2) continue;
      const last = w.route[w.route.length - 1]!;
      const frames = travelFrames(w.route.slice(0, -1), last).map((f) => ({ offset: f.offset, transform: `translate(${f.dx}px, ${f.dy}px)` }));
      const anim = el.animate(frames, { duration: w.ms ?? FLOW_MS, delay: w.delay, iterations: Infinity, easing: "linear", fill: "both" });
      if (this.paused) anim.pause();
      this.loops.set(el, { anim, sig: sig(w) });
    }
  }

  /** Nothing runs while nobody can see it. Resuming continues, it does not restart. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const all = [...this.tweens, ...[...this.loops.values()].map((l) => l.anim)];
    for (const a of all) {
      if (paused && a.playState === "running") a.pause();
      else if (!paused && a.playState === "paused") a.play();
    }
  }

  /**
   * Under reduced motion a change still leaves a trace that does not move: the
   * element is marked lit for a moment (a static outline in the stylesheet),
   * the way a part would have glowed for its step.
   */
  mark(el: Element, ms = MARK_MS): void {
    el.setAttribute("data-lit", "true");
    const prev = this.marks.get(el);
    if (prev !== undefined) clearTimeout(prev);
    this.marks.set(el, setTimeout(() => { el.removeAttribute("data-lit"); this.marks.delete(el); }, ms));
  }

  /** How many faded-out nodes are being kept faded (a test reads this). */
  heldCount(): number { return this.held.size; }

  /** Reduced motion turned on (or the canvas went away): stop everything. */
  cancelAll(): void {
    for (const a of [...this.tweens]) a.cancel();
    for (const l of this.loops.values()) l.anim.cancel();
    this.loops.clear();
    for (const a of this.held.values()) a.cancel();
    this.held.clear();
    for (const a of this.fades.values()) a.cancel();
    this.fades.clear();
    for (const [el, t] of this.marks) { clearTimeout(t); el.removeAttribute("data-lit"); }
    this.marks.clear();
    this.rides.clear();
  }
}
