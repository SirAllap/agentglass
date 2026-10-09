import { CANVAS_ICONS, type CanvasIcon } from "../../../../shared/pluginCanvas.ts";
import type { Tone } from "../../../../shared/pluginUi.ts";
import { TONE_COLOR } from "../../lib/pluginTones.ts";

/**
 * Reading a scene node's props in the window: every value is `unknown` until
 * one of these says what it is. Shared by the flow view (PluginCanvas.tsx)
 * and the board (CanvasBoard.tsx), so the two cannot read a tone two ways.
 */

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** An integer in [lo, hi], or `fallback` when the prop is absent or not a number. */
export const int = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : fallback;
export const toneOf = (v: unknown, fallback: Tone): Tone => (typeof v === "string" && Object.hasOwn(TONE_COLOR, v) ? (v as Tone) : fallback);
export const iconOf = (v: unknown): CanvasIcon | undefined => (typeof v === "string" && (CANVAS_ICONS as readonly string[]).includes(v) ? (v as CanvasIcon) : undefined);
export const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
/** A number as the plugin asked: `digits` decimals when it said, the locale's short form when not. */
export const fixed = (v: number, digits: unknown): string =>
  typeof digits === "number" && Number.isFinite(digits) ? v.toFixed(Math.min(6, Math.max(0, Math.trunc(digits)))) : fmt.format(v);
