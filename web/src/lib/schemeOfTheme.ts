import { luminance, parseColor } from "./contrast.ts";

/** The scheme for a page background: a light one draws a native control in "light". */
export const schemeOfBg = (bg: string): "dark" | "light" => {
  const c = parseColor(bg.trim());
  return c && luminance(c) > 0.4 ? "light" : "dark";
};

/**
 * The scheme the browser draws a native control in, from the page's own background. "light dark" follows the
 * operating system instead, which left a light theme on a dark system with a dark audio bar (and a date box
 * with its calendar button white on white).
 */
export const schemeOfTheme = (): "dark" | "light" => {
  try { return schemeOfBg(getComputedStyle(document.documentElement).getPropertyValue("--bg")); } catch { return "dark"; }
};
