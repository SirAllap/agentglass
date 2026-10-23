/*
 * Where the Machine finder was, so that closing it is not leaving it: the folder
 * chain, what was chosen in each column, the column that had the keyboard, how far
 * each was scrolled and the widths somebody dragged. The old palette reopened
 * "exactly here" and the finder that replaced it started at home every time.
 *
 * Pure: the component reads and writes localStorage; this decides what a stored
 * value means. It is believed only where it still draws — a snapshot from an
 * older build or by hand must never put the finder in a state it cannot show.
 * Whether the folders still exist is not asked here; a column that cannot be
 * read says so itself, with the rest of the chain intact.
 */
import { parentOf, RECENT } from "./finderMiller.ts";

export interface MachineSnap {
  v: 1;
  /** First column's folder, then each child folder that was open to its right. */
  trail: string[];
  /** The chosen row of each column, by name. */
  sel: (string | null)[];
  focusCol: number;
  /** scrollTop by folder. */
  scroll: Record<string, number>;
  /** Column widths somebody dragged, by folder. */
  dragged: Record<string, number>;
  /** The palette's place when this was written. A different place now means something outside the finder (a terminal link, a chip) moved it while it was closed. */
  origin?: string;
  /** The preview shown as a page of its own (a narrow window). */
  peek: boolean;
  /** The preview panel's dragged width. */
  prevDrag?: number;
  /** Which view of the selected file the preview was on (Rendered / Source / Tree...), for that file. */
  previewTab?: { path: string; tab: string };
}

/** Does the stored place win on reopen? The last place the person was wins, however they got there (columns, sidebar, path bar, keys); the palette's own place only wins when it moved while the finder was closed, and a snapshot written under the new place is the next one to win. A snapshot from before `origin` is believed by its first column, as it always was. */
export function snapApplies(s: MachineSnap, start: string): boolean {
  return s.origin !== undefined ? s.origin === start : s.trail[0] === start;
}

export const writeMachineSnap = (s: MachineSnap): string => JSON.stringify(s);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function readMachineSnap(raw: string | null): MachineSnap | null {
  let o: Record<string, unknown>;
  try { const p = raw ? JSON.parse(raw) : null; if (!p || typeof p !== "object") return null; o = p as Record<string, unknown>; } catch { return null; }
  if (o.v !== 1 || !Array.isArray(o.trail)) return null;
  const first = o.trail[0];
  if (typeof first !== "string" || !(first.startsWith("/") || first === RECENT)) return null;
  const trail: string[] = [first];
  for (const p of o.trail.slice(1)) {
    if (typeof p !== "string" || parentOf(p) !== trail[trail.length - 1]) break;
    trail.push(p);
  }
  const sel = trail.map((_, i) => { const n = Array.isArray(o.sel) ? o.sel[i] : null; return typeof n === "string" ? n : null; });
  const inChain = new Set(trail);
  const byFolder = (v: unknown, ok: (n: number) => boolean): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === "object") for (const [k, n] of Object.entries(v)) if (inChain.has(k) && num(n) && ok(n)) out[k] = n;
    return out;
  };
  const pt = o.previewTab && typeof o.previewTab === "object" ? (o.previewTab as Record<string, unknown>) : null;
  const focusCol = num(o.focusCol) ? Math.min(trail.length - 1, Math.max(0, Math.round(o.focusCol))) : 0;
  return {
    v: 1, trail, sel, focusCol,
    scroll: byFolder(o.scroll, (n) => n >= 0),
    dragged: byFolder(o.dragged, (n) => n >= 100),
    peek: o.peek === true,
    ...(typeof o.origin === "string" ? { origin: o.origin } : {}),
    ...(num(o.prevDrag) && o.prevDrag >= 240 ? { prevDrag: o.prevDrag } : {}),
    ...(pt && typeof pt.path === "string" && pt.path.startsWith("/") && typeof pt.tab === "string" && pt.tab.length < 40 ? { previewTab: { path: pt.path, tab: pt.tab } } : {}),
  };
}
