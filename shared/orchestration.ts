/*
 * The orchestration policy: which engine and model sits in a project's chair,
 * which ones do the work it hands out, and when that changes.
 *
 * Types, a closed-schema validator and one pure resolver. Nothing here reads a
 * file or a clock, so every rule is asserted without a server.
 *
 * ── what is NOT here, on purpose ─────────────────────────────────────────
 * No string field can hold a credential. Every string is an engine id from the
 * table, a model name, a label or a command prefix, each checked against a
 * pattern AND against the shape of a key (`looksLikeSecret`); the rest are
 * numbers, booleans and fixed words. Provider keys stay where each CLI keeps
 * them, and this file never learns their names.
 *
 * No field grants a remote effect. `Envelope` has `commit` and `network`, and
 * nothing for push, pull request, merge, release or spend. What cannot be
 * written down cannot be granted by mistake.
 *
 * Ceilings of this first cut, stated so they read as chosen and not missed:
 * a project override replaces the global policy whole (no field-by-field
 * inheritance); the base is ONE choice per field (the app's own settings hold
 * one), so a fallback chain lives in a rule; two accounts of one provider on
 * one machine are not told apart.
 */
import { agentProvider } from "./agentKinds.ts";
import { WORKER_ROLES, type RoleId } from "./workerRoles.ts";
import type { EngineReadiness, ProviderUsage } from "./types.ts";

export type EngineId = string;
export interface EngineChoice { engine: EngineId; model: string }
/** Tried in order. */
export type Chain = EngineChoice[];
/** "Ask when it runs": the default is preselected, and a person may pick. */
export interface AskOr<T> { value: T; ask: boolean }

export type UsageProviderId = ProviderUsage["provider"];
/** The providers that report a quota window. Antigravity reports none, so a
 *  rule cannot watch it and the validator says so. */
export const GAUGED_PROVIDERS: readonly UsageProviderId[] = ["anthropic", "codex"];

export type Trigger =
  | { kind: "always" }
  | { kind: "usage"; provider: UsageProviderId; window: "5h" | "weekly" | "either"; remainingAtMost: number }
  | { kind: "limit"; provider: UsageProviderId }
  | { kind: "hours"; days: number[]; from: string; to: string }
  | { kind: "budget" };

export interface PolicyRule {
  id: string;
  name: string;
  /** All must hold. Never empty: the base is the "always" of a policy that
   *  says nothing, and a rule that should always apply says `always`. */
  when: Trigger[];
  /** Absent: leave the chair alone. */
  orchestrator?: Chain;
  /** An absent role is left alone. */
  workers?: Partial<Record<RoleId, Chain>>;
  enabled: boolean;
}

export interface Envelope {
  /** Never wider than the worker's own worktree. */
  write: "none" | "worktree";
  network: boolean;
  /** Local commits in its own worktree. */
  commit: boolean;
  /** Extra command prefixes on top of DENIED_COMMANDS. Can only add. */
  deny: string[];
}

export interface Policy {
  base: { orchestrator: AskOr<Chain>; workers: Record<RoleId, AskOr<Chain>> };
  /** The first enabled rule whose triggers hold wins, per field. */
  rules: PolicyRule[];
  /** The widest thing an orchestrator may grant here. */
  ceiling: Envelope;
  /** What a worker gets when the orchestrator says nothing. */
  workerDefault: Envelope;
  limits: { maxWorkers: number; turnMinutes: number; maxRetries: number };
}

/** What `config.json` keeps for one scope. The base is not in it: it is read
 *  through from the worker roles and the seat, so there is one copy. */
export interface StoredPolicy {
  rules: PolicyRule[];
  ceiling: Envelope;
  workerDefault: Envelope;
  limits: Policy["limits"];
  ask: { orchestrator: boolean; workers: Record<RoleId, boolean> };
}

export const ROLE_IDS: readonly RoleId[] = WORKER_ROLES.map((r) => r.id);

export const CHAIN_MAX = 4;
export const RULES_MAX = 20;
export const TRIGGERS_MAX = 4;

/** Narrow by default: a worker writes in its own worktree and does nothing
 *  else. The ceiling lets an orchestrator add local commits and nothing more. */
export const DEFAULT_WORKER_ENVELOPE: Envelope = { write: "worktree", network: false, commit: false, deny: [] };
export const DEFAULT_CEILING: Envelope = { write: "worktree", network: false, commit: true, deny: [] };
export const DEFAULT_LIMITS: Policy["limits"] = { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 };

export const defaultStored = (): StoredPolicy => ({
  rules: [],
  ceiling: { ...DEFAULT_CEILING, deny: [] },
  workerDefault: { ...DEFAULT_WORKER_ENVELOPE, deny: [] },
  limits: { ...DEFAULT_LIMITS },
  ask: { orchestrator: false, workers: { scout: false, builder: false, verifier: false } },
});

// ── strings ──────────────────────────────────────────────────────────────

/** A model name as a CLI takes it, `provider/name[tag]` included. */
export const POLICY_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,95}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/'()+-]{0,59}$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._ /-]{0,39}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether a string is shaped like a credential.
 *
 * The patterns above admit every character a key has, so a pasted key would
 * pass them; this is the second check. Known prefixes, or a long unbroken run
 * mixing letters and digits (no real model name is 32 characters of one word).
 * A shape test, not a guarantee: the guarantee is that no field is free text.
 */
export function looksLikeSecret(s: string): boolean {
  if (/^(sk|pk|rk)[-_]/i.test(s)) return true;
  if (/^(ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29|eyJ)/.test(s)) return true;
  const run = s.match(/[A-Za-z0-9_]{32,}/)?.[0];
  return !!run && /[A-Za-z]/.test(run) && /\d/.test(run);
}

// ── validation ───────────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (field: string, what: string): { ok: false; error: string } => ({ ok: false, error: `${field}: ${what}` });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An object with exactly these keys: an extra one is refused by name, not
 *  dropped, so a typo cannot silently turn a setting off. */
function closed(v: unknown, field: string, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> | { ok: false; error: string } {
  if (!isObj(v)) return bad(field, "has to be an object");
  for (const k of Object.keys(v)) if (!keys.includes(k)) return bad(`${field}.${k}`, "is not a setting; nothing was saved");
  for (const k of required) if (!(k in v)) return bad(`${field}.${k}`, "is missing");
  return v;
}
const failed = (r: unknown): r is { ok: false; error: string } => isObj(r) && r.ok === false && typeof r.error === "string";

function wholeIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

function validModel(v: unknown, field: string): Validated<string> {
  if (typeof v !== "string") return bad(field, "has to be text");
  const m = v.trim();
  if (m === "") return { ok: true, value: "" };
  if (!POLICY_MODEL_RE.test(m)) return bad(field, "is not a model name (letters, digits and . _ : / [ ] -, no spaces or quotes)");
  if (looksLikeSecret(m)) return bad(field, "looks like a key; a model name is all this field takes, and keys stay in the engine's own login");
  return { ok: true, value: m };
}

function validChoice(v: unknown, field: string): Validated<EngineChoice> {
  const o = closed(v, field, ["engine", "model"]);
  if (failed(o)) return o;
  if (typeof o.engine !== "string" || !agentProvider(o.engine)) return bad(`${field}.engine`, "is not an engine agentglass knows");
  const model = validModel(o.model, `${field}.model`);
  if (!model.ok) return model;
  return { ok: true, value: { engine: o.engine, model: model.value } };
}

export function validChain(v: unknown, field: string): Validated<Chain> {
  if (!Array.isArray(v)) return bad(field, "has to be a list of engine and model");
  if (v.length < 1 || v.length > CHAIN_MAX) return bad(field, `needs 1 to ${CHAIN_MAX} entries, it has ${v.length}`);
  const out: Chain = [];
  for (let i = 0; i < v.length; i++) {
    const c = validChoice(v[i], `${field}[${i}]`);
    if (!c.ok) return c;
    if (out.some((o) => o.engine === c.value.engine && o.model === c.value.model)) {
      return bad(`${field}[${i}]`, "repeats an earlier entry; a second try on the same engine and model cannot answer differently");
    }
    out.push(c.value);
  }
  return { ok: true, value: out };
}

function validAskChain(v: unknown, field: string): Validated<AskOr<Chain>> {
  const o = closed(v, field, ["value", "ask"]);
  if (failed(o)) return o;
  if (typeof o.ask !== "boolean") return bad(`${field}.ask`, "has to be true or false");
  const chain = validChain(o.value, `${field}.value`);
  if (!chain.ok) return chain;
  return { ok: true, value: { value: chain.value, ask: o.ask } };
}

export function validEnvelope(v: unknown, field: string): Validated<Envelope> {
  const o = closed(v, field, ["write", "network", "commit", "deny"]);
  if (failed(o)) return o;
  if (o.write !== "none" && o.write !== "worktree") return bad(`${field}.write`, 'has to be "none" or "worktree"; nothing wider exists');
  if (typeof o.network !== "boolean") return bad(`${field}.network`, "has to be true or false");
  if (typeof o.commit !== "boolean") return bad(`${field}.commit`, "has to be true or false");
  if (!Array.isArray(o.deny) || o.deny.length > 40) return bad(`${field}.deny`, "has to be a list of up to 40 command prefixes");
  const deny: string[] = [];
  for (let i = 0; i < o.deny.length; i++) {
    const d = o.deny[i];
    if (typeof d !== "string" || !PREFIX_RE.test(d.trim())) return bad(`${field}.deny[${i}]`, "is not a command prefix (letters, digits, . _ / - and single spaces)");
    if (looksLikeSecret(d.trim())) return bad(`${field}.deny[${i}]`, "looks like a key; this field takes a command prefix");
    if (!deny.includes(d.trim())) deny.push(d.trim());
  }
  return { ok: true, value: { write: o.write, network: o.network, commit: o.commit, deny } };
}

/** Whether `inner` asks for nothing `outer` does not allow. The one test the
 *  ceiling is read with, here and at every start that names `--allow`. */
export function envelopeWithin(inner: Envelope, outer: Envelope): boolean {
  return (outer.write === "worktree" || inner.write === "none")
    && (outer.network || !inner.network)
    && (outer.commit || !inner.commit)
    && outer.deny.every((d) => inner.deny.includes(d));
}

function validTrigger(v: unknown, field: string): Validated<Trigger> {
  if (!isObj(v)) return bad(field, "has to be an object");
  const provider = (p: unknown, at: string): Validated<UsageProviderId> =>
    typeof p === "string" && (GAUGED_PROVIDERS as readonly string[]).includes(p)
      ? { ok: true, value: p as UsageProviderId }
      : bad(at, `has to be one of ${GAUGED_PROVIDERS.join(", ")}; the others report no quota, so a rule cannot watch them`);
  switch (v.kind) {
    case "always": {
      const o = closed(v, field, ["kind"]); if (failed(o)) return o;
      return { ok: true, value: { kind: "always" } };
    }
    case "budget": {
      const o = closed(v, field, ["kind"]); if (failed(o)) return o;
      return { ok: true, value: { kind: "budget" } };
    }
    case "limit": {
      const o = closed(v, field, ["kind", "provider"]); if (failed(o)) return o;
      const p = provider(o.provider, `${field}.provider`); if (!p.ok) return p;
      return { ok: true, value: { kind: "limit", provider: p.value } };
    }
    case "usage": {
      const o = closed(v, field, ["kind", "provider", "window", "remainingAtMost"]); if (failed(o)) return o;
      const p = provider(o.provider, `${field}.provider`); if (!p.ok) return p;
      if (o.window !== "5h" && o.window !== "weekly" && o.window !== "either") return bad(`${field}.window`, 'has to be "5h", "weekly" or "either"');
      if (!wholeIn(o.remainingAtMost, 1, 99)) return bad(`${field}.remainingAtMost`, "has to be a whole number of percent from 1 to 99");
      return { ok: true, value: { kind: "usage", provider: p.value, window: o.window, remainingAtMost: o.remainingAtMost } };
    }
    case "hours": {
      const o = closed(v, field, ["kind", "days", "from", "to"]); if (failed(o)) return o;
      if (!Array.isArray(o.days) || o.days.length < 1 || o.days.length > 7 || !o.days.every((d) => wholeIn(d, 0, 6)) || new Set(o.days).size !== o.days.length) {
        return bad(`${field}.days`, "has to be 1 to 7 different days, 0 for Sunday to 6 for Saturday");
      }
      if (typeof o.from !== "string" || !TIME_RE.test(o.from)) return bad(`${field}.from`, "has to be a local time as HH:MM");
      if (typeof o.to !== "string" || !TIME_RE.test(o.to)) return bad(`${field}.to`, "has to be a local time as HH:MM");
      if (o.from === o.to) return bad(`${field}.to`, "is the same as from; a rule that wants every hour uses always");
      return { ok: true, value: { kind: "hours", days: [...(o.days as number[])].sort((a, b) => a - b), from: o.from, to: o.to } };
    }
    default:
      return bad(`${field}.kind`, 'has to be "always", "usage", "limit", "hours" or "budget"');
  }
}

function validRule(v: unknown, field: string): Validated<PolicyRule> {
  const o = closed(v, field, ["id", "name", "when", "orchestrator", "workers", "enabled"], ["id", "name", "when", "enabled"]);
  if (failed(o)) return o;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return bad(`${field}.id`, "is not a rule id (lowercase letters, digits and -)");
  if (typeof o.name !== "string" || !LABEL_RE.test(o.name.trim())) return bad(`${field}.name`, "has to be a short label of up to 60 characters, without quotes or line breaks");
  if (looksLikeSecret(o.name.trim())) return bad(`${field}.name`, "looks like a key; this is a label for the Lantern and the log");
  if (typeof o.enabled !== "boolean") return bad(`${field}.enabled`, "has to be true or false");
  if (!Array.isArray(o.when) || o.when.length < 1 || o.when.length > TRIGGERS_MAX) return bad(`${field}.when`, `needs 1 to ${TRIGGERS_MAX} triggers`);
  const when: Trigger[] = [];
  for (let i = 0; i < o.when.length; i++) {
    const t = validTrigger(o.when[i], `${field}.when[${i}]`);
    if (!t.ok) return t;
    when.push(t.value);
  }
  const rule: PolicyRule = { id: o.id, name: o.name.trim(), when, enabled: o.enabled };
  if (o.orchestrator !== undefined) {
    const c = validChain(o.orchestrator, `${field}.orchestrator`);
    if (!c.ok) return c;
    rule.orchestrator = c.value;
  }
  if (o.workers !== undefined) {
    const w = closed(o.workers, `${field}.workers`, ROLE_IDS, []);
    if (failed(w)) return w;
    const workers: Partial<Record<RoleId, Chain>> = {};
    for (const r of ROLE_IDS) {
      if (w[r] === undefined) continue;
      const c = validChain(w[r], `${field}.workers.${r}`);
      if (!c.ok) return c;
      workers[r] = c.value;
    }
    if (Object.keys(workers).length) rule.workers = workers;
  }
  if (!rule.orchestrator && !rule.workers) return bad(field, "changes nothing: name an orchestrator chain or at least one worker role");
  return { ok: true, value: rule };
}

/**
 * A whole policy, as a person's settings page or a hand-edited file would
 * hand it over. Closed: an unknown key, a wrong type or an out-of-range number
 * is refused with a sentence that names the field, and nothing is half-kept.
 */
export function validatePolicy(raw: unknown): Validated<Policy> {
  const o = closed(raw, "policy", ["base", "rules", "ceiling", "workerDefault", "limits"]);
  if (failed(o)) return o;

  const b = closed(o.base, "policy.base", ["orchestrator", "workers"]);
  if (failed(b)) return b;
  const orchestrator = validAskChain(b.orchestrator, "policy.base.orchestrator");
  if (!orchestrator.ok) return orchestrator;
  const bw = closed(b.workers, "policy.base.workers", ROLE_IDS);
  if (failed(bw)) return bw;
  const workers = {} as Record<RoleId, AskOr<Chain>>;
  for (const r of ROLE_IDS) {
    const c = validAskChain(bw[r], `policy.base.workers.${r}`);
    if (!c.ok) return c;
    workers[r] = c.value;
  }

  const rest = validParts(o, "policy");
  if (!rest.ok) return rest;
  return { ok: true, value: { base: { orchestrator: orchestrator.value, workers }, ...rest.value } };
}

type Parts = Pick<Policy, "rules" | "ceiling" | "workerDefault" | "limits">;

/** The fields a policy and its stored form share. */
function validParts(o: Record<string, unknown>, at: string): Validated<Parts> {
  if (!Array.isArray(o.rules)) return bad(`${at}.rules`, "has to be a list");
  if (o.rules.length > RULES_MAX) return bad(`${at}.rules`, `holds at most ${RULES_MAX} rules, it has ${o.rules.length}`);
  const rules: PolicyRule[] = [];
  for (let i = 0; i < o.rules.length; i++) {
    const r = validRule(o.rules[i], `${at}.rules[${i}]`);
    if (!r.ok) return r;
    if (rules.some((x) => x.id === r.value.id)) return bad(`${at}.rules[${i}].id`, "is used by an earlier rule");
    rules.push(r.value);
  }

  const ceiling = validEnvelope(o.ceiling, `${at}.ceiling`);
  if (!ceiling.ok) return ceiling;
  const workerDefault = validEnvelope(o.workerDefault, `${at}.workerDefault`);
  if (!workerDefault.ok) return workerDefault;
  if (!envelopeWithin(workerDefault.value, ceiling.value)) {
    return bad(`${at}.workerDefault`, "is wider than the ceiling; lower the default or raise the ceiling on purpose");
  }

  const l = closed(o.limits, `${at}.limits`, ["maxWorkers", "turnMinutes", "maxRetries"]);
  if (failed(l)) return l;
  if (!wholeIn(l.maxWorkers, 1, 12)) return bad(`${at}.limits.maxWorkers`, "has to be a whole number from 1 to 12");
  if (!wholeIn(l.turnMinutes, 1, 240)) return bad(`${at}.limits.turnMinutes`, "has to be a whole number of minutes from 1 to 240");
  if (!wholeIn(l.maxRetries, 0, 5)) return bad(`${at}.limits.maxRetries`, "has to be a whole number from 0 to 5");

  return {
    ok: true,
    value: { rules, ceiling: ceiling.value, workerDefault: workerDefault.value,
      limits: { maxWorkers: l.maxWorkers, turnMinutes: l.turnMinutes, maxRetries: l.maxRetries } },
  };
}

/** What `config.json` holds for one scope, checked the same way. */
export function validateStored(raw: unknown): Validated<StoredPolicy> {
  const o = closed(raw, "policy", ["rules", "ceiling", "workerDefault", "limits", "ask"]);
  if (failed(o)) return o;
  const a = closed(o.ask, "policy.ask", ["orchestrator", "workers"]);
  if (failed(a)) return a;
  if (typeof a.orchestrator !== "boolean") return bad("policy.ask.orchestrator", "has to be true or false");
  const aw = closed(a.workers, "policy.ask.workers", ROLE_IDS);
  if (failed(aw)) return aw;
  const workers = {} as Record<RoleId, boolean>;
  for (const r of ROLE_IDS) {
    if (typeof aw[r] !== "boolean") return bad(`policy.ask.workers.${r}`, "has to be true or false");
    workers[r] = aw[r] as boolean;
  }
  const rest = validParts(o, "policy");
  if (!rest.ok) return rest;
  return { ok: true, value: { ...rest.value, ask: { orchestrator: a.orchestrator, workers } } };
}

// ── composing and splitting ──────────────────────────────────────────────

/** The base the app already holds, with the stored rules and limits on top. */
export function composePolicy(
  stored: StoredPolicy,
  base: { orchestrator: EngineChoice; workers: Record<RoleId, EngineChoice> },
): Policy {
  const workers = {} as Record<RoleId, AskOr<Chain>>;
  for (const r of ROLE_IDS) workers[r] = { value: [base.workers[r]], ask: stored.ask.workers[r] };
  return {
    base: { orchestrator: { value: [base.orchestrator], ask: stored.ask.orchestrator }, workers },
    rules: stored.rules,
    ceiling: stored.ceiling,
    workerDefault: stored.workerDefault,
    limits: stored.limits,
  };
}

/** The part of a policy `config.json` keeps. */
export function storedOf(p: Policy): StoredPolicy {
  const ask = { orchestrator: p.base.orchestrator.ask, workers: {} as Record<RoleId, boolean> };
  for (const r of ROLE_IDS) ask.workers[r] = p.base.workers[r].ask;
  return { rules: p.rules, ceiling: p.ceiling, workerDefault: p.workerDefault, limits: p.limits, ask };
}

// ── resolving ────────────────────────────────────────────────────────────

/** Which rules are on right now. Slice S4 computes it from real readings with
 *  hysteresis; the resolver only asks. */
export interface RuleFacts { on(ruleId: string): boolean }

export type Resolved =
  | { ok: true; choice: EngineChoice; from: "base" | "rule"; ruleId?: string; ruleName?: string; position: number; ask: boolean; because: string[] }
  | { ok: false; why: string; from: "base" | "rule"; ruleId?: string; ruleName?: string; because: string[] };

export interface Resolution {
  orchestrator: Resolved;
  workers: Record<RoleId, Resolved>;
}

const label = (c: EngineChoice): string => {
  const t = agentProvider(c.engine)?.title ?? c.engine;
  return c.model ? `${t} (${c.model})` : t;
};

/** "OpenCode (big-pickle)": an engine and model in a person's words. */
export const choiceLabel = label;

/** What a worker's row remembers of how it was started (`named_agent.started_by`),
 *  as much as a screen draws. The rest of the stamp stays on the server. */
export interface Origin { engine: EngineId; model: string; rule: string; position: number; retries?: number; ceilingLost?: true }

/** The stamp as a row can carry it, or null when the column holds something
 *  else (an old row, a hand edit): never a half-built origin. */
export function originOf(stamp: unknown): Origin | null {
  const s = stamp as Partial<Origin> | null | undefined;
  if (!s || typeof s !== "object" || typeof s.engine !== "string" || !s.engine) return null;
  return {
    engine: s.engine, model: typeof s.model === "string" ? s.model : "",
    rule: typeof s.rule === "string" && s.rule ? s.rule : "base",
    position: typeof s.position === "number" && s.position > 0 ? Math.floor(s.position) : 0,
    ...(typeof s.retries === "number" && s.retries > 0 ? { retries: s.retries } : null),
    ...(s.ceilingLost === true ? { ceilingLost: true as const } : null),
  };
}

/** The one line under a worker's name: which engine, and which decision put it there. */
export function originLine(o: Origin): string {
  const by = o.rule === "base" ? "the base policy" : `rule "${o.rule}"`;
  const bits = [label({ engine: o.engine, model: o.model }), by];
  if (o.position > 0) bits.push(`${["", "", "2nd", "3rd", "4th"][o.position + 1] ?? `${o.position + 1}th`} in the chain`);
  if (o.retries) bits.push("moved after a failed start");
  return bits.join(" · ");
}

/** Walk a chain, skip what this machine cannot run right now, say why. An
 *  engine the probe has not seen is not ready: never a silent guess. */
function pick(chain: Chain, role: "orchestrator" | "worker", readiness: readonly EngineReadiness[]): { choice: EngineChoice; position: number; because: string[] } | { why: string; because: string[] } {
  const because: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]!;
    const r = readiness.find((e) => e.id === c.engine);
    if (!r) {
      because.push(`skipped ${label(c)}: this machine has not been checked for it yet`);
      continue;
    }
    const verdict = r.roles[role];
    if (verdict.ok) return { choice: c, position: i, because };
    because.push(`skipped ${label(c)}: ${verdict.why ?? `it cannot take the ${role} role here`}`);
  }
  return { why: `no engine in the chain is ready: ${because.join("; ")}`, because };
}

function field(
  baseValue: AskOr<Chain>,
  winner: { rule: PolicyRule; chain: Chain } | null,
  role: "orchestrator" | "worker",
  readiness: readonly EngineReadiness[],
): Resolved {
  const chain = winner ? winner.chain : baseValue.value;
  const from = winner ? "rule" as const : "base" as const;
  const who = winner ? { ruleId: winner.rule.id, ruleName: winner.rule.name } : {};
  const r = pick(chain, role, readiness);
  if ("why" in r) return { ok: false, why: r.why, from, ...who, because: r.because };
  const because = [...r.because, winner ? `rule "${winner.rule.name}" is on` : "no rule is on, so the base applies"];
  return { ok: true, choice: r.choice, from, ...who, position: r.position, ask: winner ? false : baseValue.ask, because };
}

/**
 * What the policy says to run right now: per field, the first enabled rule
 * that is on AND names that field, else the base. A rule that only names
 * workers leaves the chair alone. When the winning chain has nothing ready the
 * answer is a refusal that says why; it never falls to an engine the person
 * did not list for that rule.
 */
export function resolve(policy: Policy, facts: RuleFacts, readiness: readonly EngineReadiness[]): Resolution {
  const live = policy.rules.filter((r) => r.enabled && facts.on(r.id));
  const orch = live.find((r) => r.orchestrator);
  const orchestrator = field(policy.base.orchestrator, orch ? { rule: orch, chain: orch.orchestrator! } : null, "orchestrator", readiness);
  const workers = {} as Record<RoleId, Resolved>;
  for (const id of ROLE_IDS) {
    const hit = live.find((r) => r.workers?.[id]);
    workers[id] = field(policy.base.workers[id], hit ? { rule: hit, chain: hit.workers![id]! } : null, "worker", readiness);
  }
  return { orchestrator, workers };
}

/** The chain a role's start may pick from right now: the first rule that is on
 *  and names the role, else the base. What `--engine` is checked against. */
export function chainFor(policy: Policy, facts: RuleFacts, role: RoleId): Chain {
  const hit = policy.rules.find((r) => r.enabled && facts.on(r.id) && r.workers?.[role]);
  return hit ? hit.workers![role]! : policy.base.workers[role].value;
}

// ── words ────────────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PROVIDER_WORD: Record<UsageProviderId, string> = { anthropic: "Claude", codex: "Codex", antigravity: "Antigravity" };

export function triggerSentence(t: Trigger): string {
  switch (t.kind) {
    case "always": return "always";
    case "budget": return "the project's budget is used up";
    case "limit": return `${PROVIDER_WORD[t.provider]} has no plan left in a window`;
    case "usage": {
      const w = t.window === "either" ? "either window" : t.window === "5h" ? "the 5 h window" : "the weekly window";
      return `${PROVIDER_WORD[t.provider]} has ${t.remainingAtMost}% or less left in ${w}`;
    }
    case "hours": {
      const days = t.days.length === 7 ? "every day" : t.days.map((d) => DAYS[d]).join(", ");
      return `${days}, ${t.from} to ${t.to}`;
    }
  }
}

const chainWords = (c: Chain): string => c.map(label).join(", then ");

/** One line a person reads on the Lantern and in the log. */
export function ruleSentence(rule: PolicyRule): string {
  const when = rule.when.map(triggerSentence).join(" and ");
  const parts: string[] = [];
  if (rule.orchestrator) parts.push(`the chair is ${chainWords(rule.orchestrator)}`);
  for (const id of ROLE_IDS) {
    const c = rule.workers?.[id];
    if (c) parts.push(`${id} is ${chainWords(c)}`);
  }
  return `When ${when}: ${parts.join("; ")}.${rule.enabled ? "" : " (off)"}`;
}
