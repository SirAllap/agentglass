// Pure decisions behind the Files tab's calm layout (components/PrPanel.tsx, FileTree).

/** A path as two lines of a row: the file name on top, its folder under it. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** The least width (px) at which the file list stands beside the diff (index.css `@container prf`); below it the list sits above. */
export const BP_TREE = 480;

export function treeBeside(panelWidth: number): boolean {
  return panelWidth >= BP_TREE;
}

/** "3 of 10 viewed" as a number for the bar; an empty change counts as done by nobody. */
export function filesViewedProgress(seen: number, total: number): { pct: number; done: boolean } {
  if (total <= 0) return { pct: 0, done: false };
  const s = Math.max(0, Math.min(seen, total));
  return { pct: (s / total) * 100, done: s === total };
}

export type ErrorAction = "retry" | "github" | "local";

/** Which ways out the error state offers: retry always, GitHub when there is a link, local when a checkout exists. */
export function errorActions(o: { hasUrl: boolean; hasLocal: boolean }): ErrorAction[] {
  const a: ErrorAction[] = ["retry"];
  if (o.hasUrl) a.push("github");
  if (o.hasLocal) a.push("local");
  return a;
}

/** The least width (px) of a diff box for two columns of code to be readable: a gutter and about 40 characters each. */
export const SPLIT_MIN_PX = 640;

/** Whether Split can be drawn in a diff box this wide; below it the diff falls back to Unified. A width not yet measured (0) gets the benefit of the doubt. */
export function splitFits(boxPx: number): boolean {
  return !(boxPx > 0) || boxPx >= SPLIT_MIN_PX;
}
