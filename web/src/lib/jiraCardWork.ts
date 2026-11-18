/*
 * What the Jira board shows beside a card from stores the app already feeds, with no request of its own:
 * - the live agent working the card: the fleet App publishes (fleetAgents.ts), matched by the card's key in the
 *   session's title (tabs are named after their card) or in the folder it runs in (a worktree named after it);
 * - the checks on the card's pull request: the readings the server's pull-request watch sends (frame `prchecks`).
 * Nothing read means nothing drawn: no agent, no worker line; no reading, the chip says the checks are not read yet.
 */
import type { PrCheckRollup } from "../../../shared/types.ts";
import type { AgentCard } from "./derive.ts";
import { agentsOf, subscribeAgents } from "./fleetAgents.ts";
import { prRefFromUrl } from "./openPrs.ts";
import { onChecksRead } from "./prWatchStore.ts";
import { ciPlan, listChecksFor, listLoadOf, onListChecks } from "./prListChecks.ts";
import { ensureListLoaded } from "./prBoardLoad.ts";
import { onRollup, peekRollup } from "./prRollupStore.ts";

export interface CardWorker { title: string; status: AgentCard["status"]; cost: number; model: string | null; sessionId: string; /** Its last action, cut to one line: what it is doing now. */ doing?: string; /** Its folder: with the title, how its terminal tab is found. */ cwd?: string | null }

/** Still at it: a session that ended, or sits idle, is not a live worker. */
const LIVE: ReadonlySet<AgentCard["status"]> = new Set(["working", "waiting", "stalled", "errored"]);

export const keyPattern = (key: string): RegExp => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9]|$)`, "i");
const base = (p: string | null): string => (p ? p.replace(/\/+$/, "").split("/").pop() ?? "" : "");

/** The live agent on this card, the most recently seen when several are; null when none. */
/** One line of at most 120 characters, or nothing: a tool call's whole command does not belong in a tooltip. */
export const nowLine = (s: string | undefined): string | undefined => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one ? (one.length > 120 ? `${one.slice(0, 119)}…` : one) : undefined;
};

/** How soon a person should look at a live session: waiting on them (0), stalled or errored (1), working (2). */
export const agentUrgency = (status: string): number => (status === "waiting" ? 0 : status === "stalled" || status === "errored" ? 1 : 2);

export function workerFor(key: string, agents: readonly AgentCard[]): CardWorker | null {
  if (!key) return null;
  const re = keyPattern(key);
  let best: AgentCard | null = null;
  for (const a of agents) {
    if (!LIVE.has(a.status)) continue;
    if (!re.test(a.title ?? "") && !re.test(base(a.cwd))) continue;
    if (!best || a.lastSeen > best.lastSeen) best = a;
  }
  return best ? { title: best.title || best.source_app, status: best.status, cost: best.cost, model: best.model_name, sessionId: best.session_id, doing: nowLine(best.lastAction), cwd: best.cwd } : null;
}

/** Every session that names this card in its title or folder, live or not: what the card's cost is summed over. */
export function sessionsFor(key: string, agents: readonly AgentCard[]): AgentCard[] {
  if (!key) return [];
  const re = keyPattern(key);
  // One session can show up twice (its folder and a tab titled with the key): it is counted once, by session id.
  const seen = new Set<string>();
  return agents.filter((a) => {
    if (!(re.test(a.title ?? "") || re.test(base(a.cwd))) || seen.has(a.session_id)) return false;
    seen.add(a.session_id);
    return true;
  });
}

/**
 * Where "Send to terminal" launches for a card: a session whose folder names the key first, then one whose title does.
 * A review or orchestrator tab titled with the key often runs in the main checkout, which is not the card's.
 */
export function rootFor(key: string, agents: readonly AgentCard[]): string | null {
  if (!key) return null;
  const re = keyPattern(key);
  const withCwd = agents.filter((a) => a.cwd);
  return (withCwd.find((a) => re.test(base(a.cwd))) ?? withCwd.find((a) => re.test(a.title ?? "")))?.cwd ?? null;
}

/** Every card key a live agent names in its title or folder: what the Live worker toggle keeps. Upper-cased. */
export function liveKeys(agents: readonly AgentCard[]): string[] {
  const out = new Set<string>();
  for (const a of agents) if (LIVE.has(a.status)) for (const k of cardKeysOf(a)) out.add(k);
  return [...out];
}

/** The card keys one session names in its title or folder, upper-cased, live or not. */
export function cardKeysOf(a: Pick<AgentCard, "title" | "cwd">): string[] {
  const out = new Set<string>();
  for (const src of [a.title ?? "", base(a.cwd)]) for (const m of src.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*-\d+)/g)) out.add(m[1]!.toUpperCase());
  return [...out];
}

/** How long a session that ended stays listed as just finished: long enough to come back and look at what it did. */
export const FINISHED_MS = 2 * 3_600_000;

/** Cards whose last session ended in the past `FINISHED_MS` and that no live session is on: key, title, when. */
export interface FinishedRun { key: string; title: string; at: number; cost: number }

export function finishedFor(agents: readonly AgentCard[], now: number): FinishedRun[] {
  const live = new Set(liveKeys(agents));
  const best = new Map<string, AgentCard>();
  for (const a of agents) {
    if (LIVE.has(a.status) || now - a.lastSeen > FINISHED_MS) continue;
    for (const k of cardKeysOf(a)) if (!live.has(k) && (!best.has(k) || a.lastSeen > best.get(k)!.lastSeen)) best.set(k, a);
  }
  return [...best].map(([key, a]) => ({ key, title: a.title || a.source_app, at: a.lastSeen, cost: a.cost }));
}

/** Where a card stands with its agents: one waiting on a person, one working, one that ended lately, or none. */
export type AgentState = "needs" | "working" | "finished" | null;

/** The agent state of any card key, read from one look at the fleet (keys upper case, as `cardKeysOf` gives them). */
export function agentStateOf(agents: readonly AgentCard[], now: number): (key: string) => AgentState {
  const ended = new Set(finishedFor(agents, now).map((r) => r.key));
  return (key) => {
    const w = workerFor(key, agents);
    return w ? (w.status === "waiting" ? "needs" : "working") : ended.has(key.toUpperCase()) ? "finished" : null;
  };
}

export const fleetNow = agentsOf;
export const onFleet = subscribeAgents;

/* ---------- checks ---------- */

const reads = new Map<string, { checks: PrCheckRollup; at: number }>();
const subs = new Set<() => void>();
let version = 0;
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  // A per-PR rollup read (the same on-screen, remembered read PR cards use) also bumps the version.
  onRollup(() => { version++; for (const s of subs) s(); });
  // So does the Pull requests board's own list answer (lib/prListChecks.ts).
  onListChecks(() => { version++; for (const s of subs) s(); });
  onChecksRead((r) => {
    reads.set(`${r.repo.toLowerCase()}#${r.number}`, { checks: r.checks, at: r.at ?? Date.now() });
    version++;
    for (const s of subs) s();
  });
}
export function onCardChecks(fn: () => void): () => void { listen(); subs.add(fn); return () => { subs.delete(fn); }; }
export const cardChecksVersion = (): number => version;
/**
 * The last reading of a pull request's checks, by its address; null when none arrived ("CI not read"). Only what the
 * server's watch sent or the PR store already holds: a card never asks GitHub itself, so a board adds no polling.
 */
export function checksForUrl(url: string | undefined): { checks: PrCheckRollup; at: number } | null {
  const ref = prRefFromUrl(url);
  if (!ref) return null;
  const watched = reads.get(`${ref.repo.toLowerCase()}#${ref.number}`);
  if (watched) return watched;
  const held = peekRollup(`gh:${ref.repo}`, ref.number);
  if (held?.checks) return { checks: held.checks, at: held.at };
  return listChecksFor(ref.repo, ref.number);
}
/**
 * What a card's CI chip shows for a PR address: a reading, "loading" while the board's own list load runs, or "not read"
 * once it finished without the PR. Asking starts that load when nothing has (one call path, no per-card read).
 */
export function ciChipFor(url: string | undefined): { read: { checks: PrCheckRollup; at: number } | null; loading: boolean } {
  const ref = prRefFromUrl(url);
  const read = checksForUrl(url);
  if (!ref) return { read, loading: false };
  const plan = ciPlan(!!read, listLoadOf(ref.repo));
  if (plan.trigger) queueMicrotask(() => ensureListLoaded(ref.repo));
  return { read, loading: plan.show === "loading" };
}
/** For tests: a reading as the watch would send it. */
export function __putChecks(url: string, checks: PrCheckRollup, at = Date.now()): void {
  const ref = prRefFromUrl(url);
  if (ref) { reads.set(`${ref.repo.toLowerCase()}#${ref.number}`, { checks, at }); version++; for (const s of subs) s(); }
}
