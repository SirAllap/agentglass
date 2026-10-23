/*
 * The pull requests linked to a ClickUp card, read once per card and shared
 * across the row that draws the chip and the sidebar that opened first.
 *
 * `clickup/prs` searches GitHub by the card's own id and its `github` custom
 * field — there is no bulk endpoint, because the link is a text search over a
 * repository's pull requests, not a join ClickUp or GitHub keeps anywhere.
 * Asked per row on every render that would be a search per card per poll;
 * asked here it is one search per card, cached, and a board of thirty cards
 * left open for a session makes thirty of them total rather than thirty a
 * minute.
 *
 * The ceiling this accepts: a board scrolled into view for the first time
 * still pays one request per card the moment its row mounts — there is no
 * cheaper source for the card-to-pull-request link today. What this avoids is
 * asking again: `TTL_MS` matches `BOARD_POLL_MS`, the board's own refresh
 * interval, so a row re-rendered by that poll reuses its answer until it is
 * genuinely due for another one, instead of racing the poll with a timer of
 * its own.
 */
import { api } from "./api.ts";
import { pickCardPr, type CardPr } from "./cardPrPick.ts";
import { digitMetrics, forgetDigitMetrics, prChipWidth } from "./tasksColumnFit.ts";

/** Ten minutes, no longer the board's own poll interval (`BOARD_POLL_MS` in
 *  lib/boardPoll.ts). Each answer is a `gh pr list --search`, a GraphQL request
 *  against the account's 5000 an hour, and in step with a one-minute poll a
 *  board of thirty cards could spend thirty a minute on a link that changes
 *  once in a card's life. Ceiling: a pull request opened for a card shows on
 *  its row up to ten minutes late. */
export const TTL_MS = 10 * 60_000;
/** At once, matching prCardStore.ts: one ClickUp/GitHub token behind the
 *  server, and a board's worth of rows is a burst, not a stream. */
const AT_ONCE = 2;

type Entry = { at: number; prs: CardPr[]; error: boolean };
/** Whose pull-request search answers for a card. */
export type PrTracker = "clickup" | "jira";

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; taskId: string; tracker: PrTracker; card: string; field: string; cwd: string; project?: string }[] = [];
/** A Jira project's answer: every card of it that has a pull request, from one search. */
const projects = new Map<string, { at: number; byCard: Record<string, CardPr[]>; error: boolean }>();
const listeners = new Set<() => void>();
let running = 0;
let version = 0;

function tell(): void { version++; for (const l of listeners) l(); }

/*
 * The widest chip any answer so far needs, for the board's PR track: see
 * tasksColumnFit.ts for why a number and not a layout. Kept here, as the answers
 * land, so the board reads one number instead of looking at every row, and a
 * snapshot that is a number only re-renders the board when the column really
 * has to grow. It never shrinks until the cache is forgotten: a chip going away
 * should not make the column jump back under the one beside it.
 */
let widest = 0;
let watchingFonts = false;

/** Width in px of the widest chip seen, 0 while none has an answer. */
export function widestCardPrChip(): number { return widest; }

function widen(prs: readonly CardPr[]): void {
  widest = Math.max(widest, prChipWidth(pickCardPr(prs), digitMetrics()));
  // The probe only counts once the fonts are in; measure again when they are.
  if (!watchingFonts && typeof document !== "undefined" && document.fonts?.status === "loading") {
    watchingFonts = true;
    void document.fonts.ready.then(() => {
      forgetDigitMetrics();
      widest = 0;
      for (const e of seen.values()) widest = Math.max(widest, prChipWidth(pickCardPr(e.prs), digitMetrics()));
      tell();
    });
  }
}

/** Changes when any answer lands — the snapshot for `useSyncExternalStore`. */
export function cardPrVersion(): number { return version; }

export function onCardPrs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const { key, taskId, tracker, card, field, cwd, project } = waiting.shift()!;
    running++;
    inflight.add(key);
    if (project) {
      api.jiraProjectPrs(project, cwd)
        .then((r) => {
          const byCard = r.ok ? r.byCard ?? {} : {};
          projects.set(key, { at: Date.now(), byCard, error: !r.ok });
          for (const prs of Object.values(byCard)) widen(prs);
        })
        .catch(() => { projects.set(key, { at: Date.now(), byCard: {}, error: true }); })
        .finally(() => { running--; inflight.delete(key); tell(); pump(); });
      continue;
    }
    (tracker === "jira" ? api.jiraPrs(card, cwd) : api.clickupPrs(card, field, cwd, taskId))
      .then((r) => { const prs = r.ok ? (r.prs ?? []) : []; seen.set(key, { at: Date.now(), prs, error: !r.ok }); widen(prs); })
      .catch(() => { seen.set(key, { at: Date.now(), prs: [], error: true }); })
      .finally(() => { running--; inflight.delete(key); tell(); pump(); });
  }
}

/**
 * The pull requests for this card, or `null` while nobody has asked yet.
 *
 * Asking is the side effect, same as `prCardStore.cardOf`: calling this for a
 * card nothing has asked about queues it. A card with no `github` field, no
 * custom id and no task id worth searching on is not queued — there is nothing for
 * `clickup/prs` to search with, and a request that can only come back empty
 * is not a request worth making.
 */
export function cardPrsOf(taskId: string, card: string, field: string, cwd: string, tracker: PrTracker = "clickup"): Entry | null {
  if (tracker === "jira") return jiraCardPrs(card, cwd);
  const key = taskId;
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  // The task's own id is a search term too: a free workspace has no custom id,
  // and its branches say `CU-<task id>`.
  if (!card && !field && !taskId) return hit ?? null;
  if (!inflight.has(key) && !waiting.some((w) => w.key === key)) {
    waiting.push({ key, taskId, tracker, card, field, cwd });
    pump();
  }
  return hit ?? null;
}

/**
 * A Jira card's pull requests, read from its PROJECT's one search: forty cards
 * of ORBIT are one request, not forty, and a card with no pull request is an
 * answer (an empty entry), not a reason to ask again. Ceiling (the server's):
 * the newest 200 rows of the project's search, and a key that appears only in a
 * branch name is not found.
 */
function jiraCardPrs(card: string, cwd: string): Entry | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(card.trim());
  if (!m) return null;
  const project = m[1]!.toUpperCase();
  const key = `${project}|${cwd}`;
  const hit = projects.get(key);
  if ((!hit || Date.now() - hit.at >= TTL_MS) && !inflight.has(key) && !waiting.some((w) => w.key === key)) {
    waiting.push({ key, taskId: "", tracker: "jira", card: "", field: "", cwd, project });
    pump();
  }
  return hit ? { at: hit.at, prs: hit.byCard[card.trim().toUpperCase()] ?? [], error: hit.error } : null;
}

/** Forget everything — a board switch or an explicit refresh, same trigger as
 *  `prCardStore.forgetCards`. */
export function forgetCardPrs(): void {
  seen.clear();
  projects.clear();
  widest = 0;
  waiting.length = 0;
  tell();
}
