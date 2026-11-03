/*
 * The Flow page's words and the two lists it is drawn and checked against: one
 * entry per block's right-click menu, and one per key. The menu and the keys
 * section of the page both read these, so what the page documents is the list
 * the drawing uses rather than a paragraph that drifted from it.
 *
 * Everything here is real data: the policy, and the reviewer's three settings
 * (who checks, the round cap and a second reviewer) which the page reads and
 * writes through the settings door like its neighbours.
 */
import { agentProvider } from "../../../../../shared/agentKinds.ts";
import { ROLE_IDS, type EngineChoice, type Policy, type PolicyRule, type Resolved } from "../../../../../shared/orchestration.ts";
import {
  DEFAULT_REVIEW_ROUNDS, DEFAULT_REVIEW_WHO, REVIEW_ROUNDS_MAX, REVIEW_ROUNDS_MIN, REVIEW_WHO,
  type ReviewWho, type SecondReviewer,
} from "../../../../../shared/reviewSettings.ts";
import { workerRole } from "../../../../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { tileModel, type Field } from "./../orchestrationCopy.ts";

export type FlowBlockId = "you" | "orchestrator" | "scout" | "builder" | "reviewer" | "verifier" | "gate" | "fallback";

/** The chain, left to right, as the page draws it. */
export const CHAIN: readonly FlowBlockId[] = ["you", "orchestrator", "builder", "reviewer", "verifier", "gate"];
/** The two stops drawn off the chain: above it and under the loop. */
export const ABOVE: FlowBlockId = "scout";
export const BELOW: FlowBlockId = "fallback";

/** The job a block does, if the policy has one. */
export const fieldOf = (id: FlowBlockId): Field | null =>
  id === "orchestrator" ? "orchestrator" : (ROLE_IDS as readonly string[]).includes(id) ? id as Field : null;

export interface FlowSeg { text: string; tone: "ok" | "warn" | "dim" }
export interface FlowBlock {
  id: FlowBlockId;
  name: string;
  /** One line under the name: what it is for. */
  role: string;
  /** The chip: who runs it, and with which model. */
  engine: string;
  model: string;
  state: FlowSeg;
  /** The engine the chip names, when one does: a rule can have moved it. */
  choice: EngineChoice | null;
  /** The rule that moved this block, when one did. */
  ruleName: string | null;
}

const NAME: Record<FlowBlockId, string> = {
  you: "You", orchestrator: "Orchestrator", scout: "Scout", builder: "Builder",
  reviewer: "Reviewer", verifier: "Verifier", gate: "Gate", fallback: "Fallback",
};
const ROLE: Record<FlowBlockId, string> = {
  you: "The person this machine belongs to",
  orchestrator: "Breaks the ask into steps and hands each one out",
  scout: "Finds what the change needs before anyone edits",
  builder: "Writes the change and runs its own tests",
  reviewer: "Reads the diff as a stranger",
  verifier: "Runs the tests the change claims to pass",
  gate: "Anything leaving the machine asks you first",
  fallback: "Takes the builder's turn when its plan runs low",
};
const engineName = (id: string): string => agentProvider(id)?.title ?? id;

/** The first rule that watches a plan: the one the Fallback block stands for. */
export const planRule = (policy: Policy): PolicyRule | undefined =>
  policy.rules.find((r) => r.when.some((t) => t.kind === "usage"));

/**
 * The drawing, from the policy and the probe. A block whose resolved chain has
 * nothing ready says so on its own chip; the fallback is drawn from the plan
 * rule, dashed while that rule is off.
 */
export function flowBlocks(p: {
  policy: Policy;
  resolution: { orchestrator: Resolved; workers: Record<string, Resolved> } | null;
  readiness: readonly EngineReadiness[] | null;
  gate: { on: boolean; bundled: boolean } | null;
  liveModel?: string | null;
}): FlowBlock[] {
  const out: FlowBlock[] = [];
  const node = (id: FlowBlockId): FlowBlock => {
    const field = fieldOf(id);
    const resolved = field ? (field === "orchestrator" ? p.resolution?.orchestrator : p.resolution?.workers[field]) : undefined;
    const ask = field === "orchestrator" ? p.policy.base.orchestrator : field ? p.policy.base.workers[field] : undefined;
    const choice: EngineChoice | null = resolved?.ok ? resolved.choice : ask?.value[0] ?? null;
    const ruleName = resolved?.ok && resolved.from === "rule" ? resolved.ruleName ?? null : null;
    const ready = resolved?.ok !== false;
    return {
      id, name: NAME[id], role: ROLE[id],
      engine: choice ? engineName(choice.engine) : "No engine",
      model: id === "orchestrator" && p.liveModel ? p.liveModel : choice ? tileModel(choice.engine, field === "orchestrator" ? "orchestrator" : "worker", choice.model).replace("default model", "default") : "",
      state: p.readiness ? (ready ? { text: "ready", tone: "ok" } : { text: "Not ready", tone: "warn" }) : { text: "checking", tone: "dim" },
      choice, ruleName,
    };
  };
  out.push({ ...node("you"), name: "You", role: ROLE.you, engine: "Human", model: "this session", state: { text: "here", tone: "ok" }, choice: null, ruleName: null });
  out.push(node("orchestrator"));
  for (const id of ["scout", "builder", "reviewer", "verifier"] as FlowBlockId[]) out.push(node(id));
  const g = p.gate;
  out.push({
    id: "gate", name: "Gate", role: ROLE.gate, engine: "agentglass", model: "built in",
    state: { text: !g ? "checking" : !g.bundled ? "This build has none" : g.on ? "on" : "off", tone: !g ? "dim" : g.on ? "ok" : "warn" },
    choice: null, ruleName: null,
  });
  const rule = planRule(p.policy);
  const moved = rule ? ROLE_IDS.map((r) => rule.workers?.[r]).find(Boolean) : undefined;
  const fb = moved?.[0] ?? rule?.orchestrator?.[0];
  const usage = rule?.when.find((t) => t.kind === "usage");
  out.push({
    id: "fallback", name: "Fallback", role: ROLE.fallback,
    engine: fb ? engineName(fb.engine) : "No engine set",
    model: usage && usage.kind === "usage" ? `below ${usage.remainingAtMost}% left` : "no plan is watched",
    state: !rule ? { text: "not set", tone: "dim" } : !rule.enabled ? { text: "rule is off", tone: "dim" } : { text: "on standby", tone: "dim" },
    choice: fb ?? null, ruleName: rule?.name ?? null,
  });
  return out;
}

/** The order the chain is drawn in, whatever order the caller listed them. */
export function chainOf(blocks: readonly FlowBlock[]): FlowBlock[] {
  return CHAIN.map((id) => blocks.find((b) => b.id === id)).filter((b): b is FlowBlock => !!b);
}

// ── the panel's copy ─────────────────────────────────────────────────────

export interface BlockWords { job: string; takes: string; hands: string; when: string }

/**
 * What each stop receives and passes on. Written per stop rather than derived:
 * the chain between two of them is the design, and a sentence generated from
 * the policy would invent a link the page does not draw.
 */
export const WORDS: Record<FlowBlockId, BlockWords> = {
  you: {
    job: "You set the goal and the boundary: what the task is, which project it belongs to, and whether the result leaves this machine. You are in the loop when a block stops and asks.",
    takes: "Nothing. A task starts as a sentence in a project's window.",
    hands: "The sentence and the project to the Orchestrator.",
    when: "A task starts as a sentence in a project's window.",
  },
  orchestrator: {
    job: "Reads the task, decides which jobs it needs and in what order, and writes the handoff each one gets. It also writes the summary you read.",
    takes: "Your sentence, the project, and the rules in force for that project.",
    hands: "A short task with a definition of done to the Builder; findings come back here first.",
    when: "Always first. A question comes back to you before any code.",
  },
  scout: {
    job: "Walks the tree once and answers three questions for the Builder: where the code lives, which tests cover it, and what changed there recently. It reads; it never edits.",
    takes: "The task text from the Orchestrator, before the Builder starts.",
    hands: "A short map — files, tests, last commits — attached to the Builder's handoff.",
    when: "Before the Builder's first edit, when its rule is on.",
  },
  builder: {
    job: "Implements the task in its own worktree, keeps the diff small, and runs the tests it can name. It reports what it changed and what it could not finish.",
    takes: "The task and definition of done, the Scout's map, and any findings from the previous round.",
    hands: "A branch, a diff and a test log to the Reviewer.",
    when: "After the Orchestrator's handoff, and again after each round of findings.",
  },
  reviewer: {
    job: "Reads only the diff and the task, never the Builder's reasoning, and writes findings that name a line and a consequence. A clean review sends the change on; findings send it back.",
    takes: "The task, the diff and the test log. Not the Builder's chat.",
    hands: "Findings to the Builder, or a clean verdict to the Verifier.",
    when: "Always after the Builder. A findings round reopens the loop.",
  },
  verifier: {
    job: "Takes the clean diff and runs the real command on the real tree — the project's own test target, not a summary of it. A red run sends the change back with the failing output attached.",
    takes: "A clean verdict from the Reviewer and the branch it names.",
    hands: "A pass or a failure with its log to the Gate.",
    when: "After a clean review. A red run reopens the loop with the log attached.",
  },
  gate: {
    job: "Stands between a verified change and the outside world. It shows the exact action — the push, the pull request, the comment, the merge — and waits for your answer.",
    takes: "A verified change from the Verifier.",
    hands: "The pushed branch, the pull request, or nothing at all, to you.",
    when: "Before anything leaves the machine. No timeout.",
  },
  fallback: {
    job: "A dashed branch, not a step: when the plan named by its rule runs low, the next turn goes to a different engine with the same task and the same worktree.",
    takes: "The task and the worktree exactly as the Builder left them.",
    hands: "Its turn back into the same review loop.",
    when: "When the plan its rule watches drops below the threshold. One switch per task.",
  },
};

/**
 * The tools a block may use, and the ones it may not, from what the role is and
 * what the policy allows a worker: the read-only roles never write, and the
 * envelope is the ceiling for the others.
 */
export function toolsFor(id: FlowBlockId, policy: Policy): { allowed: string[]; never: string[] } {
  const env = policy.workerDefault;
  const role = fieldOf(id) && id !== "orchestrator" ? workerRole(id) : undefined;
  if (id === "you") return { allowed: ["Answer the Gate", "Stop a task"], never: [] };
  if (id === "gate") return { allowed: ["Show the exact action", "Ask for your answer"], never: ["Push to master", "Force push", "Delete a branch", "Merge without your answer"] };
  if (id === "fallback") return { allowed: ["The Builder's tools, no more"], never: ["A second switch in the same task"] };
  if (id === "orchestrator") return { allowed: ["Read the tree", "Write notes", "Start a worker"], never: ["Edit product code", "Run tests", "Push"] };
  const allowed = ["Read files", "Run commands"];
  const never: string[] = [];
  if (role && !role.readOnly && env.write === "worktree") allowed.push("Write in the worktree"); else never.push("Write");
  if (env.commit && role && !role.readOnly) allowed.push("Commit locally"); else never.push("Commit");
  if (!env.network) never.push("Network");
  never.push("Push");
  return { allowed, never };
}

/** The limits that apply to a block, in the person's words, from the real numbers. */
export function limitsFor(id: FlowBlockId, policy: Policy): string[] {
  if (id === "you" || id === "gate") return [id === "gate" ? "Waits as long as you take" : "No timeout. Waiting is free."];
  const out = [`${policy.limits.turnMinutes} minutes per turn`];
  if (id === "reviewer") out.push("The round cap is drawn on the loop below");
  if (id === "builder" || id === "fallback") out.push(policy.limits.maxRetries === 1 ? "One retry on the next engine, then it reports" : `${policy.limits.maxRetries} retries on the next engine`);
  return out;
}

/** Why the block runs what it runs: the rule by name, or the base this scope set. */
export function whyFor(b: FlowBlock, scopeWord: string): string {
  if (b.id === "you" || b.id === "gate") return b.id === "gate" ? "The one setting that is not a preference: no rule can switch it off." : "Set by you. Nothing here can write your answer for you at the Gate.";
  if (b.id === "fallback") return b.ruleName ? `From the usage rule “${b.ruleName}”. It is dashed because it may never run.` : "No usage rule is set, so nothing switches engines when a plan runs low. Add one on the Fallback block.";
  if (b.ruleName) return `Moved by the rule “${b.ruleName}”. Without it, the base choice for ${scopeWord} applies.`;
  return `The base choice for ${scopeWord}. No rule is on for this block.`;
}

// ── who checks, and the round cap ────────────────────────────────────────

/** The three answers of "Who reviews and checks", in the server's own order. */
export const CHECKS: readonly { id: ReviewWho; label: string; hint: string }[] = [
  { id: REVIEW_WHO[0], label: "The orchestrator never reads code or runs tests", hint: "It only routes, and a worker's report says whether the change is green." },
  { id: REVIEW_WHO[1], label: "The orchestrator makes a second review", hint: "It reads the same diff after the Reviewer, before the loop closes. The default, as it works today." },
  { id: REVIEW_WHO[2], label: "The orchestrator is the reviewer", hint: "It reads the diff itself; the Reviewer stop and the round cap stay as drawn." },
];
export type CheckId = ReviewWho;

/**
 * The second reviewer starts on an engine the first Reviewer is not on: the
 * same engine is the same opinion twice. Null when no other engine is ready,
 * so the switch stays off rather than turning on a copy.
 */
export function secondReviewerDefault(
  first: { engine: string } | null | undefined,
  options: readonly { value: string; disabled?: boolean }[],
): SecondReviewer | null {
  const engine = options.find((o) => !o.disabled && o.value !== first?.engine)?.value;
  return engine ? { engine, model: "" } : null;
}

export type { SecondReviewer };

/** The blocks a saved rule changes: the stop it routes, and the Fallback when it watches a plan. */
export function blocksTouchedBy(rule: PolicyRule): FlowBlockId[] {
  const routed = rule.orchestrator ? "orchestrator" : ROLE_IDS.find((r) => rule.workers?.[r]) ?? "fallback";
  const ids: FlowBlockId[] = [routed as FlowBlockId];
  if (rule.when.some((t) => t.kind === "usage")) ids.push("fallback");
  return [...new Set(ids)];
}

export const ROUND_MIN = REVIEW_ROUNDS_MIN;
export const ROUND_MAX = REVIEW_ROUNDS_MAX;
export const DEFAULT_ROUNDS = DEFAULT_REVIEW_ROUNDS;
export const DEFAULT_CHECKS = DEFAULT_REVIEW_WHO;

// ── the menu and the keys, registered once ───────────────────────────────

export type FlowMenuAct = "open" | "engine" | "model" | "after" | "general" | "copy" | "remove";
export interface FlowMenuEntry {
  act: FlowMenuAct;
  label: string;
  /** The key it is reachable with, when it has one; printed by the menu and by Keys and menus. */
  key?: string;
  /** "project": only where a project has its own setting. "none": never, and it says why. */
  needs: "always" | "project" | "none";
  why?: string;
  /** What Keys and menus says it does. */
  does: string;
  danger?: boolean;
}

/**
 * The right-click menu of every block. One list, so the menu, the keys section
 * and the test that checks them both read the same seven entries.
 */
export const FLOW_MENU: readonly FlowMenuEntry[] = [
  { act: "open", label: "Open details", key: "Enter", needs: "always", does: "selects the block", danger: false },
  { act: "engine", label: "Change engine…", needs: "always", does: "the engine row" },
  { act: "model", label: "Change model…", needs: "always", does: "the model row" },
  { act: "after", label: "Add a step after", needs: "none", why: "The chain is six stops, and a rule changes who runs a stop rather than adding one.", does: "the next empty slot" },
  { act: "general", label: "Use the general setting", needs: "project", why: "This is already the general setting.", does: "drops this project's own value" },
  { act: "copy", label: "Copy settings as text", needs: "always", does: "for a task or a doc" },
  { act: "remove", label: "Remove step", needs: "none", why: "The six stops stay. Turn a rule off, or pick another engine for the stop.", does: "asks first", danger: true },
];

/** Whether a menu entry is off for a block: a row it cannot show is not offered. */
export function menuOff(m: FlowMenuEntry, o: { projectScope: boolean; field: boolean }): boolean {
  if (m.needs === "none") return true;
  if (m.needs === "project" && !o.projectScope) return true;
  if (m.act === "engine" || m.act === "model") return !o.field;
  return false;
}

export interface FlowKey { keys: readonly string[]; what: string }
/** The keys of the page, one list for the drawing and for the Keys section. */
export const FLOW_KEYS: readonly FlowKey[] = [
  { keys: ["←", "→"], what: "Between blocks" },
  { keys: ["Enter"], what: "Open this block" },
  { keys: ["Esc"], what: "Close a menu" },
  { keys: ["Shift", "F10"], what: "Context menu" },
  { keys: ["≡"], what: "Context menu · menu key" },
  { keys: ["Alt", "1–4"], what: "Between sections" },
];

/** The text "Copy settings as text" puts on the clipboard: what is drawn for this block. */
export function blockAsText(b: FlowBlock, policy: Policy, scopeWord: string): string {
  const w = WORDS[b.id];
  const t = toolsFor(b.id, policy);
  return [
    `${b.name} — ${b.role}`,
    `Runs on ${b.engine}${b.model ? ` · ${b.model}` : ""} (${scopeWord})`,
    `Takes: ${w.takes}`,
    `Hands to: ${w.hands}`,
    `Tools allowed: ${t.allowed.join(", ") || "none"}`,
    t.never.length ? `Never: ${t.never.join(", ")}` : "",
    `Limits: ${limitsFor(b.id, policy).join("; ")}`,
  ].filter(Boolean).join("\n");
}
