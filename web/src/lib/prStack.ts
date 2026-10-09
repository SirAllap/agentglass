// Which pull requests are a stack, and where each one stands in it.
//
// A stacked pull request targets the branch of another one instead of the
// trunk. GitHub knows nothing of the relation: it is two strings that happen to
// be equal, `baseRefName` on one and `headRefName` on the other. Both are on
// every row of the list the board already holds, so finding a stack costs no
// request; this file is that comparison and nothing else, so it can be tested
// without a screen.
//
// The one thing a list cannot carry is a base that is not in it: the pull
// request is somebody else's, or merged, or closed. The caller asks for those
// one branch at a time (`lookups`) and this file says which branches it still
// needs (`needsLookup`) — it never asks.
//
// A stack here is a TREE read from its bottom: the first pull request whose
// base is not an open pull request, then everything that targets it, tier by
// tier. Two on one base are a fork (2a, 2b). Every card of the component gets
// the same tiers with a different one marked, which is what lets the spine on
// the board look identical on all of them.
//
// Ceiling: a tier is a depth, so two forks at the same depth that hang from
// different parents share a tier and are lettered together. Nobody has been
// seen drawing that; it reads as a fork of a fork, which is not drawn.

export interface StackPr {
  number: number;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  /** Its head branch lives in a fork: no pull request here can target it. */
  isCrossRepository?: boolean;
}

/**
 * Branches a pull request is normally aimed at, so aiming at one is not a
 * stack. The first five are the old tint rule's; the rest are long-lived
 * lines named for a version, which would otherwise read as "base branch with
 * no pull request" on every backport. A `hotfix/…` is deliberately absent:
 * that is the name of a feature branch aimed at the trunk, not of the trunk. Ceiling: a team that calls its trunk something
 * else sees a broken stack on each of its pull requests; the base token names
 * the branch, so the cause is on the card.
 */
const TRUNKS = new Set(["main", "master", "trunk", "develop", "development", "staging", "production", "prod", "stable", "next"]);
const RELEASE_LINE = /^(release|releases|rc|support|maint|maintenance)[/-]v?\d|^v?\d+(\.\d+|\.x)*(\.x)?$/i;
export const isTrunkBranch = (b: string): boolean => TRUNKS.has(b.toLowerCase()) || RELEASE_LINE.test(b);

/** What the base of a pull request turned out to be. */
export type BaseRef =
  /** An open pull request: in the list, or found by name. */
  | { kind: "pr"; number: number; branch: string; draft: boolean }
  /** Merged, and this pull request still targets its branch. */
  | { kind: "merged"; number: number; branch: string }
  /** Closed without merging. */
  | { kind: "closed"; number: number; branch: string }
  /** Nobody ever opened a pull request from that branch. */
  | { kind: "missing"; branch: string }
  /** Not asked yet. */
  | { kind: "pending"; branch: string };

export interface Box {
  /** `cur` is this card; `oth` another one on the board; `off` one that is not
   *  on the board (filtered out, in no column, or closed); the rest are bases
   *  that are gone. */
  kind: "cur" | "oth" | "off" | "merged" | "closed" | "missing";
  /** What is written in the box: the tier, with a letter on a fork. Empty for a
   *  base that is merged or closed — the view draws a mark there, because an
   *  icon is drawn and never typed. */
  label: string;
  number?: number;
}

export type SpineItem =
  | { t: "box"; box: Box }
  /** Several pull requests on one tier. */
  | { t: "fork"; boxes: Box[] }
  /** The middle of a long stack, counted instead of drawn. */
  | { t: "gap"; hidden: number };

export interface Stack {
  /** 1-based tier of this pull request among the open ones. */
  position: number;
  /** Open tiers in the stack. A base that is gone is drawn and never counted. */
  size: number;
  /** `a`, `b`… when this card shares its tier. */
  letter: string | null;
  /** The other pull requests on this tier. */
  siblings: number[];
  /** What this pull request targets; null for the trunk. */
  base: BaseRef | null;
  /** Open pull requests that target this branch, lowest number first. */
  next: number[];
  /** The trunk the bottom of the stack lands on, when it targets one directly. */
  trunk: string | null;
  /** Why the stack is broken, when it is. */
  broken: "merged" | "closed" | "missing" | null;
  /** The whole thing, as boxes, already collapsed when long. */
  spine: SpineItem[];
  /** Every tier, uncollapsed, for the ladder. */
  tiers: Box[][];
}

/** From this many tiers up the middle of the spine is counted, not drawn. */
export const COLLAPSE_FROM = 7;

/** Merged bases hopped over for one edge. */
const MAX_WALK = 16;
/** Tiers read in one stack; a taller one is not drawn, because a wrong tail is worse than none. */
const MAX_TIERS = 64;

type Lookups = ReadonlyMap<string, StackPr | null>;

/** Where one open pull request hangs from. */
interface Edge {
  /** The nearest OPEN pull request below it, or null at the bottom. */
  parent: StackPr | null;
  /** Merged or closed bases passed on the way, nearest first. */
  gone: { kind: "merged" | "closed"; number: number; branch: string }[];
  /** Why the walk stopped without a parent. */
  stop: "trunk" | "missing" | "pending" | "loop";
  /** The branch the walk was asking about when it stopped on one of the two above. */
  branch?: string;
}

/** The open pull requests we know of, by the branch they come from. The list wins over a lookup. */
function universe(prs: readonly StackPr[], lookups: Lookups): { nodes: StackPr[]; heads: Map<string, StackPr>; find: Finder } {
  const heads = new Map<string, StackPr>();
  const nodes: StackPr[] = [];
  const add = (p: StackPr) => {
    if (p.state !== "OPEN" || nodes.some((q) => q.number === p.number)) return;
    nodes.push(p);
    /* A head in a fork is not a branch of this repository, whatever it is
       called: a fork's `feature` is not upstream's `feature`. */
    if (p.headRefName && !p.isCrossRepository && !heads.has(p.headRefName)) heads.set(p.headRefName, p);
  };
  for (const p of prs) add(p);
  for (const p of lookups.values()) if (p) add(p);
  /* Merged and closed ones the list already holds answer without a request.
     A branch name gets reused, so the newest wins; an open one wins over both. */
  const gone = new Map<string, StackPr>();
  for (const p of prs) if (p.state !== "OPEN" && p.headRefName && !p.isCrossRepository && p.number > (gone.get(p.headRefName)?.number ?? 0)) gone.set(p.headRefName, p);
  const find: Finder = (b) => heads.get(b) ?? gone.get(b) ?? lookups.get(b);
  return { nodes, heads, find };
}

/** What is known of the pull request that came from a branch: undefined = not asked, null = none ever. */
type Finder = (branch: string) => StackPr | null | undefined;

/**
 * Walk from a pull request toward the trunk through bases that are gone.
 *
 * A merged base whose branch was kept leaves the pull request on top of it
 * pointing at a branch no open pull request comes from. The merged one still
 * knows its own base (the lookup carries it), so the walk takes that hop and
 * attaches to the open ancestor; the merged one is remembered as a box, never
 * as a tier.
 */
function edgeOf(p: StackPr, find: Finder): Edge {
  const gone: Edge["gone"] = [];
  const seen = new Set<string>();
  let b = p.baseRefName;
  for (let i = 0; i < MAX_WALK; i++) {
    if (!b || isTrunkBranch(b)) return { parent: null, gone, stop: "trunk" };
    if (seen.has(b)) return { parent: null, gone, stop: "loop" };
    seen.add(b);
    const hit = find(b);
    if (hit === undefined) return { parent: null, gone, stop: "pending", branch: b };
    if (hit === null) return { parent: null, gone, stop: "missing", branch: b };
    if (hit.state === "OPEN") return hit.number === p.number ? { parent: null, gone, stop: "loop" } : { parent: hit, gone, stop: "trunk" };
    gone.push({ kind: hit.state === "MERGED" ? "merged" : "closed", number: hit.number, branch: b });
    b = hit.baseRefName;
  }
  return { parent: null, gone, stop: "loop" };
}

/** The base of one pull request, as the token names it. */
function baseOf(p: StackPr, find: Finder): BaseRef | null {
  const b = p.baseRefName;
  if (!b || isTrunkBranch(b)) return null;
  const hit = find(b);
  if (hit === undefined) return { kind: "pending", branch: b };
  if (hit === null) return { kind: "missing", branch: b };
  if (hit.state === "MERGED") return { kind: "merged", number: hit.number, branch: b };
  if (hit.state === "CLOSED") return { kind: "closed", number: hit.number, branch: b };
  return { kind: "pr", number: hit.number, branch: b, draft: !!hit.isDraft };
}

/**
 * The stack a pull request is in, or null when it is on its own.
 *
 * `prs` is the list as the board holds it; `lookups` is what was found for the
 * branches that are not in it (`null` = asked, nobody ever opened one);
 * `shown` says whether a number is on the board right now.
 */
export function stackOf(
  n: number, prs: readonly StackPr[], lookups: Lookups = new Map(), shown: (n: number) => boolean = () => true,
): Stack | null {
  const { nodes, find } = universe(prs, lookups);
  const me = nodes.find((p) => p.number === n);
  if (!me) return null;
  const edges = new Map<number, Edge>(nodes.map((p) => [p.number, edgeOf(p, find)]));
  const own = edges.get(n)!;

  /* The component: up to the root, then everything that hangs from it. */
  let root = me;
  const climbed = new Set([me.number]);
  for (;;) {
    const up = edges.get(root.number)!.parent;
    if (!up) break;
    /* A loop (A on B, B on A) or a chain longer than anyone stacks: no number
       is better than a wrong one. */
    if (climbed.has(up.number) || climbed.size > MAX_TIERS) return null;
    climbed.add(up.number);
    root = up;
  }
  const depth = new Map<number, number>([[root.number, 0]]);
  const tiers: StackPr[][] = [[root]];
  for (let d = 0; d < MAX_TIERS; d++) {
    const row: StackPr[] = [];
    for (const k of nodes) {
      const up = edges.get(k.number)!.parent;
      if (up && depth.get(up.number) === d && !depth.has(k.number)) { depth.set(k.number, d + 1); row.push(k); }
    }
    if (!row.length) break;
    tiers.push(row.sort((a, b) => a.number - b.number));
  }

  if (tiers.length >= MAX_TIERS) return null;
  const rootEdge = edges.get(root.number)!;
  const bottom: Box | null = rootEdge.gone.length
    ? { kind: rootEdge.gone[0].kind, label: "", number: rootEdge.gone[0].number }
    : rootEdge.stop === "missing" ? { kind: "missing", label: "?" }
    : rootEdge.stop === "pending" && tiers.length > 1 ? { kind: "off", label: "…" }
    : null;
  if (tiers.length === 1 && tiers[0].length === 1 && !bottom) return null;

  /* Open ones only are numbered; a base that is gone is a box of its own. */
  const letterOf = (i: number, of: number) => (of > 1 ? String.fromCharCode(97 + i) : "");
  const grid: Box[][] = [];
  if (bottom) grid.push([bottom]);
  let position = 0; let letter: string | null = null; let siblings: number[] = [];
  tiers.forEach((t, ti) => {
    if (ti > 0) {
      /* A merged one between this tier and the one under it, on any edge. */
      const g = t.map((k) => edges.get(k.number)!.gone[0]).find(Boolean);
      if (g) grid.push([{ kind: g.kind, label: "", number: g.number }]);
    }
    grid.push(t.map((k, i) => ({
      kind: k.number === n ? "cur" : shown(k.number) ? "oth" : "off",
      label: `${ti + 1}${letterOf(i, t.length)}`, number: k.number,
    } as Box)));
    const i = t.findIndex((k) => k.number === n);
    if (i >= 0) {
      position = ti + 1;
      if (t.length > 1) { letter = letterOf(i, t.length); siblings = t.filter((k) => k.number !== n).map((k) => k.number); }
    }
  });
  if (!position) return null;

  const items: SpineItem[] = grid.map((t) => (t.length > 1 ? { t: "fork", boxes: t } : { t: "box", box: t[0] }));
  const at = grid.findIndex((t) => t.some((b) => b.kind === "cur"));
  const brokenBy = own.gone[0]?.kind ?? (own.stop === "missing" ? "missing" : null);
  return {
    position, size: tiers.length, letter, siblings,
    base: baseOf(me, find),
    next: nodes.filter((k) => edges.get(k.number)!.parent?.number === n).map((k) => k.number).sort((a, b) => a - b),
    trunk: rootEdge.stop === "trunk" && !rootEdge.gone.length && isTrunkBranch(root.baseRefName) ? root.baseRefName : null,
    broken: brokenBy,
    spine: items.length >= COLLAPSE_FROM ? collapse(items, at) : items,
    tiers: grid,
  };
}

/**
 * The first, the last and the three around the current one are drawn; each run
 * in between is a count. Seven or more only, so a short stack never hides a
 * box it has room for.
 */
export function collapse(items: SpineItem[], cur: number): SpineItem[] {
  const keep = new Set([0, items.length - 1, cur - 1, cur, cur + 1]);
  const out: SpineItem[] = [];
  let hidden = 0;
  items.forEach((it, i) => {
    if (keep.has(i)) {
      if (hidden) { out.push({ t: "gap", hidden }); hidden = 0; }
      out.push(it);
    } else hidden++;
  });
  if (hidden) out.push({ t: "gap", hidden });
  return out;
}

/**
 * The branches this list still has to ask about: a base that is not trunk, not
 * the head of an open pull request in the list, and not answered yet. Follows
 * the answers it already has, so a merged base found one request ago brings
 * its own base into the next round.
 */
export function needsLookup(prs: readonly StackPr[], lookups: Lookups): string[] {
  const { nodes, find } = universe(prs, lookups);
  const want = new Set<string>();
  for (const p of nodes) { const e = edgeOf(p, find); if (e.stop === "pending" && e.branch) want.add(e.branch); }
  return [...want];
}
