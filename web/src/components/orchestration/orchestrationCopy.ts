/*
 * Every sentence the Orchestration page says, and every pure edit it makes to
 * a policy, as functions of what the server measured. There is no renderer in
 * this project, so the words and the edits are held here and a table-driven
 * test pins them; the components only place them.
 *
 * Nothing here names an engine or a model by hand: titles come from the
 * provider table, verdicts from the readiness probe, and the sentence a
 * refusal carries is the server's own.
 */
import { agentProvider, engineProviders } from "../../../../shared/agentKinds.ts";
import {
  CHAIN_MAX, GAUGED_PROVIDERS, ROLE_IDS,
  type Chain, type EngineChoice, type Envelope, type Policy, type PolicyRule, type Resolved, type Trigger, type UsageProviderId,
} from "../../../../shared/orchestration.ts";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import type { PolicyRuleState } from "../../lib/api.ts";
import { engineState, type EngineState } from "../engines/enginesCopy.ts";
import type { StatusTone } from "../SettingsKit.tsx";

// ── names that come from data ────────────────────────────────────────────

/** The usage table names Claude's plan "anthropic"; every other provider uses its engine's id. */
const USAGE_ENGINE: Partial<Record<UsageProviderId, string>> = { anthropic: "claude" };
export const usageEngine = (p: UsageProviderId): string => USAGE_ENGINE[p] ?? p;
export const usageWord = (p: UsageProviderId): string => agentProvider(usageEngine(p))?.title ?? p;

/** "OpenCode big-pickle", or just the engine when the model is its own default. */
export function choiceWords(c: EngineChoice): string {
  const t = agentProvider(c.engine)?.title ?? c.engine;
  return c.model ? `${t} ${c.model}` : t;
}
export const chainWords = (c: Chain): string => c.map(choiceWords).join(", then ");

const roleTitle = (id: RoleId): string => WORKER_ROLES.find((r) => r.id === id)?.title ?? id;
const rolePlural = (id: RoleId): string => `${roleTitle(id).toLowerCase()}s`;

// ── conditions and rules ─────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One trigger as a clause that follows "When". */
export function triggerWords(t: Trigger): string {
  switch (t.kind) {
    case "always": return "this always holds";
    case "budget": return "the project's budget is used up";
    case "limit": return `the ${usageWord(t.provider)} plan has run out in a window`;
    case "usage": {
      const who = usageWord(t.provider);
      if (t.window === "either") return `${t.remainingAtMost}% or less is left in either ${who} window`;
      return `${t.remainingAtMost}% or less of the ${who} ${t.window === "5h" ? "5 h" : "weekly"} plan is left`;
    }
    case "hours": {
      const days = t.days.length === 7 ? "every day" : t.days.map((d) => DAY_NAMES[d] ?? "?").join(", ");
      return `it is ${days}, ${t.from} to ${t.to}`;
    }
  }
}

/** What a rule does, as the clause after the colon. */
export function thenWords(rule: PolicyRule): string {
  const parts: string[] = [];
  if (rule.orchestrator) parts.push(`the chair is ${chainWords(rule.orchestrator)}`);
  for (const id of ROLE_IDS) {
    const c = rule.workers?.[id];
    if (c) parts.push(`${rolePlural(id)} use ${chainWords(c)}`);
  }
  return parts.length ? parts.join("; ") : "nothing changes";
}

/** The sentence under a rule's name: "When 10% or less of the Claude Code weekly plan is left: builders use OpenCode big-pickle, then Hermes." */
export function ruleLine(rule: PolicyRule): string {
  return `When ${rule.when.map(triggerWords).join(" and ")}: ${thenWords(rule)}.`;
}

// ── the engine and model choices ─────────────────────────────────────────

export interface EngineOption { value: string; label: string; disabled?: boolean; hint?: string }

/**
 * Every engine the app knows, in table order. Only those whose verdict for the
 * role is ok can be picked; the rest are listed, disabled, with the reason the
 * probe gave, so an engine that vanished from a list reads as "not ready" and
 * not as a feature that never existed. `lock` disables everything but one
 * engine for a field the server holds fixed.
 */
export function engineOptions(role: "orchestrator" | "worker", readiness: readonly EngineReadiness[] | null, lock?: { engine: string; why: string }): EngineOption[] {
  return engineProviders().map((p) => {
    const base = { value: p.id, label: p.title };
    if (lock && p.id !== lock.engine) return { ...base, disabled: true, hint: lock.why };
    if (!readiness) return { ...base, disabled: true, hint: "Checking this machine." };
    const r = readiness.find((e) => e.id === p.id);
    if (!r) return { ...base, disabled: true, hint: "This machine has not been checked for it yet." };
    const v = r.roles[role];
    return v.ok ? base : { ...base, disabled: true, hint: v.why ?? `It cannot take the ${role} role here.` };
  });
}

/** The engines whose role verdict is ok, for the empty-state test. */
export const readyFor = (role: "orchestrator" | "worker", readiness: readonly EngineReadiness[]): string[] =>
  readiness.filter((e) => e.roles[role].ok).map((e) => e.id);

// ── the four not-ready states ────────────────────────────────────────────

/** 1. No engine can work: the Workers card is one empty state. */
export const NO_WORKER_ENGINE = "No engine on this machine can work for an orchestrator yet.";

/** 2. The chosen engine stopped being ready: its row says so and what runs instead. */
export interface NotReady { tone: "err"; text: "Not ready"; why: string; using?: string }
export function notReady(choice: EngineChoice, role: "orchestrator" | "worker", resolved: Resolved | undefined, readiness: readonly EngineReadiness[] | null): NotReady | null {
  if (!readiness) return null;
  const r = readiness.find((e) => e.id === choice.engine);
  const v = r?.roles[role];
  if (v?.ok) return null;
  const why = v?.why ?? (r ? `${agentProvider(choice.engine)?.title ?? choice.engine} cannot take the ${role} role here.` : "This machine has not been checked for it yet.");
  const using = resolved?.ok && resolved.choice.engine !== choice.engine ? `Using ${choiceWords(resolved.choice)} instead.` : undefined;
  return { tone: "err", text: "Not ready", why, ...(using ? { using } : {}) };
}

/** 4. The chain ran out: the card says so, with the words the seat received. */
export function exhausted(resolved: Resolved | undefined): { tone: "err"; text: string; sentence: string } | null {
  if (!resolved || resolved.ok) return null;
  return { tone: "err", text: "Nothing in this list is ready", sentence: resolved.why };
}

const CANNOT: Record<EngineState, string | null> = {
  checking: null, ready: null, testing: null, failed: null,
  missing: "is not installed", old: "needs an update", broken: "is not working", signin: "needs sign-in",
};

/** The first engine in a chain that cannot take the role, as a short clause: "Hermes needs an update". */
function firstBlocked(chain: Chain, role: "orchestrator" | "worker", readiness: readonly EngineReadiness[]): string | null {
  for (const c of chain) {
    const r = readiness.find((e) => e.id === c.engine);
    if (r?.roles[role].ok) return null;
    const title = agentProvider(c.engine)?.title ?? c.engine;
    return `${title} ${(r && CANNOT[engineState(r)]) ?? "cannot take this role here"}`;
  }
  return null;
}

/** 3 and the rest of the rule row: what its badge says, and in which tone. */
export function ruleBadge(rule: PolicyRule, state: PolicyRuleState | undefined, readiness: readonly EngineReadiness[] | null): { tone: StatusTone; text: string } {
  if (!rule.enabled) return { tone: "off", text: "Off" };
  if (readiness) {
    const chains: [Chain, "orchestrator" | "worker"][] = [];
    if (rule.orchestrator) chains.push([rule.orchestrator, "orchestrator"]);
    for (const id of ROLE_IDS) { const c = rule.workers?.[id]; if (c) chains.push([c, "worker"]); }
    for (const [chain, role] of chains) {
      // A chain with one ready entry can still apply: only a chain with none cannot.
      const blocked = chain.every((c) => !readiness.find((e) => e.id === c.engine)?.roles[role].ok);
      if (blocked) return { tone: "err", text: `Cannot apply · ${firstBlocked(chain, role, readiness)}` };
    }
  }
  if (state?.holding) return { tone: "off", text: `Holding · ${state.holding.replace(/^holding:\s*(the\s+)?/i, "")}` };
  if (state?.active) return { tone: "warn", text: state.reading ? `On now · ${state.reading}` : "On now" };
  return { tone: "off", text: "Waiting" };
}

// ── the usage condition's help ───────────────────────────────────────────

/** The engines with no gauge, named from the table: a rule cannot watch their quota. */
export function ungaugedEngines(): string[] {
  const gauged = new Set(GAUGED_PROVIDERS.map(usageEngine));
  return engineProviders().filter((p) => !gauged.has(p.id)).map((p) => p.title);
}

export const GAUGE_HELP = (): string => {
  const names = ungaugedEngines();
  if (!names.length) return "";
  return `${names.join(", ")} ${names.length === 1 ? "does" : "do"} not report a quota, so a rule cannot watch ${names.length === 1 ? "it" : "them"}. A failed start still moves to the next engine in the chain.`;
};

/** The providers a usage or limit condition may name: those with a gauge. */
export const usageChoices = (): { value: UsageProviderId; label: string }[] =>
  GAUGED_PROVIDERS.map((p) => ({ value: p, label: usageWord(p) }));

// ── pure edits ───────────────────────────────────────────────────────────

export type Field = "orchestrator" | RoleId;

/** Set the one base choice of a field (the base is one choice; a chain is a rule). */
export function withBaseChoice(p: Policy, field: Field, choice: EngineChoice): Policy {
  if (field === "orchestrator") return { ...p, base: { ...p.base, orchestrator: { ...p.base.orchestrator, value: [choice] } } };
  return { ...p, base: { ...p.base, workers: { ...p.base.workers, [field]: { ...p.base.workers[field], value: [choice] } } } };
}

/** "Ask when it runs": flips the flag and nothing else. */
export function withAsk(p: Policy, field: Field, ask: boolean): Policy {
  if (field === "orchestrator") return { ...p, base: { ...p.base, orchestrator: { ...p.base.orchestrator, ask } } };
  return { ...p, base: { ...p.base, workers: { ...p.base.workers, [field]: { ...p.base.workers[field], ask } } } };
}

export const withLimits = (p: Policy, limits: Partial<Policy["limits"]>): Policy => ({ ...p, limits: { ...p.limits, ...limits } });
export const withEnvelopes = (p: Policy, e: { ceiling: Envelope; workerDefault: Envelope }): Policy => ({ ...p, ceiling: e.ceiling, workerDefault: e.workerDefault });
export const withRuleEnabled = (p: Policy, id: string, enabled: boolean): Policy =>
  ({ ...p, rules: p.rules.map((r) => (r.id === id ? { ...r, enabled } : r)) });
export const withRule = (p: Policy, rule: PolicyRule): Policy =>
  ({ ...p, rules: p.rules.some((r) => r.id === rule.id) ? p.rules.map((r) => (r.id === rule.id ? rule : r)) : [...p.rules, rule] });
export const withoutRule = (p: Policy, id: string): Policy => ({ ...p, rules: p.rules.filter((r) => r.id !== id) });

/** A rule id the validator takes (`^[a-z0-9][a-z0-9-]{0,39}$`) and no other rule has. */
export function newRuleId(p: Policy, name: string): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "rule";
  const taken = new Set(p.rules.map((r) => r.id));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) { const id = `${stem}-${i}`; if (!taken.has(id)) return id; }
}

/** Chain edits: add, remove and move, never past the validator's four. */
export const chainAdd = (c: Chain, e: EngineChoice): Chain => (c.length >= CHAIN_MAX ? c : [...c, e]);
export const chainRemove = (c: Chain, i: number): Chain => c.filter((_, j) => j !== i);
export function chainMove(c: Chain, i: number, by: -1 | 1): Chain {
  const j = i + by;
  if (j < 0 || j >= c.length) return c;
  const out = [...c];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The ranges the server's validator takes; it is the authority, this only keeps the stepper inside them. */
export const LIMIT_RANGE = {
  maxWorkers: { min: 1, max: 12, label: "Workers at once", hint: "How many workers one orchestrator may have running together." },
  turnMinutes: { min: 1, max: 240, label: "Minutes per turn", hint: "A worker turn that runs longer than this is stopped." },
  maxRetries: { min: 0, max: 5, label: "Retries with the next engine", hint: "How many times a failed start moves on to the next engine in its chain." },
} as const satisfies Record<keyof Policy["limits"], { min: number; max: number; label: string; hint: string }>;

export const stepLimit = (key: keyof Policy["limits"], value: number, by: -1 | 1): number => {
  const r = LIMIT_RANGE[key];
  return Math.min(r.max, Math.max(r.min, value + by));
};

/** The ask chip's hint, as the plan words it. */
export const ASK_HINT = "The orchestrator chooses each time, from this list";
export const CHAIN_TAIL = "Then ask me.";
