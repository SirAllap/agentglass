/*
 * MANY PROJECTS AT ONCE. The decisions the Flight plan view makes when more than
 * one project is in scope: which projects, which one Settings opens on, how
 * the Preflight moments are read and written, and what the Settings link's line
 * says about the scope on screen. Pure, so the tests can pin them.
 */
import { projectName } from "./flightPlan.ts";

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

/** Where both switches live, named once so the line and its tip send a person to the same place. */
export const FLIGHT_PLAN_SETTINGS = "Flight plan \u203a Settings";

/** The sentence every tip starts with: what the feature is for. */
const WHAT = "Flight plan: a fresh reviewer reads plans before Launch.";

/** The two switches the line is about, as the scope on screen reads them. */
export interface SwitchRead {
  /** `flightPlan.enabled`, the app's own switch: null until read. */
  master: boolean | null;
  /** `flightPlan.project.enabled` for the project on screen; null for All projects, or until read. */
  project: boolean | null;
  /** The project on screen; "" is All projects. */
  root: string;
}

/** What Settings ▸ Orchestration's Flight plan line says, and the tip that explains it. */
export interface SwitchLine { word: "On" | "Off" | ""; tip: string }

/**
 * The line reads what the project on screen actually allows, which is two
 * switches and not one: the app's, and the project's. A start refused with
 * "this project is out of Flight plan" under a line that said On is what this
 * answers. Off names the switch that is off, and where to turn it on.
 *
 * A read that failed says nothing rather than claiming On: an unread project
 * switch may be off.
 */
export function flightPlanLine(s: SwitchRead): SwitchLine {
  const name = projectName(s.root);
  if (s.master === null) return { word: "", tip: WHAT };
  if (!s.master) return { word: "Off", tip: `Flight plan is off in every project: the app's own switch is off. Turn it on in ${FLIGHT_PLAN_SETTINGS}, under Use Flight plan.` };
  if (!s.root) return { word: "On", tip: `${WHAT} The app's own switch is on; each project still has its own switch, under Projects, and a project with it off refuses a start.` };
  if (s.project === null) return { word: "", tip: `${WHAT} This project's own switch was not read.` };
  if (!s.project) return { word: "Off", tip: `Flight plan is off in ${name}: this project's own switch is off. Turn it on in ${FLIGHT_PLAN_SETTINGS}, on its row under Projects.` };
  return { word: "On", tip: `${WHAT} On in ${name}.` };
}
