import { useEffect, useState } from "react";

/** A dialog's strip drops to one compact line when the window is short (the
 *  420px-tall state) or narrow (420px wide), so the question and the footer never
 *  leave the screen. Zero means "not measured yet": never low. */
export const LOW_WINDOW_PX = 560;
export const NARROW_WINDOW_PX = 480;
export const isLowWindow = (h: number, w = 0): boolean =>
  (h > 0 && h < LOW_WINDOW_PX) || (w > 0 && w < NARROW_WINDOW_PX);

/** Frame gap on each side of a dialog and the height it may take: all the window minus the gaps. */
export const DIALOG_GAP_PX = 16;
export const dialogMaxHeight = (h: number): number => Math.max(0, h - 2 * DIALOG_GAP_PX);

export function useLowWindow(): boolean {
  const read = () => typeof window !== "undefined" && isLowWindow(window.innerHeight, window.innerWidth);
  const [low, setLow] = useState(read);
  useEffect(() => {
    const on = () => setLow(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return low;
}

/** One dot on a strip. `on` filled, `hollow` outlined (gone), `merged` small and
 *  folded into the one before, `ring` the selected one, `off` grey. */
export type DotState = "on" | "hollow" | "merged" | "ring" | "off";
export type StripDot = { state: DotState; label?: string };

/** Rebase: the commits in their new order; dropped ones hollow, squashed or
 *  fixed-up ones merged into the one above. */
export function rebaseDots(steps: readonly { action: string; hash: string }[]): StripDot[] {
  return steps.map((s) => ({
    state: s.action === "drop" ? "hollow" : s.action === "squash" || s.action === "fixup" ? "merged" : "on",
    label: s.hash.slice(0, 7),
  }));
}

/** Bisect: how much of the good…bad range is still unknown, 0..1. The widest
 *  range seen so far is the whole bar; a finished bisect is 0. */
export function rangeShare(remaining: number | null | undefined, widest: number): number {
  if (remaining == null || widest <= 0) return 1;
  return Math.max(0, Math.min(1, remaining / widest));
}
export const stepsLeft = (steps: number | null | undefined): string =>
  steps == null ? "" : steps <= 0 ? "last step" : `about ${steps} step${steps === 1 ? "" : "s"} left`;

/** Blame: the file's history as dots, oldest on the left, the commit the blame
 *  is read at ringed. Capped so a long history stays one line. */
export function blameDots(history: readonly { hash: string }[], at: string, cap = 24): StripDot[] {
  const ordered = [...history].reverse();
  const hit = ordered.findIndex((h) => h.hash === at);
  const from = Math.max(0, Math.min(ordered.length - cap, hit < 0 ? ordered.length - cap : hit - (cap >> 1)));
  return ordered.slice(from, from + cap).map((h) => ({ state: h.hash === at ? "ring" : "on", label: h.hash }));
}

/** Rescue: one tile per worktree with how many of its files are kept. */
export function rescueTiles(reports: readonly { path: string; entries: readonly { path: string }[] }[], keep: (worktree: string, file: string) => boolean): { name: string; kept: number; total: number }[] {
  return reports.map((r) => ({
    name: r.path.split("/").filter(Boolean).pop() ?? r.path,
    total: r.entries.length,
    kept: r.entries.filter((e) => keep(r.path, e.path)).length,
  }));
}

/** Unstick: every step as a track. Done filled, running ringed, failed hollow,
 *  waiting grey. */
export function unstickDots(order: readonly string[], steps: Record<string, { status: string } | undefined>): { dots: StripDot[]; done: number } {
  let done = 0;
  const dots = order.map((id): StripDot => {
    const st = steps[id]?.status;
    if (st === "done") { done++; return { state: "on", label: id }; }
    if (st === "running") return { state: "ring", label: id };
    if (st === "failed") return { state: "hollow", label: id };
    return { state: "off", label: id };
  });
  return { dots, done };
}

/** Compare: dots per lane, capped so a huge gap stays one line; `more` says how many are not drawn. */
export function laneDots(count: number, cap = 14): { shown: number; more: number } {
  const shown = Math.max(0, Math.min(count, cap));
  return { shown, more: Math.max(0, count - shown) };
}
