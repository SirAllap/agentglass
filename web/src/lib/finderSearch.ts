// The finder's Ctrl+K overlay, as decisions that can be tested without a screen.

export interface SearchHit { path: string; dir: boolean }

/** Where a chosen hit leads: a folder opens as the place, anything else selects it inside its own folder. */
export type HitTarget = { kind: "open-folder"; path: string } | { kind: "select"; dir: string; name: string };

const split = (path: string): [dir: string, name: string] => {
  const cut = path.lastIndexOf("/");
  return [cut <= 0 ? "/" : path.slice(0, cut), path.slice(cut + 1)];
};

/** Enter opens the hit; Alt+Enter opens the folder that holds it (for a folder, its parent). */
export function hitTarget(hit: SearchHit, alt: boolean): HitTarget {
  const [dir, name] = split(hit.path);
  if (alt) return { kind: "select", dir, name };
  return hit.dir ? { kind: "open-folder", path: hit.path } : { kind: "select", dir, name };
}

/** The highlighted row after an arrow key: it stops at both ends, as a list does. */
export const stepHot = (hot: number, dir: 1 | -1, count: number): number => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, hot + dir)));

/** A path as the person writes it: home as ~, and the name left out because the row shows it on its own. */
export function whereText(path: string, home: string): string {
  const [dir] = split(path);
  const h = home.replace(/\/+$/, "");
  return dir === h ? "~" : dir.startsWith(h + "/") ? `~${dir.slice(h.length)}` : dir;
}

/** What the empty and the unanswered states say. */
/** Strata's footer warning: shown while the index is still being built, since what is listed may be missing entries. */
export const partialResults = (status: "idle" | "building" | "ready", found: number): boolean => status === "building" && found > 0;

export function emptyText(q: string, status: "idle" | "building" | "ready", found: number): string {
  if (!q.trim()) return "Type to search Home and mounted local drives";
  if (found > 0) return "";
  return status === "building" ? "Still indexing Home. Results appear as it goes." : "No matching files or folders";
}
