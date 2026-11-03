/*
 * What the orchestrator's card says, as plain data: the chair the policy gives
 * it, who is in it, the plan it runs on, how many workers are flying now, what
 * today has cost, the last settled line and the roles waiting in the team. Pure
 * and request-free, so the words are asserted without a renderer and the card
 * only paints this.
 *
 * Its ceiling, stated: no counts means no live reading. The card draws "—" and
 * never a zero it did not read; D4's `flowLive.ts` hands the counts in later,
 * and until then nothing here invents one.
 */
import type { Flow } from "../../../shared/flow.ts";
import { usageProvider, type UsageProviderId } from "../../../shared/orchestration.ts";
import type { ReviewWho } from "../../../shared/reviewSettings.ts";
import { engineName } from "../components/orchestration/flow/flowScreenCopy.ts";
import type { LiveCounts } from "./workerCardView.ts";

export interface OrchestratorCardData {
  /** Engine and model the policy gives the chair; null while the policy is being read. */
  chair: { engine: string; model: string } | null;
  /** The seat route's answer: the agent's name, or null for an empty chair. Absent: not read. */
  seat?: { name: string | null } | null;
  /** What is left of each plan, by usage provider (`anthropic`, `codex`) as the page read it; the chair's engine maps to its own. */
  planLeft?: Partial<Record<UsageProviderId, number>> | null;
  /** The policy's `limits.maxWorkers`: the most that may fly at once. */
  maxWorkers: number | null;
  /** The board's most recent settled line (D4's `lastDecision`), or absent. */
  last?: string | null;
  /** `orchestration.review.who`: what the orchestrator does with code. */
  codeWho?: ReviewWho | null;
  /** The project's pilot (`flightPlan.pilot`), already in the chip's words; absent: the chip is not drawn. */
  pilotWord?: string;
  /** The board's rows by role; absent until D4 answers. */
  counts?: LiveCounts | null;
}

export interface OrchestratorTeamDot {
  name: string;
  hue: string;
}

export interface OrchestratorCardModel {
  /** "In the chair", "Nobody in the chair", or "—" when the seat route has not answered. */
  stateWord: string;
  /** What that tag means, and only what the route answered. */
  stateTip: string;
  seatWord: string | null;
  /** The engine and model the chair runs: "Claude Code · sonnet", or "—". */
  chairWord: string;
  /** Workers flying now, and the policy's cap: "1 of 3", or "—". */
  flight: string;
  flightTip: string;
  plan: string;
  planTip: string;
  today: string;
  todayTip: string;
  /** The board's last settled line, or "—". */
  last: string;
  lastTip: string;
  /** What the orchestrator does with code, in one sentence. */
  code: string;
  /** "Co-pilot" / "Manual" / "Autopilot", or "" when no pilot was read. */
  pilotWord: string;
  /** The roles off the path: the dots, and how many there are. */
  team: OrchestratorTeamDot[];
  teamWord: string;
}

/** What the three answers mean, in the words the sheet and the card both use. */
export const CODE_WORD: Record<ReviewWho, string> = {
  never: "Never reads code or runs tests: every change arrives as a report.",
  second: "Reads the diff after the Reviewer, before passing it on.",
  is: "Reads the diff itself and sends its findings back.",
};

export const codeWord = (who: ReviewWho | null | undefined): string => (who ? CODE_WORD[who] : "—");

const money = (n: number): string => `$${n.toFixed(2)}`;

/** The plan's share used, 0–100, or null when nothing read that plan. */
function planUsed(d: OrchestratorCardData): number | null {
  const engine = d.chair?.engine;
  const left = engine ? d.planLeft?.[usageProvider(engine)] : undefined;
  if (typeof left !== "number") return null;
  return Math.min(100, Math.max(0, Math.round(100 - left)));
}

function flying(d: OrchestratorCardData): number | null {
  if (!d.counts) return null;
  let n = 0;
  for (const c of Object.values(d.counts)) n += c.run;
  return n;
}

function spend(d: OrchestratorCardData): number | null {
  if (!d.counts) return null;
  let total = 0;
  for (const c of Object.values(d.counts)) total += c.cost;
  return total;
}

export function orchestratorCardModel(flow: Flow, d: OrchestratorCardData): OrchestratorCardModel {
  const n = flying(d);
  const cost = spend(d);
  const used = planUsed(d);
  const of = d.maxWorkers;
  const team = flow.roster.filter((r) => !flow.path.includes(r.id)).map((r) => ({ name: r.name, hue: r.hue }));
  return {
    stateWord: !d.seat ? "—" : d.seat.name ? "In the chair" : "Nobody in the chair",
    stateTip: !d.seat ? "The seat has not been read yet" : d.seat.name ? `The chair is ${d.seat.name}'s` : "Nobody is seated in this project right now",
    seatWord: d.seat?.name ?? null,
    chairWord: d.chair ? `${engineName(d.chair.engine)} · ${d.chair.model || "its default"}` : "—",
    flight: n === null ? "—" : of === null ? String(n) : `${n} of ${of}`,
    flightTip: n === null ? "The board has not answered yet" : `${n} working now; the policy lets ${of ?? "?"} fly at once. Not a queue: the app has none.`,
    plan: used === null ? "—" : `${used}%`,
    planTip: used === null ? "No reading of the plan this cluster runs on" : "What the plan has spent so far, as the page last read it",
    today: cost === null ? "—" : money(cost),
    todayTip: cost === null ? "No cost has been read" : "What the board's rows for this project have cost",
    last: d.last ?? "—",
    lastTip: d.last ? "The most recent thing a worker settled" : "Nothing has settled since the board last read",
    code: codeWord(d.codeWho),
    pilotWord: d.pilotWord ?? "",
    team,
    teamWord: team.length ? `${team.length} in the team` : "the whole team is on the path",
  };
}
