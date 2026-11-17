/*
 * NEXT CARD — a saved Jira filter's members, scouted one at a time.
 *
 * Off by default (setting `flow.nextCard.enabled`), and off until a filter is
 * picked (`flow.nextCard.filterId`). The one ask in this file that is the
 * honest poll: a card entering a saved filter raises no webhook this app is
 * wired to, so every open project with the setting on reads its filter once
 * every POLL_MS — 12 requests an hour, the number the brief asked to be kept
 * to and said in this comment rather than left to be found. Nothing else here
 * is on a timer: the start itself is the same `startThroughPolicy` a person's
 * own `--card` start takes, through the read-only `scout` role so no worktree
 * has to be invented for it.
 *
 * CLAIMED, ONCE, FOREVER — never released. A card this feature has already
 * started a scout for is never started a second one by it, whether that scout
 * finished, is still running, or crashed: the claim is a record of "we looked
 * at this one", not a lock to free. A scout that crashed leaves its card
 * un-rescouted automatically, same as a person's own worker that crashes
 * leaves its card where it was — a gap this file does not hide, and the one
 * the brief's "needs a claim timeout" note was about; see nextCard.test.ts.
 */
import { db } from "../db.ts";
import { workspaceRoots } from "../config.ts";
import { getSetting } from "../preflightStore.ts";
import { storedCreds } from "../jira.ts";
import { readFilter } from "../jiraFilterSync.ts";
import { runJql } from "../jiraJql.ts";
import { cardAsk, cardSites, readCard, briefWithCard } from "../cardbrief.ts";
import { startThroughPolicy } from "./policystart.ts";
import * as AgentOps from "../agentops.ts";
import { setIntervalAs } from "../loopwatch.ts";

/** 5 minutes a tick, 12 requests an hour — the number the brief asked kept to. */
export const POLL_MS = 5 * 60_000;

db.run(`CREATE TABLE IF NOT EXISTS jira_filter_claim (
  root TEXT NOT NULL,
  card_id TEXT NOT NULL,
  name TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (root, card_id)
)`);
const claimQ = db.query<never, [string, string, string, number]>(
  `INSERT OR IGNORE INTO jira_filter_claim (root, card_id, name, claimed_at) VALUES (?, ?, ?, ?)`);
const namesQ = db.query<{ name: string }, [string]>(`SELECT name FROM jira_filter_claim WHERE root = ?`);

/** Whether this card already has a claim, whatever became of its scout. */
function isClaimed(root: string, cardId: string): boolean {
  return db.query<{ n: number }, [string, string]>(`SELECT 1 AS n FROM jira_filter_claim WHERE root = ? AND card_id = ?`).get(root, cardId) !== null;
}

/** The claim, taken once: false when another tick (or another server) already has it. */
function tryClaim(root: string, cardId: string, name: string, now: number): boolean {
  return claimQ.run(root, cardId, name, now).changes === 1;
}

/** Scouts this feature started for this project that are still running. */
function liveClaimed(root: string): number {
  let n = 0;
  for (const { name } of namesQ.all(root)) { const a = AgentOps.agentNamed(name); if (a && a.endedAt === null) n++; }
  return n;
}

/** Settings ▸ Orchestration ▸ Next card, for this project. */
export function nextCardSetting(root: string): { enabled: boolean; filterId: string; cap: number } {
  const cap = Number(getSetting(root, "flow.nextCard.cap"));
  return {
    enabled: getSetting(root, "flow.nextCard.enabled") === true,
    filterId: String(getSetting(root, "flow.nextCard.filterId") ?? "").trim(),
    cap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 2,
  };
}

export interface NextCardDeps {
  creds?: typeof storedCreds;
  readFilter?: typeof readFilter;
  runJql?: typeof runJql;
  start?: typeof startThroughPolicy;
  now?: number;
}

/**
 * One tick for one project: read the filter's current members, claim and
 * start a scout for each unclaimed one, up to the cap still free. Does
 * nothing when the setting is off, no filter is picked, or Jira is not
 * connected.
 */
export async function tickNextCard(root: string, deps: NextCardDeps = {}): Promise<{ started: string[] }> {
  const { enabled, filterId, cap } = nextCardSetting(root);
  if (!enabled || !filterId) return { started: [] };
  const creds = (deps.creds ?? storedCreds)();
  if (!creds) return { started: [] };
  const filter = await (deps.readFilter ?? readFilter)(creds, filterId);
  if (!filter.ok || !filter.data) return { started: [] };
  let free = cap - liveClaimed(root);
  if (free <= 0) return { started: [] };
  const found = await (deps.runJql ?? runJql)(filter.data.jql, { pages: 1 });
  if (!found.ok || !found.data) return { started: [] };
  const now = deps.now ?? Date.now();
  const sites = cardSites();
  const started: string[] = [];
  for (const task of found.data.tasks) {
    if (free <= 0) break;
    const cardId = task.customId || task.id;
    if (!cardId || isClaimed(root, cardId)) continue;
    const name = `scout-${cardId}`.toLowerCase();
    if (!tryClaim(root, cardId, name, now)) continue; // another tick, or another server, took it first
    const ask = cardAsk(cardId, sites);
    const r = await (deps.start ?? startThroughPolicy)({
      root, policyRoot: root, name, cwd: root, seatRoot: root,
      prompt: () => briefWithCard("", ask, readCard), body: { role: "scout" },
      cardOrPrompt: ask.id, cardRef: ask.ref,
    });
    if (r.status === 200) { started.push(name); free--; }
    // A refused start (a worker already by that name, the limit reached) is
    // not retried: the claim stands, same as any other claim.
  }
  return { started };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startNextCardTick(): void {
  if (timer) return;
  timer = setIntervalAs("next card tick", () => { for (const r of workspaceRoots()) void tickNextCard(r).catch(() => {}); }, POLL_MS);
  timer.unref?.();
}
export function stopNextCardTick(): void { if (timer) clearInterval(timer); timer = null; }
