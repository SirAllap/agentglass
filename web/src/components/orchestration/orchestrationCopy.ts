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
  CHAIN_MAX, GAUGED_PROVIDERS, ROLE_IDS, resolve,
  type Chain, type EngineChoice, type Envelope, type Policy, type PolicyRule, type Resolution, type Resolved, type Trigger, type UsageProviderId,
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

/** "Hermes needs an update": why one engine cannot take the role, in a clause. */
function blockedClause(id: string, role: "orchestrator" | "worker", readiness: readonly EngineReadiness[]): string {
  const r = readiness.find((e) => e.id === id);
  const title = agentProvider(id)?.title ?? id;
  return `${title} ${(r && CANNOT[engineState(r)]) ?? "cannot take this role here"}`;
}

/** The first engine in a chain that cannot take the role, as a short clause: "Hermes needs an update". */
function firstBlocked(chain: Chain, role: "orchestrator" | "worker", readiness: readonly EngineReadiness[]): string | null {
  for (const c of chain) {
    if (readiness.find((e) => e.id === c.engine)?.roles[role].ok) return null;
    return blockedClause(c.engine, role, readiness);
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

// ── quick setup ──────────────────────────────────────────────────────────

/*
 * A preset is a rule, never a new kind of setting. Applying one adds a rule
 * whose id starts with `preset-` and leaves everything else of the policy as it
 * was: the base (which writes through to the worker roles and the chair), the
 * envelope and the limits. That is what makes "Back to what it was" exact: the
 * policy goes back to the one it was applied to, and nothing outside the rules
 * was ever touched.
 *
 * The engines a preset names are chosen from the readings, never typed here:
 * the ones whose worker verdict is ok, in the provider table's order with
 * Claude left out (it is the one being spared), at most as many as a chain
 * holds. A preset that would name an engine the probe says cannot take the
 * role is not offered; it is disabled with the reason. The reading is the one
 * the page took when it opened: the server does not check engines on a policy
 * write, and an engine that breaks afterwards makes the resolver refuse the
 * role ("no engine in the chain is ready"), never fall back to another.
 */
export type PresetId = "claude-orchestrates" | "all-on-claude" | "save-my-plan";
export const PRESET_IDS: readonly PresetId[] = ["claude-orchestrates", "all-on-claude", "save-my-plan"];
/** "Nearly spent": the weekly plan has this much left or less. */
export const PLAN_NEARLY_SPENT = 15;
export const BACK_LABEL = "Back to what it was";
export const presetRuleId = (id: PresetId): string => `preset-${id}`;
/** The two presets that always hold replace each other; the usage one stands apart. */
const ALWAYS_PRESETS: readonly PresetId[] = ["claude-orchestrates", "all-on-claude"];

const CLAUDE = "claude";
const claudeTitle = (): string => agentProvider(CLAUDE)?.title ?? CLAUDE;

/**
 * The order a preset tries the other engines in. A choice, not a measurement:
 * the ones that run on their own models or a free tier come before the ones
 * that spend another subscription, and an engine this list does not know
 * follows in the provider table's order.
 */
const PRESET_ORDER: readonly string[] = ["opencode", "hermes", "gemini", "codex", "antigravity"];
const othersInOrder = (): string[] => {
  const ids = engineProviders().map((p) => p.id).filter((id) => id !== CLAUDE);
  const rank = (id: string) => { const i = PRESET_ORDER.indexOf(id); return i < 0 ? PRESET_ORDER.length : i; };
  return ids.map((id, at) => ({ id, at })).sort((a, b) => rank(a.id) - rank(b.id) || a.at - b.at).map((x) => x.id);
};

/** The engines, other than Claude, that can work right now, in that order. */
export function presetEngines(readiness: readonly EngineReadiness[]): string[] {
  return othersInOrder().filter((id) => readiness.find((e) => e.id === id)?.roles.worker.ok).slice(0, CHAIN_MAX);
}

const everyRole = (chain: Chain): Partial<Record<RoleId, Chain>> => Object.fromEntries(ROLE_IDS.map((r) => [r, chain.map((c) => ({ ...c }))]));
const chainOf = (ids: string[]): Chain => ids.map((engine) => ({ engine, model: "" }));

const engineTitle = (id: string): string => agentProvider(id)?.title ?? id;

/**
 * "The chair stays Claude Code" is a claim about the chair, and this preset sets
 * workers only, so it holds only if the chair already is that engine: the base
 * chair, and no rule of the person's that moves it. `policy` is null where a
 * card is drawn with no policy at hand, and then nothing is checked.
 */
function chairIsClaude(policy: Policy): { blocked: string } | null {
  const base = policy.base.orchestrator.value[0]?.engine;
  if (base && base !== CLAUDE) return { blocked: `The chair is ${engineTitle(base)}, not ${claudeTitle()}; set the chair first.` };
  for (const r of policy.rules) {
    const to = r.enabled ? r.orchestrator?.[0]?.engine : undefined;
    if (to && to !== CLAUDE) return { blocked: `Rule "${r.name}" moves the chair to ${engineTitle(to)}; edit it first.` };
  }
  return null;
}

/** The rule a preset adds, or why it cannot be built on this machine. */
function presetRule(id: PresetId, readiness: readonly EngineReadiness[] | null, policy: Policy | null): { rule: PolicyRule } | { blocked: string } {
  if (!readiness) return { blocked: "Checking this machine." };
  const need = (): { blocked: string } | null => {
    if (presetEngines(readiness).length) return null;
    const order = othersInOrder();
    const first = order.find((id) => readiness.find((e) => e.id === id)?.found);
    const why = first ? blockedClause(first, "worker", readiness) : `${agentProvider(order[0] ?? "")?.title ?? "No other engine"} is not installed`;
    return { blocked: `Needs an engine besides ${claudeTitle()} that can work: ${why}.` };
  };
  const claudeWorks = (role: "orchestrator" | "worker"): { blocked: string } | null =>
    readiness.find((e) => e.id === CLAUDE)?.roles[role].ok ? null : { blocked: `${blockedClause(CLAUDE, role, readiness)}.` };

  if (id === "all-on-claude") {
    const b = claudeWorks("worker");
    if (b) return b;
    return { rule: { id: presetRuleId(id), name: `Quick setup: all workers on ${claudeTitle()}`, enabled: true, when: [{ kind: "always" }], workers: everyRole(chainOf([CLAUDE])) } };
  }
  const b = (id === "claude-orchestrates" ? claudeWorks("orchestrator") ?? (policy ? chairIsClaude(policy) : null) : null) ?? need();
  if (b) return b;
  const others = chainOf(presetEngines(readiness));
  if (id === "claude-orchestrates") {
    return { rule: { id: presetRuleId(id), name: `Quick setup: ${claudeTitle()} orchestrates`, enabled: true, when: [{ kind: "always" }], workers: everyRole(others) } };
  }
  return { rule: {
    id: presetRuleId(id), name: `Quick setup: save my ${claudeTitle()} plan`, enabled: true,
    when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: PLAN_NEARLY_SPENT }],
    workers: { builder: others },
  } };
}

const PRESET_TITLE: Record<PresetId, () => string> = {
  "claude-orchestrates": () => `${claudeTitle()} orchestrates, others work`,
  "all-on-claude": () => `All workers on ${claudeTitle()}`,
  "save-my-plan": () => `Save my ${claudeTitle()} plan`,
};

export interface PresetOffer { id: PresetId; title: string; says: string[]; blocked: string | null; confirm: string; ruleName: string | null; active: boolean }

/** What each card says it will set, in plain words, and why it cannot apply if it cannot. */
export function presetOffers(readiness: readonly EngineReadiness[] | null, policy: Policy | null = null): PresetOffer[] {
  return PRESET_IDS.map((id) => {
    const title = PRESET_TITLE[id]();
    const built = presetRule(id, readiness, policy);
    const confirm = `Applying adds one rule; nothing already running is moved. "${BACK_LABEL}" undoes it while nothing else has changed.`;
    if ("blocked" in built) return { id, title, says: [], blocked: built.blocked, confirm, ruleName: null, active: false };
    const active = !!policy && presetInForce(policy, id, readiness);
    const line = `${ruleLine(built.rule)} ${CHAIN_TAIL}`;
    const says = id === "claude-orchestrates" ? [`The chair stays ${claudeTitle()}.`, line]
      : id === "save-my-plan" ? [line, "Scouts and verifiers keep the engines they have."]
      : [line];
    return { id, title, says, blocked: null, confirm, ruleName: built.rule.name, active };
  });
}

/**
 * True when applying the preset would change nothing: the policy already holds
 * exactly the rule it would write, in the place it would put it. Applying such
 * a preset must not save, or the way back recorded by the first press is lost
 * to a write that did nothing.
 */
export function presetInForce(p: Policy, id: PresetId, readiness: readonly EngineReadiness[] | null): boolean {
  const next = applyPreset(p, id, readiness);
  return !!next && JSON.stringify(next) === JSON.stringify(p);
}

/** Where a preset's rule lives, in the words the card uses: a project's folder name, or every project. */
export const scopeWords = (root: string): string =>
  root === "" ? "all projects" : root.split("/").filter(Boolean).pop() ?? root;

/** The one line under Quick setup after a press: what changed, and where the rule is. */
export const appliedLine = (ruleName: string, changed: boolean): string =>
  changed ? `Added rule "${ruleName}".` : `Already active, so nothing changed. The rule is "${ruleName}".`;

/**
 * The policy with a preset's rule added, or null when it cannot apply here.
 * The usage rule goes first so it wins over a rule that always holds; the
 * always rules go last so the person's own rules still come before them. A
 * preset already there is replaced, never doubled.
 */
export function applyPreset(p: Policy, id: PresetId, readiness: readonly EngineReadiness[] | null): Policy | null {
  const built = presetRule(id, readiness, p);
  if ("blocked" in built) return null;
  const drop = new Set<string>(ALWAYS_PRESETS.includes(id) ? ALWAYS_PRESETS.map(presetRuleId) : [presetRuleId(id)]);
  const rest = p.rules.filter((r) => !drop.has(r.id));
  return { ...p, rules: ALWAYS_PRESETS.includes(id) ? [...rest, built.rule] : [built.rule, ...rest] };
}

/**
 * What "Back to what it was" holds: the rules before a preset, the ids the
 * preset put there, and the whole stored policy as applying left it. Going
 * back never posts the old policy: that would write a later change to a role,
 * the envelope or a limit back with it. It removes what was added and puts the
 * earlier rules in their order, on the policy as it is now.
 *
 * Only the latest apply is kept: apply A, then B, and the way back undoes B.
 */
export interface Back { rulesBefore: PolicyRule[]; added: string[]; after: string; title: string }
export const BACK_GONE = "Changed since — edit the rule below instead.";
export function backOf(before: Policy, next: Policy, title: string): Back {
  const was = new Map(before.rules.map((r) => [r.id, JSON.stringify(r)]));
  const added = next.rules.filter((r) => was.get(r.id) !== JSON.stringify(r)).map((r) => r.id);
  return { rulesBefore: before.rules, added, after: JSON.stringify(next), title };
}
/** Offered only while the policy is exactly what applying produced, every field of it. */
export const backAvailable = (b: Back | null, now: Policy): b is Back => !!b && JSON.stringify(now) === b.after;
/** The policy as it is now, minus the rules a preset added, with the earlier rules in their old order. */
export function undoPolicy(now: Policy, b: Back): Policy {
  const added = new Set(b.added);
  const keep = new Map(now.rules.filter((r) => !added.has(r.id)).map((r) => [r.id, r]));
  const rules = b.rulesBefore.map((r) => keep.get(r.id) ?? r);
  const known = new Set(rules.map((r) => r.id));
  return { ...now, rules: [...rules, ...now.rules.filter((r) => !added.has(r.id) && !known.has(r.id))] };
}

// ── check my setup ───────────────────────────────────────────────────────

export interface SetupCheck {
  chair: string;
  roles: { id: RoleId; line: string }[];
  rules: { id: string; name: string; line: string }[];
}

/**
 * Whether a rule holds in one scope. Preset ids are fixed, so the global policy
 * and a project's own share them; a state of another scope is not this rule's.
 */
export const ruleHolds = (states: readonly PolicyRuleState[], scope: string) => (id: string): boolean =>
  states.some((s) => s.scope === scope && s.ruleId === id && s.active);

const stop = (s: string): string => (s.endsWith(".") ? s : `${s}.`);
/** Who a resolved field names, as the name only. */
const whoWords = (r: Resolved): string => (r.ok ? choiceWords(r.choice) : "nobody");

/** The claim in the claude-orchestrates preset's name, checked against the answer. */
function chairNote(rule: PolicyRule, now: Resolution): string {
  if (rule.id !== presetRuleId("claude-orchestrates") || !now.orchestrator.ok || now.orchestrator.choice.engine === CLAUDE) return "";
  return ` ${claudeTitle()} orchestrates, but the chair would be ${engineTitle(now.orchestrator.choice.engine)}.`;
}

/**
 * A rule that holds is first-rule-wins per field, so an earlier rule can keep
 * its fields. Says which fields this one wins and who wins the rest.
 */
function holdingLine(rule: PolicyRule, now: Resolution): string {
  const named: { field: Resolved; words: string }[] = [];
  if (rule.orchestrator) named.push({ field: now.orchestrator, words: "the chair" });
  for (const id of ROLE_IDS) if (rule.workers?.[id]) named.push({ field: now.workers[id], words: rolePlural(id) });
  const lost = named.filter((n) => n.field.from !== "rule" || n.field.ruleId !== rule.id);
  if (!lost.length) return "It holds now, so it is already in the answers above.";
  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const first = [...new Set(lost.map((n) => (n.field.from === "rule" ? `"${n.field.ruleName ?? n.field.ruleId}"` : "the base")))];
  const kept = list(named.filter((n) => !lost.includes(n)).map((n) => n.words));
  const loses = `${list(first)} comes first for ${list(lost.map((n) => n.words))}`;
  return kept ? `It holds now and applies to ${kept}; ${loses}.` : `It holds now, but it does not apply: ${loses}.`;
}

/**
 * A dry run: who would sit in the chair and which engine each role would use
 * right now, and what each rule would change if it held. It reads the policy,
 * the rules' switches and the readings it is handed, and nothing else: no
 * request, no write, nothing started.
 */
export function checkSetup(policy: Policy, states: readonly PolicyRuleState[], readiness: readonly EngineReadiness[] | null, scope = "global"): SetupCheck {
  if (!readiness) return { chair: "This machine has not been checked yet, so there is nothing to tell.", roles: [], rules: [] };
  const holds = ruleHolds(states, scope);
  const now = resolve(policy, { on: holds }, readiness);

  const chair = !now.orchestrator.ok ? `Nobody could sit in the chair: ${stop(now.orchestrator.why)}`
    : `${choiceWords(now.orchestrator.choice)} would sit in the chair${now.orchestrator.from === "rule" ? `, from rule "${now.orchestrator.ruleName ?? now.orchestrator.ruleId}"` : ""}.`;
  const roles = ROLE_IDS.map((id) => {
    const r = now.workers[id];
    const who = rolePlural(id).replace(/^./, (c) => c.toUpperCase());
    if (!r.ok) return { id, line: `${who} would have nobody: ${stop(r.why)}` };
    const via = r.from === "rule" ? `, from rule "${r.ruleName ?? r.ruleId}"` : "";
    return { id, line: `${who} would run on ${choiceWords(r.choice)}${via}.` };
  });

  const rules = policy.rules.map((rule) => {
    if (rule.enabled && holds(rule.id)) return { id: rule.id, name: rule.name, line: `${holdingLine(rule, now)}${chairNote(rule, now)}` };
    const trial = { ...policy, rules: policy.rules.map((r) => (r.id === rule.id ? { ...r, enabled: true } : r)) };
    const then = resolve(trial, { on: (id) => id === rule.id || holds(id) }, readiness);
    const moves: string[] = [];
    if (whoWords(now.orchestrator) !== whoWords(then.orchestrator)) moves.push(`the chair would move from ${whoWords(now.orchestrator)} to ${whoWords(then.orchestrator)}`);
    for (const id of ROLE_IDS) {
      if (whoWords(now.workers[id]) !== whoWords(then.workers[id])) moves.push(`${rolePlural(id)} would move from ${whoWords(now.workers[id])} to ${whoWords(then.workers[id])}`);
    }
    const what = moves.length ? `${moves.join("; ")}.` : "nothing would change.";
    return { id: rule.id, name: rule.name, line: rule.enabled ? `If it held: ${what}` : `It is off. If it were on and held: ${what}` };
  });
  return { chair, roles, rules };
}

// ── which scope the page opens on ─────────────────────────────────────────

/**
 * The scope the page opens on: the one last chosen in this window while it is
 * still on offer ("" is All projects and always is), else the project the app
 * is showing, else All projects. A project that has gone from the list is not
 * opened on, so a stale choice never reads as an empty setting.
 */
export function openingScope(stored: string | null, projects: readonly string[], current: string | null): string {
  if (stored !== null && (stored === "" || projects.includes(stored))) return stored;
  return current && projects.includes(current) ? current : "";
}
export const OWN_SETTING = "has its own setting";
