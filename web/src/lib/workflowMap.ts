/*
 * The workflow map's decisions, away from the screen.
 *
 * A step is a place in agentglass (a button on a pull request, an item in the
 * review menu, a choice in the merge dialog…) tied to a status of the user's own.
 * Nothing here knows which tracker it is talking to: the words come from the
 * adapter's nouns, the statuses from whatever the tracker's own list of spaces
 * (projects, for another tracker) carries, and which steps exist from the
 * adapter's `kinds`. A second tracker is a second adapter, not a change here.
 *
 * Statuses are compared without regard to case, because the tracker folds the
 * case of a status it shows and a name typed in an older setting should still
 * land on it.
 */

export type StepKind = "move" | "menu" | "merge" | "people" | "note";

/** The order steps are listed in, and the order the composer offers them. */
export const STEP_ORDER: readonly StepKind[] = ["move", "menu", "merge", "people", "note"];

export type Unassign = "none" | "me" | "all";
export const UNASSIGN_LABEL: Record<Unassign, string> = { none: "nobody", me: "only me", all: "everyone" };

export interface MapStatus { status: string; type: string; color?: string }
/**
 * The unit that owns a set of statuses: a list (or a board, or a project).
 * ClickUp hands them out by space and the data layer narrows them to the ones
 * the person counts; the map only sees the units it is given.
 */
export interface MapSpace {
  id: string;
  name: string;
  /** The folder (or group) it sits in, said under its name. */
  group?: string;
  statuses: MapStatus[];
  /** False for an ignored unit: kept and listed, out of the pickers and the coverage. Absent counts. */
  counted?: boolean;
  /** A list whose set is only the statuses its cards wear (see shared/statusSpaces.ts). */
  fromList?: boolean;
  /** For a list place, the space it sits in; counting follows the space. */
  spaceId?: string;
  /** How many of the person's cards sit here, when the cards are known. */
  cards?: number;
}

/** The spaces that count, and the ignored ones the page lists under "Ignored". */
export function splitSpaces(spaces: readonly MapSpace[]): { yours: MapSpace[]; other: MapSpace[] } {
  return { yours: spaces.filter((s) => s.counted !== false), other: spaces.filter((s) => s.counted === false) };
}

/** The ids of the real spaces that count (a list place follows its space and has no id of its own to keep). */
export const countedIds = (spaces: readonly MapSpace[]): string[] => spaces.filter((s) => !s.fromList && s.counted !== false).map((s) => s.id);

/**
 * The list to save after ignoring or counting one space. Null when it would leave
 * nothing counted: with no space counted there is no status to pick, and an empty
 * saved list means "the default" and would silently undo the press.
 */
export function withCounted(spaces: readonly MapSpace[], id: string, on: boolean): string[] | null {
  const now = countedIds(spaces);
  const next = on ? (now.includes(id) ? now : [...now, id]) : now.filter((x) => x !== id);
  return next.length ? next : null;
}

/** The words a tracker uses for the same things. */
export interface Nouns {
  name: string;
  /** What the account is scoped to: workspace, site. */
  workspace: string;
  space: string;
  spaces: string;
  /** The unit a status set belongs to, as the map says it: "list" / "board" / "project". */
  list: string;
  lists: string;
  item: string;
  items: string;
  /** The label of a button that moves an item: "Move to" / "Transition to". */
  move: string;
  /** The verb, capitalised: "Move" / "Transition". */
  verb: string;
}

export interface TrackerAdapter {
  nouns: Nouns;
  /** The steps this tracker can have. A tracker without a merge-time choice leaves it out. */
  kinds: readonly StepKind[];
  /** The status a role is most likely to mean, by the words in its name. */
  suggest: Partial<Record<StepKind, RegExp>>;
  /**
   * What the app does when a step is on and names no status: the setting from before steps
   * were pickable. The map shows it as the step's status, flagged implicit, so it says what
   * actually runs instead of "needs a status" about a button that is on screen.
   */
  fallback?: Partial<Record<StepKind, (all: Listed[]) => string | null>>;
  /** An invented item the previews are drawn with, so a preview never shows somebody's real one. */
  sample: { id: string; title: string; status: string; who: string; others: string };
}

/** A step as the map draws it. */
export interface Step {
  kind: StepKind;
  /** The status it points at; null until one is picked (or, for the merge choice, "Leave it there"). */
  status: string | null;
  /** Further names the setting also tries when the first is absent from a list. */
  also: string[];
  unassign: Unassign;
  /** Who the step also makes sure is on the item. Only the steps that move a status have the row. */
  assign: { who: "none" | "me" | "author" | "person"; person?: { id: number; name: string } };
  /** The status shown is the built-in default, not one the person chose. */
  implicit?: boolean;
}

export interface Moment {
  title: string;
  /** Needs a status to do anything. */
  needs: boolean;
  /** The status is optional: no status is a real answer ("Leave it there"). */
  optional: boolean;
  blurb: string;
  /** Where it shows, for the line under the preview. */
  shows: string;
}

export function moments(n: Nouns): Record<StepKind, Moment> {
  return {
    move: { title: `${n.verb} button on a pull request`, needs: true, optional: false, blurb: `A button in the pull request’s ${n.item} block that moves the ${n.item}.`, shows: `pull request › ${n.item} block` },
    menu: { title: `${n.verb} item in the review menu`, needs: true, optional: false, blurb: `An item in the review menu that moves the ${n.item}.`, shows: "pull request › review menu" },
    merge: { title: `${n.verb} option in the merge dialog`, needs: true, optional: true, blurb: "A choice at merge time. With no status it reads “Leave it there”.", shows: "pull request › merge dialog" },
    people: { title: "Assigned list in the review menu", needs: false, optional: false, blurb: `The ${n.item}’s members, to put on or take off.`, shows: "pull request › review menu" },
    note: { title: "Note button on a pull request", needs: false, optional: false, blurb: `Writes a comment on the ${n.item}.`, shows: `pull request › ${n.item} block, and the ${n.item}` },
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A step that needs a status and has none: it does nothing yet, and the map says so. */
export const needsStatus = (s: Step, m: Moment): boolean => m.needs && !m.optional && !s.status;

/** A step does something once it has what it needs. */
export const isActive = (s: Step, m: Moment): boolean => !m.needs || m.optional || !!s.status;

export interface Listed { name: string; type: string; color?: string; in: string[] }

/** Every distinct status across the spaces, in the order first met, and where each lives. */
export function allStatuses(spaces: readonly MapSpace[]): Listed[] {
  const out: Listed[] = [];
  for (const sp of spaces) {
    for (const st of sp.statuses) {
      const hit = out.find((x) => same(x.name, st.status));
      if (hit) { if (!hit.in.includes(sp.name)) hit.in.push(sp.name); }
      else out.push({ name: st.status, type: st.type, ...(st.color ? { color: st.color } : {}), in: [sp.name] });
    }
  }
  return out;
}

export interface Coverage { has: string[]; missing: string[]; all: boolean }

/** Which spaces have this status and which do not: a button is absent in the ones that do not. */
export function coverage(spaces: readonly MapSpace[], status: string): Coverage {
  const has = spaces.filter((s) => s.statuses.some((x) => same(x.status, status))).map((s) => s.name);
  const missing = spaces.filter((s) => !s.statuses.some((x) => same(x.status, status))).map((s) => s.name);
  return { has, missing, all: spaces.length > 0 && missing.length === 0 };
}

/** The short form of a status's reach, for a picker row: "all 3 spaces", "only Support", "2 of 7 spaces". */
export function reach(spaces: readonly MapSpace[], status: string, spacesWord: string): { text: string; partial: boolean } {
  const c = coverage(spaces, status);
  if (c.all) return { text: `all ${spaces.length} ${spacesWord}`, partial: false };
  if (c.has.length <= 2) return { text: `${c.has.length === 1 ? "only " : ""}${c.has.join(", ")}`, partial: true };
  return { text: `${c.has.length} of ${spaces.length} ${spacesWord}`, partial: true };
}

/** The picker's rows for a query: statuses whose name contains it, case aside. */
export function filterStatuses(all: readonly Listed[], q: string): Listed[] {
  const needle = q.trim().toLowerCase();
  return needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : [...all];
}

/**
 * The status the app would propose for a role, from the words in the name. A
 * status that finishes the item is never the proposal for "in review", and the
 * merge choice is the opposite: it looks only at the ones that finish it.
 */
export function suggestStatus(adapter: TrackerAdapter, kind: StepKind, all: readonly Listed[]): string | null {
  const re = adapter.suggest[kind];
  if (!re) return null;
  const pool = kind === "merge" ? all.filter((s) => s.type === "done" || s.type === "closed") : all.filter((s) => s.type !== "done" && s.type !== "closed");
  return pool.find((s) => re.test(s.name))?.name ?? null;
}

/** Fill an on-but-unnamed step with the status the app falls back to, so the map and the app agree. */
export function resolveImplicit(adapter: TrackerAdapter, steps: readonly Step[], all: readonly Listed[]): Step[] {
  return steps.map((s) => {
    if (s.status || !s.implicit) return s;
    const hit = adapter.fallback?.[s.kind]?.([...all]) ?? null;
    return hit ? { ...s, status: hit } : s;
  });
}

/** What a step reads as in the coverage line, as data the screen turns into words. */
export type Reach =
  | { kind: "everywhere" }
  | { kind: "none-needed" }
  | { kind: "pending" }
  | { kind: "all"; count: number }
  | { kind: "some"; has: string[]; missing: string[]; total: number }
  /** The status exists, but only in spaces the person ignores: the step is shown, not silently broken. */
  | { kind: "ignored"; where: string[] };

export function reachOf(spaces: readonly MapSpace[], s: Step, m: Moment, ignored: readonly MapSpace[] = []): Reach {
  if (!m.needs) return { kind: "everywhere" };
  if (!s.status) return m.optional ? { kind: "none-needed" } : { kind: "pending" };
  const c = coverage(spaces, s.status);
  if (c.has.length === 0) {
    const where = coverage(ignored.filter((x) => !x.fromList), s.status).has;
    if (where.length) return { kind: "ignored", where };
  }
  return c.all ? { kind: "all", count: spaces.length } : { kind: "some", has: c.has, missing: c.missing, total: spaces.length };
}

/** Which steps a user could still add. */
export const addable = (adapter: TrackerAdapter, steps: readonly Step[]): StepKind[] =>
  STEP_ORDER.filter((k) => adapter.kinds.includes(k) && !steps.some((s) => s.kind === k));

/** Pins on a status row of the chosen space: the steps that point at it. */
export const pinsOn = (steps: readonly Step[], status: string): StepKind[] =>
  steps.filter((s) => s.status && same(s.status, status)).map((s) => s.kind);
