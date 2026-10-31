/*
 * MANY PROJECTS AT ONCE. The decisions the Flight plan view makes when more than
 * one project is in scope: which projects, which one Settings opens on, and how
 * the Preflight moments are read and written. Pure, so the tests can pin them.
 */

/** Every project the view speaks of, each once, in the order given: the one the person is in, the open ones, then those that only have plans. */
export const projectRoots = (...lists: string[][]): string[] => [...new Set(lists.flat().filter(Boolean))];

/** The project Settings opens on: the one with the most plans waiting on the person, else the first. A choice that left the scope is dropped. */
export function pickProject(roots: string[], waiting: Record<string, number>, chosen: string | null): string {
  if (chosen && roots.includes(chosen)) return chosen;
  let best = roots[0] ?? "";
  for (const r of roots) if ((waiting[r] ?? 0) > (waiting[best] ?? 0)) best = r;
  return best;
}

/** A Preflight moment as the Settings door stores it (`flightPlan.preflight.reviews` holds any of these) and as the person reads it. */
export const MOMENTS = [["plan", "Launch"], ["taskDone", "Task done"], ["pr", "PR"]] as const;
export type Moment = (typeof MOMENTS)[number][0];

/** What a project's `reviews` value holds; anything that is not a known moment is not one. */
export const momentsOf = (v: unknown): Moment[] => (Array.isArray(v) ? MOMENTS.map(([k]) => k).filter((k) => v.includes(k)) : []);

/** The list to store after one moment is flipped, in the order the moments are drawn. */
export const flipMoment = (now: Moment[], m: Moment): Moment[] => MOMENTS.map(([k]) => k).filter((k) => (k === m ? !now.includes(k) : now.includes(k)));

/** One line for the table: where Preflight looks in this project, or that it does not. */
export const momentsLine = (on: Moment[]): string => (on.length ? MOMENTS.filter(([k]) => on.includes(k)).map(([, w]) => w).join(" · ") : "Preflight off");

/** What the Projects card's pill says: the master switch, then how many of the projects in scope are left in. */
export function pillWording(masterOn: boolean, on: number, total: number): string {
  if (!masterOn || on === 0) return "Off in every project";
  return on === total ? "On in every project" : `On in ${on} of ${total} projects`;
}
