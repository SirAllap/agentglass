// `agentglass-agent can <worker> "<command>"`: the answer before the worker tries.
//
// It asks the same questions the lock and the gate ask, in the order they ask
// them, and names the layer that answers. Pure: the caller hands it what it
// read (the worker's envelope, the closed commands, the rules' verdict), so the
// tests need no server.
import { DENIED_COMMANDS, SWITCHABLE_COMMANDS, workerRole } from "../../../shared/workerRoles.ts";
import type { Envelope } from "../../../shared/orchestration.ts";
import { refusal, type RefusalLayer } from "../../../shared/refusal.ts";
import { LIFTS, WORKER_DENIED, deniedFor } from "./envelope.ts";
import { oldFloorNote, runsPersonHooks } from "./hooks.ts";

export interface CanAnswer { answer: "allowed" | "refused" | "ask"; layer?: RefusalLayer; rule?: string; text: string }

/** Whether a project switch or a flag, not the engine's old floor, is what denies this command. */
const closedOrFlag = (lock: string, o: { closed?: readonly string[]; envelope: Envelope }): boolean =>
  (o.closed ?? []).includes(lock) || o.envelope.deny.includes(lock);

const starts = (command: string, prefix: string): boolean => command === prefix || command.startsWith(`${prefix} `);

export function canRun(command: string, o: {
  envelope: Envelope;
  closed?: readonly string[];
  /** The app doors the project opened to workers (`workers.appDoors.*`) and the worker's role id: both change what the lock denies. */
  opened?: readonly string[];
  role?: string;
  /** The engine the worker runs on, and the commands its project opened on purpose: an engine that skips the person's hooks keeps the old floor. */
  engine?: string;
  legacyOpen?: readonly string[];
  /** The agent rules' verdict for this command (`agentRulesStore.check`). */
  rules: { decision: "allow" | "ask" | "never" | "unknown"; reason?: string };
}): CanAnswer {
  const c = command.trim().replace(/\s+/g, " ");
  const floor = DENIED_COMMANDS.find((p) => starts(c, p));
  if (floor) return { answer: "refused", layer: "floor", rule: floor, text: refusal("floor", floor) };
  const groups: [boolean, readonly string[], string][] = [
    [!!o.envelope.commit, LIFTS.commit, "commit"], [!!o.envelope.docker, LIFTS.docker, "docker"], [!!o.envelope.worktreeOps, LIFTS.worktree, "worktreeOps"],
  ];
  for (const [on, list, flag] of groups) {
    const hit = list.find((p) => starts(c, p));
    if (hit && !on) return { answer: "refused", layer: "envelope", rule: `${flag} is off for this worker`, text: refusal("envelope", `${flag} is off for this worker (${hit})`) };
  }
  const closed = (o.closed ?? []).find((p) => SWITCHABLE_COMMANDS.includes(p) && starts(c, p));
  if (closed) return { answer: "refused", layer: "envelope", rule: `workers.commands.${closed} is closed in this project`, text: refusal("envelope", `workers.commands.${closed} is closed in this project`) };
  // Whatever the real lock denies and the checks above did not name: the envelope's own `deny` and the app doors a project has not opened. One source, so `can` never says allowed to what the lock refuses.
  const lock = deniedFor(o.envelope, o.role ? workerRole(o.role) : undefined, o.opened ?? [], false, o.closed ?? [], o.engine && !runsPersonHooks(o.engine) ? (o.legacyOpen ?? []) : undefined).find((p) => starts(c, p));
  if (lock) {
    const door = (WORKER_DENIED as readonly string[]).includes(lock);
    const note = o.engine ? oldFloorNote(o.engine) : null;
    const rule = door ? `${lock} is a closed app door (workers.appDoors.*)` : note && !closedOrFlag(lock, o) ? `${lock} stays denied: ${note}` : `${lock} is in this worker's deny list`;
    return { answer: "refused", layer: "envelope", rule, text: refusal("envelope", rule) };
  }
  if (o.rules.decision === "never") return { answer: "refused", layer: "rule", rule: o.rules.reason ?? "never", text: refusal("rule", o.rules.reason ?? "an agent rule says never") };
  if (o.rules.decision === "ask") return { answer: "ask", layer: "rule", rule: o.rules.reason ?? "ask", text: `asks first: ${o.rules.reason ?? "an agent rule says ask"}` };
  if (!o.envelope.network && /^(curl|wget)( |$)/.test(c)) return { answer: "allowed", layer: "sandbox", text: "allowed by the lock, but the sandbox has no open network: only the domains it lists answer" };
  return { answer: "allowed", text: "allowed" };
}
