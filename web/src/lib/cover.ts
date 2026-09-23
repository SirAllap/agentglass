/**
 * The launch cover, taken down.
 *
 * web/index.html paints the cover in the first frame and keeps it up through
 * React's mount; this module decides when it comes down (the decision itself
 * lives in coverStep.ts, where it is tested) and plays the hand-off.
 *
 * The hand-off is one motion: the mark on the cover flies to the living mark
 * in the title bar, the one marked `coverTarget`, and becomes it, while the
 * cover's ground fades and the app, loaded all along under it, is simply there.
 * It is a FLIP — measure where the mark is now and where it lands, then
 * animate only the transform between them — so it runs on the compositor at
 * whatever the main thread is doing. It starts from the mark's CURRENT place:
 * when the app is ready before the cover's own entrance has finished, the
 * entrance is stopped where it stands and the flight picks up from there, so
 * a fast start is a short, continuous move rather than a jump.
 *
 * Nothing here ever makes the app wait: the cover is up while the app loads
 * anyway, it goes the moment the panels on screen say they have drawn, and
 * input goes to the app from the first frame of the hand-off.
 */
import { useEffect } from "react";
import type { SidecarFailure } from "./api.ts";
import { COVER_SETTLE_MS, coverLine, coverStep, springEasing, type CoverFailure } from "./coverStep.ts";

/** The flight, in ms. Longer than a UI transition on purpose: it happens once
 *  per launch, and it is a move across the whole window, not a toggle. */
const FLIGHT_MS = 680;
/**
 * The two axes on their own springs, the vertical one a touch quicker, so the
 * mark lifts before it glides and draws an arc rather than a ruled line.
 *
 * A spring is a CSS `linear()` easing, which Chrome has had since 113 and
 * Safari since 17.2 — and `animate()` THROWS on an easing it does not know,
 * mid hand-off. The build targets older than both, and a phone opens this
 * same page, so those get the nearest cubic-béziers instead.
 */
const SPRINGS = typeof CSS !== "undefined" && typeof CSS.supports === "function"
  && CSS.supports("transition-timing-function", "linear(0, 1)");
const EASE_X = SPRINGS ? springEasing(0.5, FLIGHT_MS / 1000) : "cubic-bezier(.3, .8, .25, 1)";
const EASE_Y = SPRINGS ? springEasing(0.42, FLIGHT_MS / 1000) : "cubic-bezier(.25, .85, .25, 1)";
const EASE_OUT = "cubic-bezier(.16, 1, .3, 1)";
/** The ground: gone well before the mark lands, so the app is on screen while
 *  the mark is still settling into it. On a strong ease-out it is three
 *  quarters clear in the first 100ms: the hand-off costs the app that much
 *  visibility, not the length of the flight. */
const GROUND_MS = 300;
/** No flight: reduced motion, or nowhere to land. */
const FADE_MS = 320;
const REDUCED_MS = 180;

type Phase = "up" | "leaving" | "gone";

const doc: Document | null = typeof document === "undefined" ? null : document;
const coverEl = () => doc?.getElementById("ag-cover") ?? null;

/** The desktop shell's side of the story (electron/preload.js), read once at
 *  load the way api.ts reads it. Absent in a browser tab. */
type Shell = {
  sidecarUp?: () => boolean;
  sidecarFailure?: SidecarFailure | null;
  onServerFailed?: (fn: (f: SidecarFailure | null) => void) => () => void;
};
const shell: Shell | undefined = typeof window === "undefined" ? undefined : (window as unknown as { agentglass?: Shell }).agentglass;

let phase: Phase = doc?.documentElement.classList.contains("ag-covering") && coverEl() ? "up" : "gone";
const holds = new Map<string, number>();
let mounted = false;
let failure: CoverFailure | null = null;
/** The shell has given up on the server, whatever the reason. */
let serverFailed = false;
let changedAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const now = () => performance.now();
function mark(name: string) {
  try { performance.mark(name); } catch { /* no User Timing: nothing to record */ }
}

/** Whether the cover is still up. Only true in a real page, before hand-off. */
export function coverIsUp(): boolean {
  return phase === "up";
}

/**
 * Whether the server's fate is known: the desktop shell has seen it answer,
 * or has given up on it. Without a shell there is nothing to wait for — the
 * page itself came from the server.
 *
 * Until then a refused request is not an answer: the server is still coming
 * up (the shell waits up to twelve seconds for it on a cold machine), and a
 * panel that took the refusal for its answer would have the cover lift over a
 * disconnected app.
 */
export function serverSettled(): boolean {
  if (typeof shell?.sidecarUp !== "function") return true;
  try { return shell.sidecarUp() === true || serverFailed; } catch { return true; }
}

/**
 * Whether a refused request is an answer. Without a shell it is: the page came
 * from the server, so a refusal is real. With one, only once the shell has
 * given up on the server — while it is starting, and in the moment after it
 * came up, a refusal is a request that raced it, and whoever made it asks
 * again: the terminal reconnects, the scope and git are read again. Taken for
 * an answer, it lifted the cover over "disconnected · reconnecting…".
 */
export function refusalFinal(): boolean {
  return typeof shell?.sidecarUp !== "function" || serverFailed;
}

/**
 * Keep the cover up until the returned function is called. A no-op once the
 * cover is on its way down: a panel that mounts later loads in plain sight,
 * the way it always did.
 */
export function holdCover(name: string): () => void {
  if (phase !== "up") return () => {};
  holds.set(name, (holds.get(name) ?? 0) + 1);
  touch();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (phase !== "up") return;
    const left = (holds.get(name) ?? 1) - 1;
    if (left > 0) holds.set(name, left);
    else { holds.delete(name); mark(`agx:cover:hold:${name}`); }
    touch();
  };
}

/**
 * Hold the cover while `pending` is true. Let go after the render that turned
 * it false has been committed — an effect's cleanup — so the panel's first
 * real data is on screen before the cover leaves.
 */
export function useCoverHold(name: string, pending: boolean): void {
  useEffect(() => (pending ? holdCover(name) : undefined), [name, pending]);
}

/** React has committed its first tree. Called once, from main.tsx. */
export function coverMounted(): void {
  if (mounted) return;
  mounted = true;
  mark("agx:cover:mounted");
  if (phase !== "up") return;
  // From here the status line is ours: the boot script stops writing to it.
  doc?.documentElement.classList.add("agc-app");
  // Switched off in Settings: the plain boot screen, gone as React mounts.
  if (doc?.documentElement.classList.contains("agc-off")) { finish(coverEl(), null); return; }
  touch();
}

function touch() {
  changedAt = now();
  decide();
}

function decide() {
  if (phase !== "up") return;
  if (timer) { clearTimeout(timer); timer = null; }
  const step = coverStep({ mounted, holds, changedAt, failure }, now());
  if (step.kind === "go") { handoff(step.why); return; }
  if (step.kind === "fail") { showFailure(step.failure); return; }
  hideFailure();
  if (mounted) say(coverLine(holds));
  timer = setTimeout(decide, Math.max(16, Math.min(step.recheckIn, COVER_SETTLE_MS * 10)));
}

function say(text: string) {
  const msg = doc?.getElementById("agc-msg");
  if (msg && msg.textContent !== text) msg.textContent = text;
}

// ── the server ───────────────────────────────────────────────────────────
function describe(f: SidecarFailure): CoverFailure | null {
  // A timeout is the shell giving up on waiting, not the server failing: it
  // may still come up, and nothing reports it if it does — the shell stops
  // polling at its verdict. The app's own banner says it and goes when the
  // server answers; a card here would sit over a working app until clicked.
  if (f.reason === "timeout") return null;
  return {
    title: "The server did not start",
    detail: [f.where ? `${f.what} — ${f.where}` : f.what, f.fix, f.detail ?? ""].filter(Boolean).join("\n"),
    // The app loads without it and says the same in its own banner, with the
    // rest of what can be done there.
    canContinue: true,
  };
}
let unhearFailures: (() => void) | null = null;
if (phase === "up") {
  // A failure, and the null that says a restart worked, both land here: the
  // card is taken down again on the second, and the wait resumes.
  unhearFailures = shell?.onServerFailed?.((f) => { serverFailed = !!f; failure = f ? describe(f) : null; decide(); }) ?? null;
  const first = shell?.sidecarFailure ?? null;
  if (first) { serverFailed = true; failure = describe(first); }
  // On the desktop the shell says when the server is up; until it has, the
  // cover holds for it, whatever the panels make of the refusals meanwhile.
  if (!serverSettled()) {
    const letGo = holdCover("server");
    const watch = () => { if (phase !== "up") return; if (serverSettled()) letGo(); else setTimeout(watch, 150); };
    setTimeout(watch, 150);
  }
  // From now on the cap is watched even if nothing ever mounts or holds.
  decide();
}

// ── a failure, said on the cover ─────────────────────────────────────────
/** The app under a failure card cannot take the focus or be tabbed into: its
 *  mount-time focus would pull keys into a terminal nobody can see. */
function shield(on: boolean) {
  const root = doc?.getElementById("root");
  if (on) root?.setAttribute("inert", "");
  else root?.removeAttribute("inert");
}

function showFailure(f: CoverFailure) {
  const cover = coverEl();
  const box = cover?.querySelector<HTMLElement>(".agc-error");
  if (!cover || !box) return;
  cover.classList.add("agc-failed");
  shield(true);
  box.querySelector(".agc-err-title")!.textContent = f.title;
  box.querySelector(".agc-err-detail")!.textContent = f.detail;
  const go = box.querySelector<HTMLButtonElement>('[data-act="continue"]');
  const again = box.querySelector<HTMLButtonElement>('[data-act="reload"]');
  if (go) { go.hidden = !f.canContinue; go.onclick = () => handoff("continue"); }
  if (again) again.onclick = () => location.reload();
  if (box.hidden) {
    box.hidden = false;
    (go && !go.hidden ? go : again)?.focus();
  }
}

function hideFailure() {
  const cover = coverEl();
  const box = cover?.querySelector<HTMLElement>(".agc-error");
  if (!cover || !box || box.hidden || !cover.classList.contains("agc-failed")) return;
  // Only a server's failure is taken back — by the server coming up. The
  // interface not loading, here or in the boot script, stays said.
  const go = box.querySelector<HTMLButtonElement>('[data-act="continue"]');
  if (!go || go.hidden) return;
  box.hidden = true;
  go.hidden = true;
  cover.classList.remove("agc-failed");
  shield(false);
}

// ── the hand-off ─────────────────────────────────────────────────────────
function handoff(why: "ready" | "cap" | "continue") {
  if (phase !== "up") return;
  phase = "leaving";
  if (timer) { clearTimeout(timer); timer = null; }
  mark(`agx:cover:${why}`);
  shield(false);
  doc!.documentElement.classList.add("agc-app");
  const cover = coverEl();
  if (!cover) { finish(null, null); return; }
  cover.classList.add("agc-leaving");
  const target = landing();
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Whatever goes wrong in the motion, the cover still comes down: a cover
  // stuck over a live app, taking no clicks, is the one outcome not allowed.
  try {
    if (still || !target) fade(cover, still ? REDUCED_MS : FADE_MS);
    else fly(cover, target);
  } catch {
    if (target) target.style.visibility = "";
    finish(cover, null);
  }
}

/** The title bar's living mark, if it is on screen to be landed on. */
function landing(): HTMLElement | null {
  const el = doc!.querySelector<HTMLElement>("[data-cover-target]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight ? el : null;
}

function fly(cover: HTMLElement, target: HTMLElement) {
  const q = <T extends Element = HTMLElement>(sel: string) => cover.querySelector<T & HTMLElement>(sel);
  const markEl = q(".ag-lm"), enter = q(".agc-enter"), fx = q(".agc-fx"), fy = q(".agc-fy"), fs = q(".agc-fs");
  if (!markEl || !enter || !fx || !fy || !fs) { fade(cover, FADE_MS); return; }

  // Take over from whatever is on screen now: an entrance still in flight is
  // stopped where it stands, not snapped to its end.
  for (const a of enter.getAnimations()) {
    try { a.commitStyles(); } catch { /* not rendered: nothing to keep */ }
    a.cancel();
  }
  const from = markEl.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width < 1) { fade(cover, FADE_MS); return; }
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = to.width / from.width;

  const all: Animation[] = [];
  const move = (el: HTMLElement, frames: Keyframe[], easing: string) => {
    const a = el.animate(frames, { duration: FLIGHT_MS, easing, fill: "forwards" });
    all.push(a);
    return a;
  };
  const flight = [
    move(fx, [{ transform: "translateX(0px)" }, { transform: `translateX(${dx}px)` }], EASE_X),
    move(fy, [{ transform: "translateY(0px)" }, { transform: `translateY(${dy}px)` }], EASE_Y),
    move(fs, [{ transform: "scale(1)" }, { transform: `scale(${s})` }], EASE_X),
  ];
  // The destination is hidden while the mark flies in, and shown on the frame
  // the flying one is removed: one mark on screen at every moment. Hidden only
  // once the flight exists, so a flight that fails never takes the mark with it.
  target.style.visibility = "hidden";

  const fadeOut = (el: Element | null, ms: number) => {
    if (!(el instanceof HTMLElement) || el.hidden) return;
    const from = getComputedStyle(el).opacity;
    // Each of these still has its own CSS animation on opacity — an entrance
    // held at its end, the glow's breathing — and a second one on the same
    // property cannot run on the compositor. Traced: the fades fell back to
    // the main thread, and the first frame of the whole hand-off, flight
    // included, came about 70ms after it began. Stopped where they stand, the
    // fades composite too.
    for (const a of el.getAnimations()) {
      try { a.commitStyles(); } catch { /* not rendered: nothing to keep */ }
      a.cancel();
    }
    all.push(el.animate([{ opacity: from }, { opacity: 0 }], { duration: ms, easing: EASE_OUT, fill: "forwards" }));
  };
  // A mark caught mid-entrance finishes arriving as it flies.
  if (parseFloat(getComputedStyle(enter).opacity) < 1) {
    all.push(enter.animate([{ opacity: getComputedStyle(enter).opacity }, { opacity: 1 }], { duration: 180, easing: EASE_OUT, fill: "forwards" }));
  }
  // The ring goes with the mark, shrinking with it, and is gone before it lands.
  fadeOut(q(".agc-rings"), FLIGHT_MS * 0.45);
  // The scenery and the line go first and fastest, so nothing of the cover is
  // left floating over the app; then the ground, and the app is there under it
  // while the mark is still on its way.
  cover.querySelectorAll(".agc-scene, .agc-status, .agc-error").forEach((el) => fadeOut(el, 120));
  fadeOut(q(".agc-bg"), GROUND_MS);
  startTogether(all);

  settle(flight, FLIGHT_MS, () => finish(cover, target));
}

/**
 * Give every animation of the hand-off one start time, a frame from now.
 *
 * Left to themselves, animations that run on the compositor wait for it to
 * report when it first drew them before their clock starts, and until then
 * they hold at their first frame. Traced in the desktop app, where Linux
 * composites on the CPU and a frame takes 15-25ms to draw: the hand-off sat
 * still for 40-60ms after it had begun. A start time set here is no longer a
 * question to ask, and a frame ahead is time for the compositor to have it.
 */
function startTogether(anims: Animation[]) {
  const now = document.timeline?.currentTime;
  if (typeof now !== "number") return;
  for (const a of anims) {
    try { a.startTime = now + 16; } catch { /* left to start on its own */ }
  }
}

function fade(cover: HTMLElement, ms: number) {
  const a = cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE_OUT, fill: "forwards" });
  startTogether([a]);
  settle([a], ms, () => finish(cover, null));
}

/** Run `done` once, when every animation has finished — or a beat after it
 *  should have, because a window that is not being drawn (minimised, on a
 *  hidden workspace) never finishes an animation at all. */
function settle(anims: Animation[], ms: number, done: () => void) {
  let ran = false;
  const once = () => { if (!ran) { ran = true; done(); } };
  Promise.all(anims.map((a) => a.finished)).then(once, once);
  setTimeout(once, ms + 250);
}

/**
 * The flying mark hands its orbit to the one in the title bar: the contact
 * carries on from exactly where it is. Both are the same markup, so their
 * animations pair up by element position and name.
 */
function handOverOrbit(from: Element, to: Element) {
  const a = from.querySelector(".ag-lm"), b = to.querySelector(".ag-lm");
  if (!a || !b) return;
  const key = (root: Element, x: Animation) => {
    const el = (x.effect as KeyframeEffect | null)?.target;
    const name = (x as CSSAnimation).animationName ?? "";
    return el instanceof Element ? `${[...root.querySelectorAll("*")].indexOf(el)}:${name}` : "";
  };
  const src = new Map(a.getAnimations({ subtree: true }).map((x) => [key(a, x), x]));
  for (const d of b.getAnimations({ subtree: true })) {
    const s = src.get(key(b, d));
    if (s && s.currentTime !== null) d.currentTime = s.currentTime;
  }
}

function finish(cover: HTMLElement | null, target: HTMLElement | null) {
  if (phase === "gone") return;
  phase = "gone";
  if (timer) { clearTimeout(timer); timer = null; }
  unhearFailures?.();
  shield(false);
  if (cover && target) {
    try { handOverOrbit(cover, target); } catch { /* the title bar's orbit runs on its own time instead */ }
  }
  if (target) target.style.visibility = "";
  cover?.remove();
  doc?.documentElement.classList.remove("ag-covering");
  holds.clear();
  mark("agx:cover:gone");
}
