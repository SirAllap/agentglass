/*
 * What a worker card says, as plain data: the step's place, the chain it runs
 * on, the tries its own failing arrow allows, the live numbers the board
 * reports, and the words for both. Pure and request-free, so the card is
 * asserted without a renderer and the card component only paints this.
 *
 * The tries on the card are the fail edge's `maxRounds`, not the project's
 * review cap (`orchestration.review.rounds`): the reviewing block's arrow is
 * one arrow among many, and a card that printed the project setting on every
 * block would name a number the arrow it describes does not have.
 *
 * Its ceiling, stated: no counts means no live reading. The card draws "—" and
 * never a zero it did not read.
 */
import type { Flow, FlowRole } from "../../../shared/flow.ts";
import type { Chain } from "../../../shared/orchestration.ts";
import { failWord, fullChain, passWord, stageLabel } from "../components/orchestration/flow/flowScreenCopy.ts";

/** What one role is doing now, as the board reports it. D4's `flowLive.ts` produces this shape. */
export interface RoleCounts {
  /** Rows of this role working. */
  run: number;
  /** Rows waiting on a person. Never a queue: the app has none. */
  wait: number;
  /** The cost of the rows of this role, in the plan's money. */
  cost: number;
}

export type LiveCounts = Readonly<Record<string, RoleCounts>>;

export type WorkerTone = "run" | "wait" | "idle";

export interface WorkerChainStep {
  engine: string;
  model: string;
  first: boolean;
}

export interface WorkerCardModel {
  /** 1-based place on the path, or null when the role is only in the team. */
  step: number | null;
  stepWord: string;
  required: boolean;
  /** The lock's sentence, when the role carries one. */
  requiredWord: string | null;
  requiredTip: string;
  /** Null when no counts were handed in: the card says nothing about now. */
  tone: WorkerTone | null;
  liveWord: string | null;
  chain: WorkerChainStep[];
  chainWord: string;
  /** The fail edge's rounds, and only that. Null when the role has no fail edge. */
  attempts: { of: number; word: string } | null;
  pass: string;
  fail: string;
  failTip: string;
  cost: string;
  readsOnly: boolean;
  /** The warning a mark carries (an engine that is not installed), if any. */
  warn: string | null;
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function workerCardModel(flow: Flow, role: FlowRole, counts?: LiveCounts | null, chainOverride?: Chain | null): WorkerCardModel {
  const at = flow.path.indexOf(role.id);
  const c = counts?.[role.id] ?? null;
  const onPath = at >= 0;
  const ranOn = chainOverride ?? role.resolvedChain ?? role.chain;
  const chain = ranOn.map((s, i) => ({ engine: s.engine, model: s.model, first: i === 0 }));
  const edge = flow.edges.find((e) => e.on === "fail" && e.from === role.id);
  const rounds = edge?.maxRounds ?? null;
  const fail = failWord(flow, role.id);
  const person = role.actor === "person";
  const required = onPath && role.required;
  const tone: WorkerTone | null = !c ? null : c.run > 0 ? "run" : c.wait > 0 ? "wait" : "idle";
  return {
    step: onPath ? at + 1 : null,
    stepWord: onPath ? `${at + 1} of ${flow.path.length}` : "in the team",
    required,
    requiredWord: required ? "Required" : null,
    requiredTip: required
      ? "The orchestrator is told this one cannot be skipped: a plan cannot land without a passing result."
      : onPath
        ? "The orchestrator may skip it when the job does not need it."
        : "Only a step on the path can be required.",
    tone,
    liveWord: !c ? null : c.run > 0 ? `Running${c.run > 1 ? ` ×${c.run}` : ""}` : c.wait > 0 ? "Waiting on you" : "Idle",
    chain,
    chainWord: chain.length ? fullChain(ranOn) : "A person answers here · nothing runs",
    attempts: rounds === null ? null : { of: rounds, word: plural(rounds, "try", "tries") },
    pass: passWord(flow, role.id),
    fail: fail.to ? fail.to.name : "asks you",
    failTip: fail.to ? `When it fails the work goes back to ${fail.to.name}${rounds ? `, at most ${plural(rounds, "time", "times")}, then it asks you` : ""}` : "When it fails it asks you.",
    cost: !c || person ? "—" : money(c.cost),
    readsOnly: role.readsOnly,
    warn: null,
  };
}

/** The card as a block of text, for "Copy settings as text". */
export function workerCardText(flow: Flow, role: FlowRole, counts?: LiveCounts | null): string {
  const m = workerCardModel(flow, role, counts);
  return [
    `${role.name} — ${stageLabel(flow, role.stage)}${m.step ? ` · step ${m.step} of ${flow.path.length}` : " · in the team"}`,
    role.does,
    `Runs on ${m.chain.length ? m.chainWord : "a person"}`,
    `Passes to ${m.pass}`,
    `Fails to ${m.fail}${m.attempts ? ` · ${m.attempts.word}` : ""}`,
    `${m.required ? "Required: the orchestrator cannot skip it." : "May be skipped by the orchestrator."}`,
    `${m.readsOnly ? "Reads only." : "Writes in its own copy."}`,
  ].join("\n");
}
