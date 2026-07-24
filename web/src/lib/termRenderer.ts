// Terminal renderer preference.
//
// xterm's WebGL renderer is fast, but on some Linux GPU/compositor stacks it
// paints the terminal solid white — a lost or wedged GL context with no error
// we can catch — and stays that way, worst of all exactly when an agent pauses
// for input so nothing ever repaints over it. The DOM renderer is a touch
// slower on a huge output flood but never does this. So the default is by
// platform: WebGL where it is reliable (macOS/Windows), DOM on Linux. Either
// way it is overridable from Settings.
//
// localStorage `agentglass.term.webgl`:
//   "gpu"        force WebGL
//   "dom"/"off"  force the DOM renderer ("off" kept for back-compat, and it is
//                what a context loss writes to remember the fallback)
//   "auto"/unset the platform default below
export const RENDERER_KEY = "agentglass.term.webgl";
export type RendererPref = "auto" | "gpu" | "dom";

const isLinux = () => {
  try { return /\bLinux\b/.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent); }
  catch { return false; }
};

/** The stored choice, normalised (legacy "off" reads as "dom"). */
export function rendererPref(): RendererPref {
  try {
    const v = localStorage.getItem(RENDERER_KEY);
    if (v === "gpu") return "gpu";
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

// A context loss this session drops us to DOM even if localStorage can't be written.
let sessionForceDom = false;

/** Whether a newly created terminal should load the WebGL renderer. */
export function wantsWebgl(): boolean {
  if (sessionForceDom) return false;
  const p = rendererPref();
  if (p === "gpu") return true;
  if (p === "dom") return false;
  return !isLinux(); // auto: GPU off on Linux by default, where the white-out lives
}

/** A lost context left the terminal blank — fall back to DOM for good. */
export function fallBackToDom(): void {
  sessionForceDom = true;
  try { localStorage.setItem(RENDERER_KEY, "dom"); } catch { /* session flag still holds */ }
}
