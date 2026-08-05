// Terminal renderer preference.
//
// xterm's WebGL renderer is fast, but on some Linux GPU/compositor stacks it
// paints the terminal solid white — a lost or wedged GL context with no error
// we can catch — and stays that way, worst of all exactly when an agent pauses
// for input so nothing ever repaints over it. So it stays off on Linux.
//
// What replaced it there was the DOM renderer, and that turned out to cost
// something nobody had priced: the DOM renderer is the only one that does not
// draw box-drawing characters itself. `│ ─ ┌ └`, the rules tmux puts between
// panes and every TUI puts around its output, come from whatever font the OS
// happens to supply for them — which is rarely the face the cell was measured
// from, and often one whose glyph is a couple of pixels short. Measured on a
// pane border with ordinary text beside it: 75 seams and a 2.5px horizontal
// wobble on the default font, 60 on two of the five offered faces, none on the
// other three. Which font you picked decided whether your terminal had lines
// in it.
//
// The canvas renderer draws those glyphs itself, exactly like the WebGL one and
// like every native terminal, so they fill the cell and align on every row
// whatever the font. Measured on the same border: zero seams, zero wobble, all
// six faces. And it is not WebGL — there is no GL context to lose, so none of
// the white-out this file exists to avoid. So canvas is what "not WebGL" means
// now; DOM is the last resort, for a machine where even 2D canvas fails.
//
// localStorage `agentglass.term.webgl`:
//   "gpu"        force WebGL
//   "canvas"     force the 2D canvas renderer — what a lost GL context drops to
//   "dom"/"off"  force the DOM renderer ("off" kept for back-compat)
//   "auto"/unset the platform default below
export const RENDERER_KEY = "agentglass.term.webgl";
export type RendererPref = "auto" | "gpu" | "canvas" | "dom";

const isLinux = () => {
  try { return /\bLinux\b/.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent); }
  catch { return false; }
};

/** The stored choice, normalised (legacy "off" reads as "dom"). */
export function rendererPref(): RendererPref {
  try {
    const v = localStorage.getItem(RENDERER_KEY);
    if (v === "gpu") return "gpu";
    if (v === "canvas") return "canvas";
    if (v === "dom" || v === "off") return "dom";
    return "auto";
  } catch { return "auto"; }
}

/** Persist a choice; "auto" clears the key so the platform default applies. */
export function setRendererPref(p: RendererPref): void {
  try {
    if (p === "auto") localStorage.removeItem(RENDERER_KEY);
    else localStorage.setItem(RENDERER_KEY, p);
  } catch { /* private mode — nothing we can do */ }
}

// A lost GL context this session pins us off WebGL even if localStorage can't be
// written. Not "force DOM": we still want canvas, so this is its own flag.
let sessionNoWebgl = false;

/** Whether a newly created terminal should load the WebGL renderer. */
export function wantsWebgl(): boolean {
  if (sessionNoWebgl) return false;
  const p = rendererPref();
  if (p === "gpu") return true;
  if (p === "dom" || p === "canvas") return false;
  return !isLinux(); // auto: GPU off on Linux by default, where the white-out lives
}

/**
 * A lost WebGL context left the terminal blank — drop off the GPU for good.
 *
 * To canvas, not DOM: canvas is the same drawing the GPU renderer does, minus
 * the GPU — it has no GL context to lose, and it is far faster than the DOM
 * renderer, which builds a node per cell and stalls on any burst of output (a
 * build log, or the redraw storm of dragging a tmux pane border). Persisting
 * "dom" here used to strand anyone who hit the white-out once on the slowest
 * renderer for good; "canvas" keeps the speed without the context to lose.
 */
export function fallBackToCanvas(): void {
  sessionNoWebgl = true;
  try { localStorage.setItem(RENDERER_KEY, "canvas"); } catch { /* session flag still holds */ }
}

/** Test-only: clear the session no-WebGL latch so cases do not leak into each
 *  other. Never called in the app — the latch is meant to hold for a session. */
export function __resetRendererSession(): void { sessionNoWebgl = false; }

/**
 * Should this terminal draw on a 2D canvas?
 *
 * Everywhere WebGL is not being used and the user has not explicitly asked for
 * the DOM renderer — which is to say: the normal case on Linux. This is what
 * makes box-drawing characters come out of xterm rather than out of whatever
 * font the machine has, and it is the difference between a pane border being a
 * line and being a column of dashes.
 *
 * Chosen ahead of DOM rather than after it, because there is nothing to weigh:
 * canvas is the same drawing xterm does under WebGL, minus the GPU. A machine
 * with no 2D canvas at all still lands on DOM, through the caller's catch.
 */
export function wantsCanvas(): boolean {
  return !wantsWebgl() && rendererPref() !== "dom";
}
