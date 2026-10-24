/*
 * How the window is drawn, as four preferences: density, the interface font
 * size, a translucent sidebar, reduced motion.
 *
 * Each is stored in the browser's own storage and painted on the root element
 * as an attribute (`data-density`, `data-ui-font`, `data-translucent`,
 * `data-reduce-motion`); index.css reads the attributes and nothing else, so a
 * setting has one place that says what it does. `applyLook` is the only writer
 * of those attributes. web/index.html repeats the reading, in a few lines of
 * its own, so the first frame is already drawn this way (a test holds the keys
 * to the same strings).
 *
 * Ceilings, said here so they are a limit that was chosen and not a gap:
 *   - The font size scales the text the app sets by a class (`text-[11px]`).
 *     A size written inline, an icon and the terminal (it has its own size)
 *     stay as they are. Display size, in Window & startup, is the control that
 *     scales everything at once.
 *   - Density scales the vertical padding of rows and cards (the 8, 10 and 12 px
 *     steps) and the settings rows. A control sized by a fixed height keeps it.
 *   - Reduce motion off, over an OS that asks for less motion, does not undo
 *     the few animations the stylesheet drops by itself under that OS setting.
 */
import { IS_DESKTOP, translucentSupported, setWindowTranslucent } from "./desktop.ts";

export type Density = "compact" | "comfortable" | "roomy";
export const DENSITIES: readonly Density[] = ["compact", "comfortable", "roomy"];
export const DEFAULT_DENSITY: Density = "comfortable";

/** The sizes the select offers, in px; 13 is what the app is drawn at. */
export const UI_FONT_SIZES: readonly number[] = [12, 13, 14, 15];
export const DEFAULT_UI_FONT = 13;

export const DENSITY_KEY = "agentglass-density";
export const UI_FONT_KEY = "agentglass-ui-font";
export const TRANSLUCENT_KEY = "agentglass-translucent";
export const REDUCE_MOTION_KEY = "agentglass-reduce-motion";

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
/** An absent key is the default, as every other preference here stores it. */
const write = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ }
};

export function densityPref(): Density {
  const v = read(DENSITY_KEY);
  return (DENSITIES as readonly string[]).includes(v ?? "") ? (v as Density) : DEFAULT_DENSITY;
}
export function setDensityPref(d: Density): void { write(DENSITY_KEY, d === DEFAULT_DENSITY ? null : d); applyLook(); }

export function uiFontPref(): number {
  const n = Number(read(UI_FONT_KEY));
  return UI_FONT_SIZES.includes(n) ? n : DEFAULT_UI_FONT;
}
export function setUiFontPref(px: number): void { write(UI_FONT_KEY, px === DEFAULT_UI_FONT ? null : String(px)); applyLook(); }

/** On only where the shell can make the window see-through: a browser tab has no desktop behind it. */
export function translucentPref(): boolean { return translucentSupported() && read(TRANSLUCENT_KEY) === "1"; }
export function setTranslucentPref(on: boolean): void {
  write(TRANSLUCENT_KEY, on ? "1" : null);
  applyLook();
  void setWindowTranslucent(on);
}

const osReduces = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** What was chosen: null until somebody chooses, and then the system's setting is not asked. */
export function reduceMotionChoice(): boolean | null {
  const v = read(REDUCE_MOTION_KEY);
  return v === "1" ? true : v === "0" ? false : null;
}
/** What is in force: the choice, else the system's own setting. */
export function reduceMotionPref(): boolean { return reduceMotionChoice() ?? osReduces(); }
export function setReduceMotionPref(on: boolean): void { write(REDUCE_MOTION_KEY, on ? "1" : "0"); applyLook(); }
/** Back to following the system. */
export function resetReduceMotion(): void { write(REDUCE_MOTION_KEY, null); applyLook(); }

/** For code that animates from script: the same answer the stylesheet gives. */
export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.hasAttribute?.("data-reduce-motion")) return true;
  return reduceMotionChoice() === false ? false : osReduces();
}

/** Paint the four preferences on the root. Called at boot and after every write. */
export function applyLook(root: HTMLElement | undefined = typeof document !== "undefined" ? document.documentElement : undefined): void {
  if (!root || typeof root.setAttribute !== "function") return;
  const set = (name: string, v: string | null) => { if (v === null) root.removeAttribute?.(name); else root.setAttribute(name, v); };
  const d = densityPref();
  set("data-density", d === DEFAULT_DENSITY ? null : d);
  const px = uiFontPref();
  set("data-ui-font", px === DEFAULT_UI_FONT ? null : String(px));
  root.style?.setProperty("--agx-fs", String(px / DEFAULT_UI_FONT));
  set("data-translucent", translucentPref() ? "" : null);
  set("data-reduce-motion", reduceMotionPref() ? "" : null);
}

/** Follow the system's reduced-motion setting for as long as nobody chose, and the shell's see-through window at boot. */
export function watchLook(): void {
  applyLook();
  if (IS_DESKTOP && translucentPref()) void setWindowTranslucent(true);
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => applyLook());
}
