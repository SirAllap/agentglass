/*
 * The Finder's decisions, apart from its screen: which of the six states a
 * search is in, how rows group and filter, what the bar counts, and how a
 * last-commit time reads.
 *
 * The bar counts the ticked rows, never the visible ones: a row ticked and
 * then filtered out is still going to be added, and a bar that said otherwise
 * would be a lie the button disproves.
 */
import type { SetupScan, SetupScanRow } from "../../../shared/types.ts";
import { SETUP_SCAN_MAX_REPOS } from "../../../shared/setupScan.ts";

export type FinderPhase = "empty" | "scanning" | "done" | "nothing" | "stopped" | "failed";

/** Which of §2's six states this search draws. A failed start reads as failed
 *  even when there is no scan at all, which is why `closed` exists. */
export function finderPhase(scan: SetupScan | null, failure = ""): FinderPhase {
  if (failure) return "failed";
  if (!scan) return "empty";
  if (scan.state === "failed") return "failed";
  if (scan.state === "running") return "scanning";
  if (scan.state === "stopped") return "stopped";
  return scan.repos.length ? "done" : "nothing";
}

/** The sentence a failed search shows. The server owns the reason; the
 *  Finder only wraps its own words around it. */
export function failureLine(scan: SetupScan | null, failure = ""): string {
  const why = (scan?.error || failure || "").trim();
  return why ? `The search could not run: ${why.replace(/\.$/, "")}.` : "The search could not run.";
}

/** The stopped-early line: what ran out, and what to do instead. */
export function stoppedLine(scan: SetupScan): string {
  const folders = `${scan.folders} ${scan.folders === 1 ? "folder" : "folders"}`;
  const next = "Search again, or pick a folder to search inside it.";
  if (scan.capped === "count") return `Stopped at ${SETUP_SCAN_MAX_REPOS} repositories with ${folders} read. ${next}`;
  const secs = Math.max(1, Math.round(scan.elapsedMs / 1000));
  if (scan.capped === "time") return `Stopped after ${secs} seconds with ${folders} read. ${next}`;
  return `Stopped with ${folders} read. ${next}`;
}

/** Rows whose name or path holds the filter, case-insensitively. */
export function filterRows(rows: readonly SetupScanRow[], query: string): SetupScanRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.root.toLowerCase().includes(q));
}

export interface ScanGroup {
  parent: string;
  rows: SetupScanRow[];
}

/** Rows grouped by the folder that holds them, groups and rows in name order. */
export function groupRows(rows: readonly SetupScanRow[]): ScanGroup[] {
  const by = new Map<string, SetupScanRow[]>();
  for (const r of rows) {
    const list = by.get(r.parent);
    if (list) list.push(r);
    else by.set(r.parent, [r]);
  }
  return [...by.entries()]
    .map(([parent, list]) => ({ parent, rows: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.parent.localeCompare(b.parent));
}

/** `Select all` ticks the rows the filter shows, and keeps what was ticked. */
export const tickFiltered = (ticked: readonly string[], rows: readonly SetupScanRow[]): string[] => [
  ...ticked,
  ...rows.map((r) => r.root).filter((root) => !ticked.includes(root)),
];

/** `Select none` clears only the rows the filter shows, never the whole set. */
export const untickFiltered = (ticked: readonly string[], rows: readonly SetupScanRow[]): string[] =>
  ticked.filter((root) => !rows.some((r) => r.root === root));

/** `Select all` in the Finder: the rows the filter shows, and nothing else. */
export const selectAll = (ticked: readonly string[], rows: readonly SetupScanRow[], filter: string): string[] =>
  tickFiltered(ticked, filterRows(rows, filter));

/** `Select none` in the Finder: only the rows the filter shows. */
export const selectNone = (ticked: readonly string[], rows: readonly SetupScanRow[], filter: string): string[] =>
  untickFiltered(ticked, filterRows(rows, filter));

/** The bar and the primary say the same number, and a single one says so. */
export const addLabel = (n: number): string => (n === 1 ? "Add 1 project" : `Add ${n} projects`);

/** How long ago work happened here, in the mock's own words. */
export function relativeAge(at: number, now = Date.now()): string {
  if (!at) return "no commit";
  const d = Math.max(0, now - at);
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  if (d < min) return "just now";
  if (d < hour) return `${Math.floor(d / min)} min ago`;
  if (d < day) return `${Math.floor(d / hour)} h ago`;
  if (d < 2 * day) return "yesterday";
  if (d < 7 * day) return `${Math.floor(d / day)} d ago`;
  if (d < 35 * day) return `${Math.floor(d / (7 * day))} w ago`;
  return `${Math.floor(d / (30 * day))} mo ago`;
}

/** The words the empty and the nothing-found states share: where it looks and
 *  what it leaves out. */
export function scopeLine(homedir: string, roots: readonly string[]): string {
  const home = homedir || "your home folder";
  const extra = roots.filter((r) => r !== homedir);
  const head = `It looks in ${home} and never opens a file.`;
  if (!extra.length) return head;
  return `It looks in ${home} and in ${extra.join(", ")}, and never opens a file.`;
}

export function skipLine(skips: readonly string[] = []): string {
  const parts = skips.length ? skips : ["node_modules", "caches", "hidden folders", "system folders"];
  return `It skips ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}
