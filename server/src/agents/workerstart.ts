/*
 * Who may start what, and with which permissions: the decision half of
 * "start a worker through the policy".
 *
 * Pure: the policy, which rules are on, what this machine can run and how many
 * workers the seat already has come in; a plan or a sentence comes out. Every
 * refusal names the thing refused and what to do next, and nothing is dropped
 * silently: an argument that cannot be honoured is a refusal, never a quiet
 * default. The engine is chosen by the policy and the orchestrator picks only
 * inside it; the envelope starts at the narrow default and may be widened only
 * to the person's ceiling, and never to a remote effect (envelope.ts).
 */
import { agentProvider } from "../../../shared/agentKinds.ts";
import { chainFor, envelopeWithin, resolve, type Chain, type Envelope, type EngineChoice, type Policy, type RuleFacts } from "../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../shared/types.ts";
import { workerRole, type WorkerRole } from "../../../shared/workerRoles.ts";
import { headlessRefusal } from "./headless.ts";

/** What a start stamps on the row: who chose, and why. */
export interface StartedBy {
  scope: "project" | "global";
  /** The rule's name, or "base" when no rule decided. */
  rule: string;
  ruleId?: string;
  because: string[];
  position: number;
  role: string;
  engine: string;
  model: string;
  envelope: Envelope;
  /** Always true here: a row with this field is a headless, policy-started worker. */
  headless: true;
  /** The turn limit this turn runs under. */
  turnMinutes?: number;
  /** Which turn of this worker the row is on: 1 for a start, one more for
   *  every instruction after it. Only a first turn can move to another engine. */
  turn?: number;
  /** The server restarted during this turn, so its limit is no longer
   *  enforced (ceilings.ts). Cleared by the next turn, which has its own. */
  ceilingLost?: true;
  /** How many times a first-turn failure moved it to the next engine in the chain. */
  retries?: number;
  /** The engine it was moved off, once it has been. */
  from?: string;
}

export interface WorkerAsk {
  role: unknown;
  engine?: unknown;
  model?: unknown;
  allow?: unknown;
}

export type Plan =
  | { ok: true; role: WorkerRole; choice: EngineChoice; envelope: Envelope; startedBy: StartedBy }
  | { ok: false; error: string; /** Raise it as a need for the person: the chain ran out. */ need?: true };

const ALLOWS = ["network", "commit"] as const;

const label = (c: EngineChoice): string => {
  const t = agentProvider(c.engine)?.title ?? c.engine;
  return c.model ? `${t} (${c.model})` : t;
};
const list = (chain: Chain): string => chain.map(label).join(", ") || "none";

export function planWorker(
  ask: WorkerAsk,
  view: { policy: Policy; scope: "project" | "global" },
  facts: RuleFacts,
  readiness: readonly EngineReadiness[],
  /** Live workers this seat already owns; null when a person (not a seat) asks. */
  liveForSeat: number | null,
): Plan {
  const role = workerRole(ask.role);
  if (!role) return { ok: false, error: "no such role" };
  const { policy } = view;

  const allow = new Set<string>();
  if (ask.allow !== undefined) {
    if (!Array.isArray(ask.allow)) return { ok: false, error: "allow: a list of network and commit" };
    for (const a of ask.allow) {
      if (!(ALLOWS as readonly unknown[]).includes(a)) {
        return { ok: false, error: `--allow ${String(a)}: a worker can be allowed network or commit, nothing else. Pushing, posting, merging and spending are never granted to a worker.` };
      }
      allow.add(a as string);
    }
  }
  const envelope: Envelope = {
    ...policy.workerDefault,
    network: policy.workerDefault.network || allow.has("network"),
    commit: policy.workerDefault.commit || allow.has("commit"),
  };
  for (const a of ALLOWS) {
    if (allow.has(a) && !policy.ceiling[a]) {
      return { ok: false, error: `--allow ${a} is beyond this project's ceiling (Settings ▸ Orchestration): ${a === "commit" ? "workers may not commit here" : "workers may not use the network here"}. Nothing was started.` };
    }
  }
  if (!envelopeWithin(envelope, policy.ceiling)) {
    return { ok: false, error: "the envelope asked for is wider than this project's ceiling. Nothing was started." };
  }

  if (liveForSeat !== null && liveForSeat >= policy.limits.maxWorkers) {
    return { ok: false, error: `${liveForSeat} workers are already running for this seat and the limit is ${policy.limits.maxWorkers}. Stop one or wait for one to finish.` };
  }

  if (ask.model !== undefined && typeof ask.model !== "string") return { ok: false, error: "model: a model name from the chain" };
  const chain = chainFor(policy, facts, role.id);
  const resolved = resolve(policy, facts, readiness).workers[role.id];
  let choice: EngineChoice;
  let because: string[];
  let position: number;
  let rule: { name: string; id?: string };

  if (ask.engine !== undefined) {
    if (typeof ask.engine !== "string") return { ok: false, error: "engine: a name from the chain" };
    const at = chain.findIndex((c) => c.engine === ask.engine && (typeof ask.model !== "string" || c.model === ask.model));
    if (at < 0) {
      const what = typeof ask.model === "string" ? `${ask.engine} (${ask.model})` : ask.engine;
      return { ok: false, error: `${what} is not in the chain for the ${role.id} role here: ${list(chain)}. The policy decides the choices; change it in Settings, not in the start.` };
    }
    choice = chain[at]!;
    position = at;
    const r = readiness.find((e) => e.id === choice.engine);
    if (!r) return { ok: false, error: `${label(choice)}: this machine has not been checked for it yet. Open Settings ▸ Agent engines.` };
    if (!r.roles.worker.ok) return { ok: false, error: `${label(choice)} cannot take the worker role here: ${r.roles.worker.why ?? "not ready"}` };
    because = [`asked for ${label(choice)}, which is in the chain`];
    rule = { name: resolved.ruleName ?? "base", id: resolved.ruleId };
  } else {
    if (ask.model !== undefined) return { ok: false, error: "model: it goes with an engine from the chain; say which with --engine" };
    if (!resolved.ok) return { ok: false, error: `no worker can start: ${resolved.why}`, need: true };
    if (resolved.ask) {
      const ready = chain.filter((c) => readiness.find((e) => e.id === c.engine)?.roles.worker.ok);
      return { ok: false, error: `this role is set to ask which engine to use: pick one with --engine. Ready now: ${list(ready)}.` };
    }
    choice = resolved.choice;
    position = resolved.position;
    because = resolved.because;
    rule = { name: resolved.ruleName ?? "base", id: resolved.ruleId };
  }

  const why = headlessRefusal(choice.engine);
  if (why) return { ok: false, error: why };

  return {
    ok: true, role, choice, envelope,
    startedBy: {
      scope: view.scope, rule: rule.name, ...(rule.id ? { ruleId: rule.id } : {}), because, position,
      role: role.id, engine: choice.engine, model: choice.model, envelope, headless: true, turn: 1,
    },
  };
}

/**
 * Where a worker goes when its first turn failed before doing anything: the
 * next usable entry of its role's chain AS IT IS NOW, after the entry it was
 * on. The chain can have changed since the start (a rule went on or off), so
 * the place is found by the engine and never by the number stamped then, and
 * an engine it has already been on is never picked again. A role the person
 * set to ask is not chosen for them.
 */
export function nextEngine(p: {
  chain: readonly EngineChoice[]; by: Pick<StartedBy, "engine" | "model" | "from">;
  /** The role is set to "Ask when it runs". */
  ask: boolean; usable: (c: EngineChoice) => boolean;
}): { ok: true; choice: EngineChoice; position: number } | { ok: false; why: string } {
  if (p.ask) return { ok: false, why: "this role is set to ask which engine to use, so the next one was not picked for it" };
  const tried = new Set([p.by.engine, ...(p.by.from ? [p.by.from] : [])]);
  const at = p.chain.findIndex((c) => c.engine === p.by.engine && c.model === p.by.model);
  for (let i = at + 1; i < p.chain.length; i++) {
    const c = p.chain[i]!;
    if (!tried.has(c.engine) && p.usable(c)) return { ok: true, choice: c, position: i };
  }
  return { ok: false, why: "no other engine in the chain is ready" };
}
