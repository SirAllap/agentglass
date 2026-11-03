// Runs the steps of a plan against the systems that own them.
//
// The plan (prHandOver.ts) says what to send; the result (prApplyResult.ts)
// says what the picker shows. This is the part between: every system in the
// set runs at once, a system's runner reports the outcome of each of ITS steps,
// and each report is handed on the moment it lands, so GitHub can turn green
// while the card is still working. A runner that throws is a failure, never a
// stuck spinner.
//
// A retry calls this again with only the failed ids. A step that passed is not
// in the set, so it is not sent twice.
import type { Step, StepId, System } from "./prHandOver.ts";
import type { Outcome, Outcomes } from "./prApplyResult.ts";

/** Sends the steps it is given (all of one system's) and answers per step. */
export type Runner = (steps: Step[]) => Promise<Outcomes>;

const FAIL: Outcome = { state: "fail" };

export async function runSteps(
  steps: readonly Step[], ids: readonly StepId[],
  runners: Partial<Record<System, Runner>>, onOutcomes: (o: Outcomes) => void,
): Promise<void> {
  const mine = steps.filter((s) => ids.includes(s.id));
  const bySystem = new Map<System, Step[]>();
  for (const s of mine) bySystem.set(s.system, [...(bySystem.get(s.system) ?? []), s]);
  await Promise.all([...bySystem].map(async ([system, group]) => {
    let got: Outcomes;
    try {
      const run = runners[system];
      got = run ? await run(group) : {};
    } catch { got = {}; }
    const filled: Outcomes = {};
    /* A step the runner did not answer for did not pass. */
    for (const s of group) filled[s.id] = got[s.id] ?? FAIL;
    onOutcomes(filled);
  }));
}
