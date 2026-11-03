/*
 * A project's flow: what it saved, or the template, with each built-in role's
 * chain read from the orchestration policy at the moment somebody asks.
 *
 * The policy stays the one owner of the four built-in roles' engines, so a
 * flow role of one of those kinds stores only `policyRole` and the chain is
 * resolved here. A role a person makes owns its chain in the flow, because the
 * policy has no slot for it. Nothing here imports the seat: the seat imports
 * this file to build its brief.
 */
import { validateFlow, type Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { readStoredFlow, writeStoredFlow } from "./config.ts";
import { chainInForce } from "./orchestration.ts";
import { APP, getSetting } from "./preflightStore.ts";
import { DEFAULT_REVIEW_ROUNDS } from "../../shared/reviewSettings.ts";

export interface FlowView {
  flow: Flow;
  /** Which flow answered: the project's own, or the template. */
  scope: "project" | "template";
  root: string;
}

/** The chain each role runs on now. `resolvedChain` is an answer, never a record. */
export function resolveChains(flow: Flow, root: string): Flow {
  return {
    ...flow,
    roster: flow.roster.map((r) => ({
      ...r,
      resolvedChain: r.policyRole ? chainInForce(root, r.policyRole) : [...r.chain],
    })),
  };
}

/**
 * The round cap on the reviewing block's failing arrow is an answer, never a
 * record: `orchestration.review.rounds` owns the number (it has the CLI, the
 * Settings page and the narrowing rule), so the arrow shows what the setting
 * says and the seat is never told two numbers.
 */
function overlayReviewRounds(flow: Flow, root: string): Flow {
  const stored = getSetting(root || APP, "orchestration.review.rounds");
  const rounds = typeof stored === "number" ? stored : DEFAULT_REVIEW_ROUNDS;
  const reviewers = new Set(flow.roster.filter((r) => r.policyRole === "reviewer").map((r) => r.id));
  return {
    ...flow,
    edges: flow.edges.map((e) => (e.on === "fail" && reviewers.has(e.from) ? { ...e, maxRounds: rounds } : e)),
  };
}

/** The flow in force for one project: its own when it saved one, else the template. */
export function readFlow(root: string): FlowView {
  const own = readStoredFlow(root);
  const flow = overlayReviewRounds(resolveChains(own ?? templateFlow(), root), root);
  return { flow, scope: own ? "project" : "template", root };
}

export type FlowWrite = { ok: true; view: FlowView } | { ok: false; error: string };

/**
 * Check a flow and store it. A role id keeps its kind: the ids a person sees
 * name one role for good, so a different `policyRole` under an id that already
 * exists is refused rather than silently turning the QA step into a reviewer.
 */
export function writeFlow(root: string, raw: unknown): FlowWrite {
  const v = validateFlow(raw);
  if (!v.ok) return v;
  const stored = readStoredFlow(root);
  const inForce = stored ?? templateFlow();
  for (let i = 0; i < v.value.roster.length; i++) {
    const role = v.value.roster[i]!;
    const was = inForce.roster.find((r) => r.id === role.id);
    if (was && was.policyRole !== role.policyRole) {
      return { ok: false, error: `roster[${i}].policyRole: "${role.id}" is the ${was.name} step and keeps its kind; a new step needs a new id` };
    }
  }
  // The reviewing block's fail arrow keeps what was stored (the setting owns the live number), so an edit to it is ignored.
  const reviewers = new Set(v.value.roster.filter((r) => r.policyRole === "reviewer").map((r) => r.id));
  const before = new Map(inForce.edges.filter((e) => e.on === "fail").map((e) => [`${e.from}>${e.to}`, e.maxRounds]));
  v.value.edges = v.value.edges.map((e) => {
    const kept = before.get(`${e.from}>${e.to}`);
    return e.on === "fail" && reviewers.has(e.from) && kept !== undefined ? { ...e, maxRounds: kept } : e;
  });
  const w = writeStoredFlow(root, v.value);
  if (!w.ok) return { ok: false, error: w.error ?? "could not write the flow" };
  return { ok: true, view: readFlow(root) };
}

/** Remove a saved flow, so the project falls back to the template. */
export function deleteFlow(root: string): FlowWrite {
  const w = writeStoredFlow(root, null);
  if (!w.ok) return { ok: false, error: w.error ?? "could not remove the flow" };
  return { ok: true, view: readFlow(root) };
}

/**
 * The paragraph the orchestrator is told about its project's flow.
 *
 * An instruction and not a guard: this app hands the flow over and does not
 * stand at every step, and the last line says so in words the seat repeats.
 */
/** What the role lines may add to the seat text; the roster lines shrink to fit, names last. */
export const ROLE_LINES_MAX = 1500;
const ROLE_PROMPT_NOTE = "A worker you start with --role gets that role's prompt automatically.";

/**
 * One line per roster role: `<name>: <does>; reads only; tools: a, b`. Over
 * the cap the tools go first, then the sentence of what it does; names stay.
 * The role prompt itself is not here (size): the start path adds it.
 */
export function roleLines(roster: Flow["roster"]): string {
  const line = (r: Flow["roster"][number], withTools: boolean, withDoes: boolean) =>
    [withDoes && r.does ? `${r.name}: ${r.does}` : r.name, r.readsOnly ? "reads only" : "", withTools && r.tools?.length ? `tools: ${r.tools.join(", ")}` : ""]
      .filter(Boolean).join("; ");
  for (const [t, d] of [[true, true], [false, true], [false, false]] as const) {
    const out = roster.map((r) => line(r, t, d)).join("\n") + "\n\n" + ROLE_PROMPT_NOTE;
    if (out.length <= ROLE_LINES_MAX || !d) return out;
  }
  return "";
}

/** Over this many custom roles one line replaces the per-role start lines: the form once, then the ids. */
const START_LINES_MAX = 8;

/** The exact start line of each custom (non-built-in) role, after `roleLines`. Nothing for a roster of built-ins. */
function customStartLines(roster: Flow["roster"]): string[] {
  const custom = roster.filter((r) => !workerRole(r.id));
  if (!custom.length) return [];
  if (custom.length > START_LINES_MAX) return ["", `Start a custom role with: agentglass-agent start --role <id>; ids: ${custom.map((r) => r.id).join(", ")}`];
  return ["", ...custom.map((r) => `${r.name}: agentglass-agent start --role ${r.id}`)];
}

export function renderFlowForOrchestrator(flow: Flow): string {
  const byId = new Map(flow.roster.map((r) => [r.id, r]));
  const path = flow.path.map((id) => byId.get(id)?.name ?? id);
  const team = flow.roster.map((r) => r.name);
  const required = flow.roster.filter((r) => r.required && flow.path.includes(r.id)).map((r) => r.name);
  const rounds = flow.edges
    .filter((e) => e.on === "fail")
    .map((e) => `${byId.get(e.from)?.name ?? e.from} goes back to ${byId.get(e.to)?.name ?? e.to} up to ${e.maxRounds} times`);
  return [
    "## The flow this project follows",
    "",
    `The suggested path, in order: ${path.join(" → ")}.`,
    "",
    `The team: ${team.join(", ")}. A role in the team that is not on the path may still be asked for work.`,
    "",
    roleLines(flow.roster),
    ...customStartLines(flow.roster),
    "",
    required.length
      ? `**Hard rule: ${required.join(" and ")} cannot be skipped.** When ${required.length > 1 ? "they are" : "it is"} on the path, you do not move past ${required.length > 1 ? "them" : "it"}. The server refuses to land a plan until each of these has a passing result: start ${required.length > 1 ? "them" : "it"} with --plan <id>.`
      : "No step is required: every one may be skipped when the work does not need it.",
    ...(rounds.length ? ["", `A failing step goes back: ${rounds.join("; ")}. After the last round it is a person's answer, never another engine's. The server counts these and stops the plan at that number.`] : []),
    "",
    "The orchestrator follows this flow; agentglass does not force it step by step.",
  ].join("\n");
}
