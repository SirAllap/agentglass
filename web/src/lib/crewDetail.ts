// What a Crew card's detail view says, and the reminder its right-click writes.
// Decided apart from the screen so the rows and the task line are testable.
import type { LanternRow } from "../components/LanternView.tsx";
import { CREW_WORD, ageWord, baseName, doingOf, type CrewState } from "./starboardCrew.ts";
import { fmtUsd } from "./format.ts";

export interface DetailRow { label: string; value: string }

/** The rows of the detail view: only what the board knows, nothing guessed. */
export function crewDetailRows(r: LanternRow, state: CrewState, since: number, now: number): DetailRow[] {
  const age = ageWord(since, now);
  const out: DetailRow[] = [
    { label: "State", value: CREW_WORD[state] },
    { label: "Doing", value: doingOf(r, state, age) },
  ];
  const where = r.project ?? r.worktree;
  if (where) out.push({ label: "Project", value: baseName(where) });
  if (r.branch) out.push({ label: "Branch", value: r.branch });
  if (r.facts?.model) out.push({ label: "Model", value: r.facts.model });
  const f = r.facts;
  if (f) out.push({ label: "Activity", value: `${f.tools} tools · ${f.errors} errors · ~${fmtUsd(f.cost)}` });
  return out;
}

/** The Taskwarrior line for "remind me to look at this session". Taskwarrior reads `+tag`, `key:value` and `/` in free text as syntax, so the name is cleaned first. */
export function crewReminderInput(r: LanternRow): string {
  const name = r.name.replace(/[+:/\\"']/g, " ").replace(/\s+/g, " ").trim() || "session";
  return `Check on ${name} +crew`;
}

/** Where the reminder request stands. Only a request in flight or a task already added blocks the button; a failure leaves it free to retry. */
export type RemindPhase = "idle" | "busy" | "done";
export const remindDisabled = (p: RemindPhase): boolean => p !== "idle";
