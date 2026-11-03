/*
 * Should this launch show the first run?
 *
 * One pure rule over the facts the server sends once at launch and the one key
 * the browser keeps. A stored answer is the person's word in both directions;
 * the machine's own facts answer only while nothing was stored, which is what
 * keeps an upgrade (a project already open) out of a first-run screen.
 *
 * A read that failed is not a reason to show a wizard: `null` hides it.
 */
import type { SetupState } from "../../../shared/types.ts";

export interface SetupFacts {
  /** null: nobody ever wrote it. */
  setupDone: boolean | null;
  /** A run was left open, so a reload resumes it whatever the machine has. */
  setupInProgress: boolean;
  projectOpen: boolean;
  sessionsSeen: boolean;
  hooksInstalled: boolean;
  /** The old picker's key: this browser answered the first-run question. */
  pickerAnswered: boolean;
}

/** The server's answer and the browser's key, as the rule reads them. */
export function factsOf(state: SetupState, pickerAnswered: boolean): SetupFacts {
  return {
    setupDone: state.setupDone,
    setupInProgress: state.setupInProgress,
    projectOpen: state.projectOpen,
    sessionsSeen: state.sessionsSeen,
    hooksInstalled: state.hooksInstalled,
    pickerAnswered,
  };
}

export function showSetup(facts: SetupFacts | null): boolean {
  if (!facts) return false;
  if (facts.setupDone === false) return true;
  if (facts.setupDone === true) return false;
  if (facts.setupInProgress) return true;
  return !(facts.projectOpen || facts.sessionsSeen || facts.hooksInstalled || facts.pickerAnswered);
}
