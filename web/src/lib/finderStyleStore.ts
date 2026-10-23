// The finder's per-item look (lib/finderStyles), held where every row can read it:
// one store for the window, written to localStorage when it changes.
import { useSyncExternalStore } from "react";
import { STYLE_KEY, applyStyle, readStyles, type ItemStyle, type Styles } from "./finderStyles.ts";

let styles: Styles | null = null;
const subs = new Set<() => void>();
const get = (): Styles => {
  if (!styles) { try { styles = readStyles(localStorage.getItem(STYLE_KEY)); } catch { styles = {}; } }
  return styles;
};

export function setItemStyle(paths: readonly string[], style: ItemStyle): void {
  styles = applyStyle(get(), paths, style);
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(styles)); } catch { /* a private window forgets; the look stays for this visit */ }
  for (const f of subs) f();
}
export const itemStyleOf = (path: string): ItemStyle | undefined => get()[path];
export function useItemStyle(path: string | undefined): ItemStyle | undefined {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => (path ? get()[path] : undefined), () => undefined);
}
