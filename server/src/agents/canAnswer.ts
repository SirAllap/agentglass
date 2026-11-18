/*
 * The one answer to "may a worker run this command here": the push-to-main
 * rule, then canRun with the project's closed switches, open doors and the
 * agent-rules verdict. `agentglass-agent can` and the Permissions page's
 * "Check a command" both come through here, so there is no second copy.
 */
import type { Envelope } from "../../../shared/orchestration.ts";
import { canRun } from "./can.ts";
import { check as rulesCheck } from "../agentRulesStore.ts";
import { pushLandsOnProtected } from "../pushLanding.ts";
import * as PreflightStore from "../preflightStore.ts";

export function canAnswer(root: string, cmd: string, who: { envelope: Envelope; role?: string; engine?: string }): ReturnType<typeof canRun> | { answer: "refused"; layer: "rule"; rule: string; text: string } {
  const verdict = rulesCheck(root, "Bash", { command: cmd });
  const lands = pushLandsOnProtected(cmd, root);
  if (lands) return { answer: "refused", layer: "rule", rule: "push lands on main/master", text: lands };
  return canRun(cmd, {
    envelope: who.envelope, closed: PreflightStore.workerClosedCommands(root), opened: PreflightStore.workerOpenDoors(root),
    role: who.role, engine: who.engine, legacyOpen: PreflightStore.workerLegacyOpened(root), rules: verdict,
  });
}
