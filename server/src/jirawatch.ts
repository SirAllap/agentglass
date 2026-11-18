/*
 * Being told when a Jira card of yours moves, and when somebody writes on one.
 *
 * The same idea as the ClickUp bell (clickupwatch.ts), derived from searches
 * on a timer rather than received: Jira's per-user notification feed is not
 * something a personal token can read. Four things come out of two searches and
 * a look at the comments:
 *
 *   assigned   an id that was not in my set before
 *   moved      an id whose status is not the one I last saw
 *   comment    somebody wrote on a card of mine
 *   mention    a comment that named me, on a card of mine or on one I report or watch
 *
 * A move names who made it, read from the changelog, so the phone can tell
 * its owner's own move from somebody else's; a comment carries its author too.
 *
 * Request budget, counted: two searches a tick — my cards, and the cards I
 * reported or watch, where a mention usually lands — plus one comment read per
 * card that changed, at most MAX_COMMENT_READS. Every six minutes that is 20 an
 * hour; a held 429 skips the tick with no request at all (`optional`). The first
 * look after connecting reads the whole open set once, silently, and reads no
 * comments: so a quiet card that moves next week is a move and not an
 * assignment.
 *
 * Ceiling: a mention on a card I neither own, report nor watch does not ring.
 * Jira's own feed would know it; the REST API has no query for "comments that
 * name me", so the watcher can only look inside a set it already has a reason
 * to read.
 */
import { setTimeoutAs, waitedFor } from "./loopwatch.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { hasCredential, redacted } from "./credentials.ts";
import { MINE_JQL, searchJql, withStored, type JiraResult, type JiraTasks } from "./jira.ts";
import { commentsPage, historyPage, type ActivityPage } from "./jiraActivity.ts";
import type { CardNote } from "../../shared/types.ts";
import { CARD_WATCH_MS, type CardEvent, type ProviderTask, type TaskDetail } from "../../shared/providers.ts";

/** Where the cards come from: a seam, so the diff is tested without a site. */
export type JiraReader = (jql: string) => Promise<JiraResult<JiraTasks>>;
let reader: JiraReader | null = null;
export function __setJiraReader(r: JiraReader | null): void { reader = r; }
const read: JiraReader = (jql) => reader
  ? reader(jql)
  : withStored((c) => searchJql(c, jql, { optional: true, light: true }));

type CommentRow = NonNullable<TaskDetail["comments"]>[number];

/** Where one card's comments come from: the same seam, for the same reason. */
export type JiraCommentReader = (key: string) => Promise<{ ok: boolean; data?: { comments: CommentRow[] } }>;
let commentReader: JiraCommentReader | null = null;
export function __setJiraCommentReader(r: JiraCommentReader | null): void { commentReader = r; }
const readComments: JiraCommentReader = (key) => commentReader
  ? commentReader(key)
  : withStored((c) => commentsPage(c, key, 0, redacted("jira")?.accountId, { newest: true }))
    .then((r) => ({ ok: r.ok, ...(r.data ? { data: { comments: r.data.comments ?? [] } } : {}) }));

/** Who made the latest move into `to`, from the card's changelog. */
export type JiraMover = (key: string, to: string) => Promise<{ who: string; whoId: string } | null>;
let moverReader: JiraMover | null = null;
export function __setJiraMover(r: JiraMover | null): void { moverReader = r; }
/** Pages read per card, counted from the newest end; and cards asked per poll. */
const HISTORY_PAGES = 3;
const MAX_MOVER_READS = 4;
type HistoryReader = (key: string, at: number) => Promise<JiraResult<ActivityPage>>;
let historyReader: HistoryReader | null = null;
export function __setJiraHistory(r: HistoryReader | null): void { historyReader = r; }
const readHistory: HistoryReader = (key, at) => historyReader
  ? historyReader(key, at)
  : withStored((c) => historyPage(c, key, at));

/** The changelog is oldest first, so the latest move into `to` is near the end:
 *  the first page tells the size and the total, then it walks back from the last. */
export async function latestMover(key: string, to: string): Promise<{ who: string; whoId: string } | null> {
  const first = await readHistory(key, 0);
  if (!first.ok || !first.data) return null;
  const pick = (events: CardEvent[] | undefined): { who: string; whoId: string } | null => {
    let found: { who: string; whoId: string } | null = null;
    for (const e of events ?? []) {
      if (e.edit?.field === "status" && e.edit.toString === to && e.whoId) found = { who: e.who ?? "", whoId: e.whoId };
    }
    return found;
  };
  const size = first.data.next;
  if (size === undefined) return pick(first.data.events);
  let at = Math.floor((Math.max(first.data.total, size + 1) - 1) / size) * size;
  for (let i = 1; i < HISTORY_PAGES && at > 0; i++, at -= size) {
    const r = await readHistory(key, at);
    if (!r.ok || !r.data) return null;
    const m = pick(r.data.events);
    if (m) return m;
  }
  return at === 0 ? pick(first.data.events) : null;
};
const readMover: JiraMover = async (key, to) => moverReader ? moverReader(key, to) : latestMover(key, to);

/** One poll may say this much; the rest is in Tasks where it always was. */
const MAX_NOTES = 8;
/** Comment reads per poll: one each, so the cap is what one tick may cost. */
const MAX_COMMENT_READS = 12;
/** The last-seen map is a de-duplicator, not a history. */
const SEEN_MAX = 2000;
/** Comment ids already announced, newest last. */
const TOLD_MAX = 300;
/** How long a card we moved ourselves is checked against the old status. */
const OWN_MS = 10 * 60_000;

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "jira-watch.json");
let override: string | null = null;
export function __setJiraWatchPath(p: string | null): void { override = p; state = undefined; own.clear(); }
const path = (): string => override ?? FILE;

interface Seen { status: string; key: string; title: string; updated: number }
interface Watched {
  seen: Record<string, Seen>;
  at: number;
  /** Comments already announced; the window reads a minute twice, and a card's
   *  comment list is a list, not a feed. */
  told?: string[];
}

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
const windowMinutes = (since: number, now: number): number => Math.max(1, Math.ceil((now - since) / 60_000)) + 2;

export const windowJql = (since: number, now: number): string =>
  `assignee = currentUser() AND updated >= -${windowMinutes(since, now)}m ORDER BY updated ASC`;

/**
 * The cards that are not mine but that I have a reason to hear about: ones I
 * reported, and ones I watch (Jira adds a watcher when you comment). A mention
 * usually lands on somebody else's card, and `assignee = currentUser()` cannot
 * see one. Same window, so the two searches cannot disagree about the seam.
 */
export const followJql = (since: number, now: number): string =>
  `(reporter = currentUser() OR watcher = currentUser()) AND updated >= -${windowMinutes(since, now)}m ORDER BY updated ASC`;

/**
 * The names that are mine, for an id match on a mention.
 *
 * Cloud names the mentioned person by `accountId`, which is what the connection
 * stored. Data Center writes `[~login]`, and its `/myself` has no account id, so
 * the login is the one it was signed in with; a bearer-token connection has none
 * and falls back to the display name.
 */
const myNames = (): string[] => {
  const c = redacted("jira");
  return [c?.accountId, c?.email, c?.account].filter((x): x is string => typeof x === "string" && !!x).map((x) => x.toLowerCase());
};

/** Whose name in a comment is not news. Injected for the same reason as the readers. */
let meNames: string[] | null = null;
export function __setJiraMe(v: string[] | null): void { meNames = v; }
const myIds = (): string[] => meNames ?? myNames();

const namedMe = (c: CommentRow, me: string[]): boolean =>
  (c.mentions ?? []).some((m) => [m.id, m.name].some((x) => !!x && me.includes(String(x).toLowerCase())));

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
  /** Every card worth opening the comments on, by key, with whether it is mine. */
  const look = new Map<string, { task: ProviderTask; mine: boolean }>();
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
    look.set(key, { task: t, mine: t.mine === true || !!before });
    if (first) continue;
    if (!before) {
      // Assigned to you already finished is not something to do.
      if (t.statusKind !== "done") notes.push({ kind: "assigned", tracker: "jira", id: key, label: key, title: t.title, status: t.status, url: t.url });
    } else if (before.status !== t.status) {
      notes.push({ kind: "status", tracker: "jira", id: key, label: key, title: t.title, status: t.status, was: before.status, url: t.url });
    }
  }

  /*
   * The cards I report or watch, which is where a mention usually is: somebody
   * writes on their own card and names me. Only on a card that changed, so the
   * answer is one search and no comment reads on a quiet tick. A failure here
   * costs the mentions, never the assignments, so it is not raised as trouble.
   */
  const follow = first ? null : await read(followJql(s.at, now));
  if (follow?.ok && follow.data) for (const t of follow.data.tasks) {
    const key = t.customId ?? t.id;
    if (!look.has(key)) look.set(key, { task: t, mine: t.mine === true || !!seen[t.id] });
  }

  // Who moved it: the changelog's author, only for the cards that moved.
  const me0 = myIds();
  let moverReads = 0;
  for (const n of notes) {
    if (n.kind !== "status" || moverReads >= MAX_MOVER_READS) continue;
    moverReads++;
    const m = await readMover(n.id, n.status).catch(() => null);
    if (!m) continue;
    n.who = m.who;
    // Without my own account id nothing can be called mine, and a wrong "not me" alerts the phone.
    if (me0.length) n.byMe = me0.includes(m.whoId.toLowerCase());
  }

  /*
   * Now the comments, and only on the cards that changed: a comment bumps the
   * card's `updated`, so this is usually nought calls and occasionally one,
   * rather than one per card I own. `newest` first, because the interesting
   * ones on a card with a long history are the ones at the end.
   */
  const told = new Set(s.told ?? []);
  const me = myIds();
  for (const { task, mine } of first ? [] : [...look.values()].slice(0, MAX_COMMENT_READS)) {
    const cs = await readComments(task.customId ?? task.id);
    if (!cs.ok || !cs.data) continue;
    for (const c of cs.data.comments) {
      if (c.at <= s.at || told.has(c.id)) continue;
      // Your own comment is not news, and neither is one on somebody else's
      // card that did not name you.
      if (c.mine) { told.add(c.id); continue; }
      const named = me.length ? namedMe(c, me) : false;
      if (!named && !mine) { told.add(c.id); continue; }
      told.add(c.id);
      notes.push({
        kind: named ? "mention" : "comment",
        tracker: "jira", id: task.customId ?? task.id, label: task.customId ?? task.id, title: task.title, status: task.status,
        who: c.who, said: c.text.replace(/\s+/g, " ").slice(0, 140), url: task.url,
      });
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
  save({ seen, at, told: [...told].slice(-TOLD_MAX) });
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
  timer = setInterval(() => { waitedFor("jira card watch", () => void tick()); }, WATCH_MS);
  // Not at once, and not at the same moment as the ClickUp look.
  setTimeoutAs("boot:jira-watch:first", () => { void tick(); }, 75_000);
}

export function stopJiraWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
