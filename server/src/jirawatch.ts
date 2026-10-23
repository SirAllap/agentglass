/*
 * Being told when a Jira card of yours moves.
 *
 * The same idea as the ClickUp bell (clickupwatch.ts), derived from one search
 * on a timer rather than received: Jira's per-user notification feed is not
 * something a personal token can read. "Cards assigned to me that changed since
 * I last looked" answers two things and no more:
 *
 *   assigned   an id that was not in my set before
 *   moved      an id whose status is not the one I last saw
 *
 * It never says WHO did it (that is the changelog, a later slice) and never
 * reads comments (S6).
 *
 * Request budget, counted: one search a tick, and a second only when the first
 * page was full. Every six minutes that is 10 an hour; a held 429 skips the tick
 * with no request at all (`optional`). The first look after connecting reads the
 * whole open set once, silently, so a quiet card that moves next week is a
 * move and not an assignment.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { hasCredential } from "./credentials.ts";
import { MINE_JQL, searchJql, withStored, type JiraResult, type JiraTasks } from "./jira.ts";
import type { CardNote } from "../../shared/types.ts";
import { CARD_WATCH_MS, type ProviderTask } from "../../shared/providers.ts";

/** Where the cards come from: a seam, so the diff is tested without a site. */
export type JiraReader = (jql: string) => Promise<JiraResult<JiraTasks>>;
let reader: JiraReader | null = null;
export function __setJiraReader(r: JiraReader | null): void { reader = r; }
const read: JiraReader = (jql) => reader
  ? reader(jql)
  : withStored((c) => searchJql(c, jql, { optional: true, light: true }));

/** One poll may say this much; the rest is in Tasks where it always was. */
const MAX_NOTES = 8;
/** The last-seen map is a de-duplicator, not a history. */
const SEEN_MAX = 2000;
/** How long a card we moved ourselves is checked against the old status. */
const OWN_MS = 10 * 60_000;

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "jira-watch.json");
let override: string | null = null;
export function __setJiraWatchPath(p: string | null): void { override = p; state = undefined; own.clear(); }
const path = (): string => override ?? FILE;

interface Seen { status: string; key: string; title: string; updated: number }
interface Watched { seen: Record<string, Seen>; at: number }

let state: Watched | undefined;

function load(): Watched {
  if (state) return state;
  try {
    state = existsSync(path()) ? (JSON.parse(readFileSync(path(), "utf8")) as Watched) : { seen: {}, at: 0 };
  } catch {
    state = { seen: {}, at: 0 };
  }
  state!.seen ??= {};
  return state!;
}

function save(s: Watched): void {
  state = s;
  try {
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), JSON.stringify(s, null, 2) + "\n");
  } catch { /* unwritable config dir: the watch still works, it repeats after a restart */ }
}

/** Disconnect: the last-seen map belongs to the account that read it. */
export function forgetJiraWatch(): void {
  try { rmSync(path(), { force: true }); } catch { /* nothing more to drop */ }
  state = undefined;
  own.clear();
  trouble = null;
  said = null;
}

// ---------------------------------------------------------------------------
// our own moves
// ---------------------------------------------------------------------------

/*
 * A card this app just moved is not news, and a search can lag the write it
 * follows. Both halves matter: announcing our own move is noise, and hiding the
 * next real one because the lagging answer looked like a move BACK is a lost
 * notification. So the move is remembered with the status it left; until it
 * ages out, a search that still shows the old status is stale and is skipped
 * without touching the record, and the first answer that shows the new one
 * clears the memory.
 */
const own = new Map<string, { from: string; to: string; at: number }>();

/** Called by whatever writes a status, with the card as it was before the write. */
export function rememberOwnMove(task: ProviderTask, to: string, now = Date.now()): void {
  const s = load();
  own.set(task.id, { from: task.status, to, at: now });
  const before = s.seen[task.id];
  s.seen[task.id] = { status: to, key: task.customId ?? before?.key ?? task.id, title: task.title || before?.title || "", updated: before?.updated ?? 0 };
  save(s);
}

/*
 * Who is on a card changed by this app, the status did not. Given to me: it is
 * not news, so it is seen, as after a move. Given to somebody else (or nobody):
 * it is no longer seen, so if it comes back to me later that IS news, and for
 * the next few minutes an answer still showing it (the search lagging the
 * write) is skipped rather than announced as assigned.
 * Ceiling: a real hand-back to me inside those minutes, at the same status, is
 * skipped too.
 */
export function rememberOwnAssign(task: ProviderTask, now = Date.now()): void {
  if (task.mine) { rememberOwnMove(task, task.status, now); return; }
  const s = load();
  own.set(task.id, { from: task.status, to: task.status, at: now });
  delete s.seen[task.id];
  save(s);
}

// ---------------------------------------------------------------------------
// the watch is failing, and somebody has to be told
// ---------------------------------------------------------------------------

export interface JiraWatchTrouble {
  error: string;
  /** True means reconnect, not wait. */
  unauthorised?: boolean;
  since: number;
  at: number;
  runs: number;
}

let trouble: JiraWatchTrouble | null = null;
/** What the Jira watch last failed at, or null while it is working. */
export function jiraWatchTrouble(): JiraWatchTrouble | null { return trouble; }

/** Said once per cause, not every poll: a revoked token is as true the next hundred times. */
let said: string | null = null;

function noteTrouble(r: { error?: string; unauthorised?: boolean; throttled?: boolean }, now: number): void {
  // A hold we made ourselves says nothing about the token: it never replaces a refusal.
  if (r.throttled && trouble?.unauthorised) { trouble = { ...trouble, at: now, runs: trouble.runs + 1 }; return; }
  const error = r.error ?? "Jira did not answer";
  const key = r.unauthorised ? "unauthorised" : error;
  trouble = { error, unauthorised: r.unauthorised, since: trouble?.since ?? now, at: now, runs: (trouble?.runs ?? 0) + 1 };
  if (said === key) return;
  said = key;
  console.warn(r.unauthorised
    ? `[jira] card notifications have stopped: ${error} Reconnect Jira in Settings; nothing is lost, but nothing is announced until you do.`
    : `[jira] card notifications are failing: ${error}. Retrying every ${Math.round(WATCH_MS / 60_000)} minutes; this is said once.`);
}

function troubleOver(): void {
  if (!trouble) return;
  trouble = null;
  if (said === null) return;
  said = null;
  console.log("[jira] card notifications are working again");
}

/** Test seam: the latch is module-level on purpose, so a suite that leaves one set poisons the next. */
export function __resetJiraTrouble(): void { trouble = null; said = null; }

// ---------------------------------------------------------------------------
// one look
// ---------------------------------------------------------------------------

/**
 * The window since the last look, in minutes relative to the site's own clock.
 *
 * `updated >= "2026-10-10 12:30"` is read in the timezone of the person's
 * profile, which this app cannot know; `-12m` is relative to the server and
 * needs neither. Two minutes are added: the minute the last look ended in is
 * read again (the answer is de-duplicated by status and `updated`), so a card
 * landing in that seam arrives late rather than never.
 */
export const windowJql = (since: number, now: number): string =>
  `assignee = currentUser() AND updated >= -${Math.max(1, Math.ceil((now - since) / 60_000)) + 2}m ORDER BY updated ASC`;

/**
 * Ask once, and report what is worth telling somebody. Exported apart from the
 * timer so a test can drive it, and so the first run is proven silent.
 */
export async function pollJira(now = Date.now()): Promise<CardNote[]> {
  if (!reader && !hasCredential("jira")) return [];
  const s = load();
  const first = s.at === 0;
  const r = await read(first ? MINE_JQL : windowJql(s.at, now));
  // A failed read must not move the mark: what it did not see is still news.
  if (!r.ok || !r.data) { noteTrouble(r, now); return []; }
  troubleOver();

  const notes: CardNote[] = [];
  const seen = { ...s.seen };
  const rows = [...r.data.tasks].sort((a, b) => a.updated - b.updated);
  for (const t of rows) {
    const mine = own.get(t.id);
    if (mine) {
      if (now - mine.at > OWN_MS) own.delete(t.id);
      else if (t.status === mine.from) continue;
      else if (t.status === mine.to) { own.delete(t.id); }
    }
    const before = seen[t.id];
    // An answer older than one already seen is a lagging index, not a change.
    if (before && t.updated && before.updated && t.updated < before.updated) continue;
    const key = t.customId ?? t.id;
    seen[t.id] = { status: t.status, key, title: t.title, updated: t.updated || before?.updated || 0 };
    if (first) continue;
    if (!before) {
      // Assigned to you already finished is not something to do.
      if (t.statusKind !== "done") notes.push({ kind: "assigned", tracker: "jira", id: key, label: key, title: t.title, status: t.status, url: t.url });
    } else if (before.status !== t.status) {
      notes.push({ kind: "status", tracker: "jira", id: key, label: key, title: t.title, status: t.status, was: before.status, url: t.url });
    }
  }

  /*
   * A SHORT READ MUST NOT MOVE THE MARK PAST WHAT IT READ.
   *
   * Oldest first, so when the cap cuts the list the mark advances to the last
   * card read and the next look continues from there. Newest first would read
   * the same 150 forever and never reach the older changes.
   */
  const last = rows[rows.length - 1]?.updated || 0;
  const at = r.data.truncated && !first && last > s.at ? Math.min(now, last) : now;
  const keep = Object.keys(seen);
  for (const id of keep.slice(0, Math.max(0, keep.length - SEEN_MAX))) delete seen[id];
  save({ seen, at });
  // Newest when there are too many: the ones that just happened.
  return notes.length > MAX_NOTES ? notes.slice(-MAX_NOTES) : notes;
}

/** Six minutes, the same as the ClickUp bell: a number the Settings row also quotes. */
export const WATCH_MS = CARD_WATCH_MS;

let timer: ReturnType<typeof setInterval> | null = null;

/** Start watching. Safe to call twice; a tick with no Jira connected does nothing and asks nothing. */
export function startJiraWatch(emit: (n: CardNote) => void): void {
  if (timer) return;
  const tick = async () => {
    try { for (const n of await pollJira()) emit(n); }
    catch (e) { noteTrouble({ error: String((e as Error)?.message ?? e).slice(0, 160) }, Date.now()); }
  };
  timer = setInterval(() => { void tick(); }, WATCH_MS);
  // Not at once, and not at the same moment as the ClickUp look.
  setTimeout(() => { void tick(); }, 75_000);
}

export function stopJiraWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
