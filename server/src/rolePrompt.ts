/*
 * A flow role's prompt, from the project's saved flow, as the opening of a
 * worker's brief. Lives apart from flightPlan.ts so the start paths can use it
 * without importing the whole Flight plan engine.
 */
import { readStoredFlow } from "./config.ts";
import { FLOW_PROMPT_MAX, chainOf, roleById } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { owesResult, workerRole } from "../../shared/workerRoles.ts";
import type { Chain, Envelope } from "../../shared/orchestration.ts";
import type { FlowRole } from "../../shared/flow.ts";
import type { BrowserAskContext } from "../../shared/browserWorkers.ts";
import { readFlow } from "./flow.ts";
import { readPolicy } from "./orchestration.ts";
import { allowWithin } from "./agents/envelope.ts";
import { plannerMayWrite } from "./preflightStore.ts";

/**
 * The last line of a headless worker's brief, for the roles whose answer is
 * the point of them: a turn keeps one message — its last — and that message is
 * the result the card and the plan read. Idempotent because a retried turn
 * hands the same prompt again.
 */
export const RESULT_CONTRACT = "The last message of this turn is the only thing kept of it, and it is the result: before you finish, write it there — what changed and what you ran, or the verdict line this role owes. A turn that ends without one has left no result at all.";

/** A built-in role that owes a result, or a flow role that runs as one of them. */
export function roleOwesResult(root: string, role: unknown): boolean {
  if (owesResult(role)) return true;
  const policy = flowRoleInForce(root, role)?.policyRole;
  return !!policy && owesResult(policy);
}

/** Append the result contract to a headless turn's brief, when the role owes one. */
export function withResultContract(text: string, root: string, role: unknown): string {
  const typed = text.trim();
  if (typed.includes(RESULT_CONTRACT) || !roleOwesResult(root, role)) return text;
  return typed ? `${typed}\n\n${RESULT_CONTRACT}` : RESULT_CONTRACT;
}

/** What a flow role's brief says about the Agent tool when its own switch
 *  ("May start subagents (Agent tool)", the role block in Flow) is off: the
 *  CLI refuses the tool by its name alone, which does not say why or what to
 *  do about it. Named so a team skill that spawns reviewer subagents
 *  (/adversarial-review) is answered instead of retried blind. */
export const SUBAGENTS_OFF_NOTE = "You cannot start subagents: the Agent tool is off for this role. If a skill needs one, ask the person to turn on this role's \"May start subagents (Agent tool)\" switch in Flow — turning it on waits for their one-click approval, so ask rather than retry.";

/** Append `SUBAGENTS_OFF_NOTE` to a flow role's brief when its own lock keeps
 *  the Agent tool closed: never for a built-in role run plainly (the switch
 *  only ever exists on a flow role), and never twice over on a resume. */
export function withSubagentsNote(text: string, root: string, role: unknown): string {
  const lock = roleLockFor(root, role);
  if (!lock || lock.mayStartSubagents) return text;
  const typed = text.trim();
  if (typed.includes(SUBAGENTS_OFF_NOTE)) return text;
  return typed ? `${typed}\n\n${SUBAGENTS_OFF_NOTE}` : SUBAGENTS_OFF_NOTE;
}

/**
 * The sentence a custom flow role with no base (`policyRole`) gets: that
 * absence is what silently closes its browser door (`DOORS_FOR_ROLE` in
 * `agents/envelope.ts` keys off `role.base ?? role.id`, and a custom role's
 * `base` is only ever set from `policyRole`). Null for a built-in role, a
 * person's step, or a custom role that does name one.
 */
export function noBaseNoteFor(root: string, roleId: unknown): string | null {
  if (workerRole(roleId)) return null;
  const f = flowRoleInForce(root, roleId);
  if (!f || f.actor === "person" || f.policyRole) return null;
  return `"${f.name}" has no base role: no browser. Set one in Settings ▸ Flow ▸ ${f.name} ▸ Works like.`;
}

/** Append `noBaseNoteFor`'s sentence to a flow role's brief, idempotent like
 *  the other notes in this file. */
export function withNoBaseNote(text: string, root: string, roleId: unknown): string {
  const note = noBaseNoteFor(root, roleId);
  if (!note) return text;
  const typed = text.trim();
  if (typed.includes(note)) return text;
  return typed ? `${note}\n\n${typed}` : note;
}

/** Where a scout's plan is saved for it, relative to its checkout. */
export const PLAN_FILE = ".agx-tmp/plan.md";

/**
 * The line a scout's brief carries: it cannot save its plan itself.
 *
 * A scout runs read-only — the lock closes its edit tools and an envelope that
 * writes nothing closes the rest of them — so the plan used to exist only in
 * the turn's last message. The app writes that message to PLAN_FILE when the
 * turn ends (agents/planout.ts), so the brief says where the plan lands and
 * that the message IS the plan.
 */
export const PLAN_NOTE = `You cannot write files in this turn, and nothing you do saves one: your plan is taken from your last message and saved to ${PLAN_FILE} in this checkout, and sent to the orchestrator. So write the plan as that last message, and do not call a tool to save it.`;

/** Whether this role plans for the orchestrator: the built-in scout, or a flow
 *  role that runs as one. Its last message is then kept as a plan
 *  (agents/planout.ts), whether or not it could have saved one itself. */
export function rolePlans(root: string, role: unknown): boolean {
  return role === "scout" || flowRoleInForce(root, role)?.policyRole === "scout";
}

/**
 * Whether this role really runs read-only, which is the fact PLAN_NOTE states:
 * the built-in scout does unless this project's `workers.plannerWrite`
 * (Settings ▸ Orchestration) turned that off — the same flag `roleFor`
 * (agents/policystart.ts) reads to build the role the sandbox and the lock
 * actually run under, so the line never says more than the real envelope
 * does. A flow role is read-only when its own `readsOnly` says so, and any
 * role under an envelope that writes nothing (`write: "none"`) is read-only
 * too, which `agents/headless.ts` and `agents/envelope.ts` also treat as
 * read-only. A flow role that only runs *as* a scout still writes, so
 * `rolePlans` is not enough.
 */
function cannotWrite(root: string, role: unknown, envelope?: Envelope): boolean {
  if (role === "scout") return !plannerMayWrite(root) || envelope?.write === "none";
  return flowRoleFor(root, role)?.readsOnly === true || envelope?.write === "none";
}

/** Append the plan note to a scout's brief, when the note is true of it.
 *  Idempotent, like the result contract. */
export function withPlanNote(text: string, root: string, role: unknown, envelope?: Envelope): string {
  const typed = text.trim();
  if (typed.includes(PLAN_NOTE) || !rolePlans(root, role) || !cannotWrite(root, role, envelope)) return text;
  return typed ? `${typed}\n\n${PLAN_NOTE}` : PLAN_NOTE;
}

/**
 * A roster role of the SAVED flow that is not one of the four built-in ids, or
 * null: this is what `--role` may name, as it always could. An id only the
 * shipped template has is not this project's choice, so it is not a role here;
 * `--flow-role` resolves against the flow in force (`flowRoleInForce`).
 *
 * A roster id equal to a built-in id is never custom: it takes the built-in
 * path, and the saved step with that id gives it its walls and chain
 * (`savedStepOwningBuiltIn`). A custom role that carries a `policyRole` (a "QA"
 * step that is a reviewer) is found by its own id only, so it can never change
 * what the built-in role resolves to. The chain is the policy's for a role with
 * a `policyRole`, else the stored one.
 */
export function flowRoleFor(root: string, id: unknown): (FlowRole & { chain: Chain }) | null {
  if (typeof id !== "string" || workerRole(id)) return null;
  if (!readStoredFlow(root)?.roster.some((r) => r.id === id)) return null;
  return flowRoleInForce(root, id);
}

/** The same, for a role of the flow IN FORCE (the project's saved one, else the
 *  template): an id `--flow-role` asked for. */
export function flowRoleInForce(root: string, id: unknown): (FlowRole & { chain: Chain }) | null {
  if (typeof id !== "string" || workerRole(id)) return null;
  const r = roleById(readFlow(root).flow, id);
  return r ? { ...r, chain: chainOf(r) } : null;
}

/** Whether the flow in force makes this id a step a person answers: nothing
 *  runs there. By id, built-in ids included, so a start, a resume and an
 *  engine switch all see it. */
export const roleIsPersonStep = (root: string, id: unknown): boolean =>
  typeof id === "string" && roleById(readFlow(root).flow, id)?.actor === "person";

/**
 * A saved step that took a built-in role's id as its own: a roster entry with
 * that id whose `policyRole` is another kind, or none. The editor never writes
 * this shape and `writeFlow` keeps an id's kind, so only a hand-written flow or
 * an older snapshot (flowstore.ts) has one. It keeps its own walls and chain,
 * because the id names one step for good.
 */
export function savedStepOwningBuiltIn(root: string, id: unknown): FlowRole | undefined {
  if (typeof id !== "string" || !workerRole(id)) return undefined;
  const r = readStoredFlow(root)?.roster.find((x) => x.id === id);
  return r && r.policyRole !== id ? r : undefined;
}

/**
 * The `ctx` a flow-role worker's browser ask decides by, for `browserOffReason`
 * via `mintBrowserCredential`/`withBrowserLine`: empty for a built-in role
 * (unchanged — its own row in `roles` still decides it), else the flow role's
 * own row, falling back to the built-in role its `policyRole` maps to
 * (none when it names none: no base, no browser).
 */
export function browserAskContextFor(root: string, roleId: unknown): BrowserAskContext {
  if (typeof roleId !== "string" || workerRole(roleId)) return {};
  const f = flowRoleInForce(root, roleId);
  if (!f) return {};
  return { flowRole: { root, id: roleId, title: f.name, base: f.policyRole ?? "" } };
}

/** The saved flow's custom role ids, for the sentence that refuses an unknown one. */
export function flowRoleIds(root: string): string[] {
  return (readStoredFlow(root)?.roster ?? []).map((r) => r.id).filter((id) => !workerRole(id));
}

/** The sentence for an id that is neither built-in nor in the saved flow. */
export function unknownRoleError(root: string): string {
  const ids = flowRoleIds(root);
  return ids.length ? `no such role. The saved flow also has: ${ids.join(", ")}` : "no such role";
}

/**
 * The prompt of the roster role whose `policyRole` is `role`: the saved flow's,
 * else the shipped template's. A project with no saved flow gets "": its
 * launches stay as they were until somebody opens the flow editor. Anything
 * that is not a built-in role gets the flow's role of that id, else "".
 */
export function rolePromptFor(root: string, role: unknown): string {
  if (!workerRole(role)) return (flowRoleInForce(root, role)?.prompt?.trim() ?? "").slice(0, FLOW_PROMPT_MAX).trim();
  const own = readStoredFlow(root);
  if (!own) return "";
  const pick = (f: { roster: { policyRole?: string; prompt?: string }[] }) => f.roster.find((r) => r.policyRole === role)?.prompt?.trim() ?? "";
  return (pick(own) || pick(templateFlow())).slice(0, FLOW_PROMPT_MAX).trim();
}

/**
 * What a flow role may do: its own `readsOnly` and `tools`, and the `allow` the
 * project's ceiling still permits. `readsOnly` takes the built-in role its
 * `policyRole` names (builder when it names none) as a floor, so a role mapped
 * to a read-only one can never write; `allow` can only lift what a ceiling flag
 * already lifts.
 *
 * The one floor with a switch: a role mapped to `scout` says `readsOnly: false`
 * for itself, this project's `workers.plannerWrite` (same flag `roleFor` reads
 * for the built-in scout) is the only thing that lifts scout's own floor. Off,
 * or the role says `readsOnly: true` itself, and it stays read-only whatever
 * the switch says — the switch only loosens, it never overrides a role's own
 * narrower word.
 */
export function lockForFlowRole(root: string, f: FlowRole): { readsOnly: boolean; tools: string[]; allow: string[]; mayStartSubagents: boolean } {
  const base = workerRole(f.policyRole ?? "builder");
  const scoutLifted = base?.id === "scout" && f.readsOnly === false && plannerMayWrite(root);
  return {
    readsOnly: scoutLifted ? false : base?.readOnly === true || f.readsOnly === true,
    tools: [...(f.tools ?? [])],
    allow: allowWithin(f.allow, readPolicy(root).policy.ceiling),
    mayStartSubagents: f.mayStartSubagents === true,
  };
}

/**
 * What the flow says a role may do: `readsOnly`, the `tools` list and the
 * `allow` list. For one of the four built-ins, the saved flow's step with that
 * id — a step that took a built-in id as its own comes first, then the role
 * whose `policyRole` is it (the template is not this project's choice); for a
 * custom id, the role itself from the flow in force. Null when there is none:
 * the start is then exactly what it was. The floor and the ceiling are
 * `lockForFlowRole`'s.
 */
export function roleLockFor(root: string, roleId: unknown): { readsOnly: boolean; tools: string[]; allow: string[]; mayStartSubagents: boolean } | null {
  if (!workerRole(roleId)) {
    const c = flowRoleInForce(root, roleId);
    return c ? lockForFlowRole(root, c) : null;
  }
  const own = savedStepOwningBuiltIn(root, roleId);
  const r = own ?? readStoredFlow(root)?.roster.find((x) => x.policyRole === roleId);
  return r ? lockForFlowRole(root, r) : null;
}

/** The role prompt, then what the seat typed. Not repeated when the seat already pasted it. */
export function withRolePrompt(seatText: string, rolePrompt: string): string {
  if (!rolePrompt) return seatText;
  const typed = seatText.trim();
  if (typed.startsWith(rolePrompt)) return seatText;
  return typed ? `${rolePrompt}\n\n${seatText}` : rolePrompt;
}

/**
 * A flow role's `firstCommand`, from the saved flow, else "": the same lookup
 * `rolePromptFor` does for the role's prompt, so a built-in id still finds the
 * custom role mapped onto it by `policyRole`.
 */
export function firstCommandFor(root: string, role: unknown): string {
  if (!workerRole(role)) return flowRoleInForce(root, role)?.firstCommand?.trim() ?? "";
  const own = readStoredFlow(root);
  if (!own) return "";
  const pick = (f: { roster: { policyRole?: string; firstCommand?: string }[] }) =>
    f.roster.find((r) => r.policyRole === role)?.firstCommand?.trim() ?? "";
  return pick(own) || pick(templateFlow());
}

/**
 * The defect this answers: a planner's prompt SAID to run a skill through the
 * Skill tool, and the model skipped it twice (measured 2026-11-05). Sending the
 * command as the turn's own first line, alone, makes Claude Code run it
 * itself instead of leaving it to the model to notice in prose.
 *
 * Only a Claude turn's first message gets this — another engine is handed the
 * prompt exactly as it was. `cardOrPrompt` fills `{card}`: the card key the
 * worker was started with, or its `--prompt` text when it has none.
 */
export function withFirstCommand(prompt: string, root: string, role: unknown, engine: string, cardOrPrompt: string): string {
  if (engine !== "claude") return prompt;
  const cmd = firstCommandFor(root, role);
  if (!cmd) return prompt;
  const expanded = cmd.replace("{card}", cardOrPrompt.trim());
  const typed = prompt.trim();
  if (typed.startsWith(expanded)) return prompt;
  return typed ? `${expanded}\n\n${prompt}` : expanded;
}
