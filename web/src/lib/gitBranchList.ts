// What the Branches list decides before it draws: which section a branch sits
// in, which sections start folded, and the two numbers on a row's right edge.
// Pure, so the rules are tested where there is no renderer.
import type { GitBranch } from "../../../shared/types.ts";

/** Branches shown open under RECENT; everything older is folded away. */
export const RECENT_COUNT = 4;

export interface BranchSection {
  id: string;
  label: string;
  /** Raw name (`fix/`) rather than a heading: drawn as typed, not upper-cased. */
  raw?: boolean;
  /** A foldable section can be opened and closed by its head. */
  foldable: boolean;
  startsFolded: boolean;
  /** How many rows, in order, this section owns. */
  size: number;
}

/** The trunk's own local branch: `origin/main` -> `main`. */
export const trunkLocalName = (trunk: string | null | undefined): string | null => (trunk ? trunk.replace(/^[^/]+\//, "") : null);

/**
 * The arrows on a row. Against the trunk, as the inspector's picture is; the
 * trunk's own branch has nothing to be ahead of, so it shows its upstream.
 * Without trunk numbers (older git) the upstream is the honest fallback.
 */
export function branchDrift(b: GitBranch, trunk: string | null | undefined, upstream: { ahead: number; behind: number }): { ahead: number; behind: number; vs: "trunk" | "upstream" } {
  const own = b.name === trunkLocalName(trunk);
  if (!own && b.aheadTrunk !== undefined && b.behindTrunk !== undefined) return { ahead: b.aheadTrunk, behind: b.behindTrunk, vs: "trunk" };
  return { ...upstream, vs: "upstream" };
}

/**
 * CURRENT (the branch you are on), RECENT (the next few in the list's order),
 * then the rest folded: merged ones together, `fix/`-style families of two or
 * more, and OLDER for what is left. Rows come back in the order they are
 * drawn, so the keyboard cursor walks what the eye sees.
 */
export function sectionBranches(rows: readonly GitBranch[], current: string, recent = RECENT_COUNT): { order: GitBranch[]; sections: BranchSection[] } {
  const here = rows.filter((b) => b.name === current);
  const rest = rows.filter((b) => b.name !== current);
  const recents = rest.slice(0, recent);
  const older = rest.slice(recent);
  const merged = older.filter((b) => b.mergedIntoTrunk === true);
  const open = older.filter((b) => b.mergedIntoTrunk !== true);
  const byPrefix = new Map<string, GitBranch[]>();
  for (const b of open) {
    const cut = b.name.indexOf("/");
    const p = cut > 0 ? b.name.slice(0, cut) : "";
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), b]);
  }
  const families = [...byPrefix].filter(([p, l]) => p && l.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const famNames = new Set(families.flatMap(([, l]) => l.map((b) => b.name)));
  const left = open.filter((b) => !famNames.has(b.name));
  const sections: BranchSection[] = [];
  const order: GitBranch[] = [];
  const add = (s: Omit<BranchSection, "size">, list: GitBranch[]) => {
    if (!list.length) return;
    sections.push({ ...s, size: list.length });
    order.push(...list);
  };
  add({ id: "current", label: "CURRENT", foldable: false, startsFolded: false }, here);
  add({ id: "recent", label: "RECENT", foldable: false, startsFolded: false }, recents);
  for (const [p, l] of families) add({ id: `family:${p}`, label: `${p}/`, raw: true, foldable: true, startsFolded: true }, l);
  add({ id: "merged", label: "MERGED", foldable: true, startsFolded: true }, merged);
  add({ id: "older", label: "OLDER", foldable: true, startsFolded: false }, left);
  return { order, sections };
}

/** "3 branches are gone on origin": the ones whose work the trunk already holds. */
export function goneBanner(gone: number, trunk: string | null | undefined): { bold: string; rest: string } | null {
  if (gone < 1) return null;
  return {
    bold: `${gone} ${gone === 1 ? "branch is" : "branches are"} gone on origin`,
    rest: ` and ${gone === 1 ? "its" : "their"} work is in ${trunkLocalName(trunk) ?? "the trunk"}.`,
  };
}
