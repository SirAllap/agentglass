import type { BudgetStatus, GateRule } from "../../shared/types.ts";
import { inScope, readBudgets, readGateRules } from "./config.ts";
import { budgetStatus, overBudgetFor, overBudgetLine, sessionCwd } from "./budget.ts";

/**
 * The gate deciding a call by rule, without waiting for a person.
 *
 * The gate used to hold every call it was sent until somebody answered, which
 * only catches what happens while somebody is watching. The failure that costs
 * money is a loop that spends before anyone looks: by the time the dashboard
 * shows the spike, the calls that made it have already run. And a matcher that
 * fires on every `Bash` either interrupts on every call or is not worth wiring.
 *
 * A rule says, for a project or for the whole machine, which tools run without
 * a hold, which are denied outright, what happens to the rest, and what happens
 * once a budget covering the project is over. Three outcomes, and only one of
 * them is new in kind: `hold` is what the gate always did, `allow` is what the
 * gate does for a tool its matcher never sent, and `deny` is the one thing a
 * rule can do that nothing in this app could before — stop a call nobody is
 * looking at.
 *
 * Deliberately NOT here, and the next things after this:
 *  - matching on arguments. A rule names tools; "Bash but not `rm`" is
 *    outward.ts's kind of reading, and a pattern language over shell commands
 *    is a thing that is wrong in ways nobody notices.
 *  - scoping by agent. A rule is per directory, like a budget. Two agents in
 *    one checkout share its rules.
 *  - scoping by target. The directory is where the session runs, not what the
 *    call touches: an Edit made from a laxer checkout into a stricter one
 *    follows the laxer rule, and a model that `cd`s moves with it.
 *  - reading a shell command. `Bash` on an allow list lets through every
 *    command outward.ts does not recognise as outward, and that is a
 *    heuristic: it reads inside `bash -c` and `eval`, but `g=git; $g push`
 *    is not recognised. An outward match is never released by an allow
 *    rule, except one made only by a generic MCP verb, and only by a rule
 *    that names that exact tool.
 *  - a settings pane. The rules live in config.json and nothing writes them,
 *    which is also what keeps them out of reach of the token every agent on the
 *    machine holds — budgets needed a kill switch for exactly that.
 */

export type RuleVerdict =
  /** No rule covers this call: the gate behaves exactly as it did before. */
  | { kind: "none" }
  /** `exact` when the allow list names this tool rather than matching it by a
   *  prefix — the only allow that may release a generic outward match. */
  | { kind: "allow"; exact?: boolean }
  | { kind: "hold" }
  | { kind: "deny"; reason: string };

/** A name, or a prefix when it ends in `*`. `mcp__orbit__*` is the case that
 *  needs it: a server's tools are a family nobody wants to list one by one. */
const matches = (tool: string, pattern: string): boolean =>
  pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;

const scopeLabel = (r: GateRule): string =>
  r.root ? r.root.split("/").filter(Boolean).pop() || r.root : "every project";

/**
 * The rule that speaks for a call made in `cwd`: the deepest root that covers
 * it, and the machine-wide rule when no project's does.
 *
 * One rule, not a merge. A project is where somebody said something specific,
 * and a merge would let the machine's allow list quietly widen a project that
 * was meant to be strict. A tie keeps the first in the file.
 *
 * `inScope` decides coverage, as it does for budgets, so a rule on a checkout
 * also covers its linked worktrees, and a rule with a root does not cover a
 * directory nobody could place.
 */
function ruleFor(cwd: string, rules: GateRule[]): GateRule | null {
  let best: GateRule | null = null;
  for (const r of rules) {
    if (!inScope(cwd, r.root)) continue;
    if (!best || r.root.length > best.root.length) best = r;
  }
  return best;
}

/**
 * What the rules say about `tool` running in `cwd`, given the budget (if any)
 * that is already over there.
 *
 * In order, and the order is the policy:
 *  1. the deny list, because naming a tool there is the most specific thing a
 *     person can say about it;
 *  2. an over budget, which outranks the allow list — the runaway loop is made
 *     of calls that were waved through, so a limit that only annotated calls
 *     that were already held would never see it;
 *  3. the allow list;
 *  4. `otherwise`.
 *
 * The reasons are read by a model that has just been stopped. They say a rule
 * did it and not a person — a model told a human looked at a call nobody looked
 * at has been given the wrong fact — and that retrying is pointless.
 */
/**
 * A harness-internal call nobody's rule ever names, because nobody chose to
 * gate it — it is the agent fetching a deferred tool's own schema, not a call
 * against the project. Exempted before the deny/budget/allow/otherwise chain
 * runs at all: a strict allow-list rule (`otherwise: "hold"` or `"deny"`)
 * stalled every normal session on its first deferred-tool call, held for a
 * tool the person never saw to decide about.
 */
const HARNESS_META_TOOLS = new Set(["ToolSearch"]);

export function gateRuleVerdict(tool: string, cwd: string, rules: GateRule[], over: BudgetStatus | null): RuleVerdict {
  if (HARNESS_META_TOOLS.has(tool)) return { kind: "allow", exact: true };
  const r = ruleFor(cwd, rules);
  if (!r) return { kind: "none" };
  const where = scopeLabel(r);
  const retry = "Do not retry it — it will be denied again. Take a different approach, or ask a person to change the rule.";
  if (r.deny.some((p) => matches(tool, p))) {
    return { kind: "deny", reason: `This call was denied by a rule in agentglass, not by a person: ${tool} is on the deny list for ${where}. ${retry}` };
  }
  if (over) {
    return r.overBudget === "deny"
      ? { kind: "deny", reason: `This call was denied by a rule in agentglass, not by a person: ${overBudgetLine(over)}, and the rule for ${where} denies calls once a budget is over. Every further call will be denied too until the period rolls over or the limit is raised — stop and tell a person rather than trying another tool.` }
      : { kind: "hold" };
  }
  if (r.allow.some((p) => matches(tool, p))) return { kind: "allow", exact: r.allow.includes(tool) };
  if (r.otherwise === "deny") {
    return { kind: "deny", reason: `This call was denied by a rule in agentglass, not by a person: ${tool} is not on the allow list for ${where}. ${retry}` };
  }
  return { kind: r.otherwise };
}

/**
 * The directory a gated call runs in.
 *
 * The hook reports the one Claude Code gives it. Only an absolute path is taken
 * as a place; anything else falls back to the pane note, which is all the gate
 * knew before the hook said. "" means unknown, and a rule with a root never
 * covers unknown.
 */
export function gateCwd(reported: unknown, session: string): string {
  if (typeof reported === "string" && reported.startsWith("/")) return reported;
  try {
    return sessionCwd(session);
  } catch {
    return "";
  }
}

/**
 * The verdict for a call as the route sees it. Never throws.
 *
 * It reads config.json and queries SQLite, and a throw on this path would leave
 * /gate answering 500 — allowed by a fail-open hook and DENIED by a fail-closed
 * one. A broken rule must fall back to what the gate did before rules existed,
 * which is `none`, and never to a decision.
 *
 * The budget is only evaluated when a rule covers the call: with no rules — the
 * shipped state — this costs one read of a cached config. It is evaluated again
 * for the hold's annotation when the call is held; a second pass over a few
 * budgets is cheaper than threading one status through two policies.
 */
export function gateRuleFor(tool: string, cwd: string): RuleVerdict {
  try {
    const rules = readGateRules();
    if (!rules.length) return { kind: "none" };
    // Only budgets on every model. The gate payload carries no model, so a
    // limit on one model that is over would otherwise stop the agents on all
    // the others in the project.
    const over = ruleFor(cwd, rules) ? overBudgetFor(cwd, budgetStatus(readBudgets().filter((b) => !b.model))) : null;
    return gateRuleVerdict(tool, cwd, rules, over);
  } catch (e) {
    console.warn("[gate] rules skipped:", e instanceof Error ? e.message : e);
    return { kind: "none" };
  }
}
