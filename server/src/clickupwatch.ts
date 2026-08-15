/*
 * Being told when a card of yours moves, without ClickUp's own notification.
 *
 * ClickUp's public API has no notifications endpoint — `/v2/notification` and
 * `/v2/notifications` both answer 404, checked against a real workspace. The
 * pop-up you get in a browser is their web app's push, tied to that browser's
 * session; a personal API token cannot subscribe to it. So it is not received,
 * it is DERIVED.
 *
 * One call, on a timer: "cards assigned to me that changed since I last
 * looked". Two things are worth saying out loud, and both fall out of the same
 * answer:
 *
 *   assigned   an id that was not in my set before
 *   moved      an id whose status is not the one I last saw
 *
 * What this deliberately cannot say is WHO did it — the query answers with
 * cards, not with an activity feed — so it never claims to. "Assigned to you"
 * is true; "David assigned this to you" would be a guess.
 *
 * The state is on disk. Without it a restart re-reads a day of changes and
 * announces all of them, which is how a notification feature teaches people to
 * ignore it. And the first run after connecting is SILENT for the same reason:
 * it records where things stand and says nothing.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { changedForMe, changedOnLists, commentsOn, type CardComment } from "./clickup.ts";
import { hasCredential, redacted } from "./credentials.ts";
import { savedViews } from "./clickupviews.ts";
import type { CardNote } from "../../shared/types.ts";
import type { ProviderTask } from "../../shared/providers.ts";

/**
 * Where the cards come from — a seam, not a mock.
 *
 * What is worth testing here is the DIFF, and a suite that reached a workspace
 * would not run. Replacing the module instead (`mock.module`) swaps it for the
 * whole process, which is not a hypothetical: it took the real ClickUp suite
 * down with it the first time this file had tests.
 */
/**
 * `error` and `unauthorised` are carried, not dropped, and that is T27.
 *
 * `changedForMe` has always returned both — it is a `CallResult` — and this
 * seam typed them away, so `!r.ok` was the only thing a caller could see. One
 * `return []` later, a revoked token and a quiet week were the same event: the
 * bell stopped for ever and nothing anywhere said so.
 */
export type CardReader = (sinceMs: number) => Promise<{
  ok: boolean;
  data?: { tasks: ProviderTask[] };
  /** For the person, never a raw body. */
  error?: string;
  /** The one failure that means "reconnect" rather than "try later". */
  unauthorised?: boolean;
  /** We were refused for rate, or held back before asking at all — so this
   *  failure carries no news about the token. See noteTrouble. */
  throttled?: boolean;
}>;
export type CommentReader = (taskId: string) => Promise<{ ok: boolean; data?: { comments: CardComment[] } }>;
let reader: CardReader | null = null;
let boardReader: CardReader | null = null;
let comments: CommentReader | null = null;
export function __setCardReader(r: CardReader | null): void { reader = r; }
export function __setBoardReader(r: CardReader | null): void { boardReader = r; }
export function __setCommentReader(r: CommentReader | null): void { comments = r; }
/** Whose comments are not news. Injected for the same reason as the readers. */
let meId: string | null = null;
export function __setMe(id: string | null): void { meId = id; }
const myId = (): string => meId ?? String(redacted("clickup")?.accountId ?? "");

/**
 * How many cards we are willing to open comments on in one pass.
 *
 * Each is a call of about 300ms. On a normal poll the list is empty or has one
 * card in it; the cap exists for the first poll after a quiet week, where a
 * day's worth of movement could otherwise turn one tick into a minute of
 * requests.
 */
const MAX_COMMENT_READS = 12;

/**
 * How many things one poll may say at once.
 *
 * A normal tick produces nothing or one. This is the valve for the tick that
 * does not: a machine asleep for a week, a state file lost, a clock that moved
 * backwards. Driven against a real workspace with the window rewound 45 days,
 * one poll produced seventy-one — every one of them true, and arriving together
 * they are not notifications, they are a wall.
 *
 * The dropped ones are not lost work: the state still advances, so they do not
 * come back, and every card they were about is in Tasks where it always was.
 */
const MAX_NOTES = 8;

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "clickup-watch.json",
);

/** Test seam, so a suite never reads or writes the developer's own state. */
let override: string | null = null;
export function __setWatchPath(p: string | null): void { override = p; state = undefined; }
const path = (): string => override ?? FILE;

interface Watched {
  /** What each card of mine looked like last time. Keyed by ClickUp's own id. */
  seen: Record<string, { status: string; customId?: string; title: string }>;
  /** The high-water mark handed to `date_updated_gt`. */
  at: number;
  /**
   * Comments already announced, newest last.
   *
   * The window carries a minute of overlap on purpose, so the same comment can
   * come back twice; a notification that repeats every three minutes is worse
   * than one that is late. Capped — this is a de-duplicator, not a history.
   */
  told?: string[];
}

const TOLD_MAX = 300;

let state: Watched | undefined;

function load(): Watched {
  if (state) return state;
  try {
    const p = path();
    state = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Watched) : { seen: {}, at: 0 };
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
  } catch { /* unwritable config dir: the watch still works, it just repeats after a restart */ }
}

// ---------------------------------------------------------------------------
// the watch is failing, and somebody has to be told
// ---------------------------------------------------------------------------

/**
 * The last failure, latched.
 *
 * `pollCards` still returns `[]` on a bad read and still leaves the high-water
 * mark where it was — that part was right: nothing is LOST. What was wrong is
 * that nothing was SAID. A 401 from a rotated personal token failed silently
 * every three minutes for as long as the server ran, the Tasks panel kept
 * showing its last read, and the feature was indistinguishable from a quiet
 * week. This is the difference between "no cards moved" and "we cannot ask".
 *
 * In memory, deliberately. It describes what THIS process last managed to do;
 * a restart re-establishes it on the first tick a minute later, and persisting
 * it would let a stale complaint outlive the token it was about.
 */
export interface WatchTrouble {
  /** For the person. Whatever `changedForMe` said, or the thrown message. */
  error: string;
  /** True ⇒ reconnect, not wait. The one that must escalate the row. */
  unauthorised?: boolean;
  /** When this spell of trouble started, and when it last happened. */
  since: number;
  at: number;
  /** Consecutive failed polls, so "once" and "all afternoon" read differently. */
  runs: number;
}

let trouble: WatchTrouble | null = null;

/** What the card watch last failed at, or null while it is working. Read by
 *  `/providers` so the ClickUp row can say it — see providers.ts. */
export function cardWatchTrouble(): WatchTrouble | null { return trouble; }

/**
 * Said once, not on every poll.
 *
 * The same treatment alerts.ts gives a missing `notify-send`, and for the same
 * reason: the cause of a 401 is just as true the next four hundred times, and a
 * log line every three minutes is a log nobody skims. Keyed on WHAT went wrong,
 * so a token failure that turns into a network failure is still said — the two
 * need different actions.
 */
let said: string | null = null;

function noteTrouble(r: { error?: string; unauthorised?: boolean; throttled?: boolean }, now: number): void {
  /*
   * A failure that never reached ClickUp does not replace one that did.
   *
   * Measured while proving this ticket: with the watcher pointed at a server
   * answering 401, poll 1 latched "ClickUp refused this token" and poll 2
   * replaced it with "Holding off — ClickUp's rate limit is nearly used up".
   * The rate hold is a decision made HERE, from a budget the previous failure
   * left behind — it carries no news about the token, and letting it overwrite
   * the 401 downgraded the row from "reconnect" to a wait-and-see. The trigger
   * was a separate bug in clickup.ts (a missing header read as zero budget) and
   * that is fixed, but the ordering rule is worth keeping on its own: 429 is a
   * real answer too, and it still says nothing about whether the token is good.
   */
  if (r.throttled && trouble?.unauthorised) {
    trouble = { ...trouble, at: now, runs: trouble.runs + 1 };
    return;
  }
  const error = r.error ?? "ClickUp did not answer";
  const key = r.unauthorised ? "unauthorised" : error;
  trouble = {
    error, unauthorised: r.unauthorised,
    since: trouble?.since ?? now,
    at: now,
    runs: (trouble?.runs ?? 0) + 1,
  };
  if (said === key) return;
  said = key;
  if (r.unauthorised) {
    console.warn(`[clickup] card notifications have stopped: ${error}. Reconnect ClickUp in Settings — nothing is lost, but nothing will be announced until you do.`);
  } else {
    console.warn(`[clickup] card notifications are failing: ${error}. Retrying every ${Math.round(WATCH_MS / 60_000)} minutes; this is said once.`);
  }
}

function troubleOver(): void {
  if (!trouble) return;
  const spell = Math.round((trouble.at - trouble.since) / 60_000);
  trouble = null;
  // Only ever said when something WAS said about the failure, so a single
  // dropped poll stays a non-event in both directions.
  if (said === null) return;
  said = null;
  console.log(`[clickup] card notifications are working again${spell >= 1 ? ` (after ${spell}m)` : ""}`);
}

/** Test seam. The latch is module-level on purpose — it is a property of the
 *  process, not of a poll — so a suite that leaves one set poisons the next. */
export function __resetTrouble(): void { trouble = null; said = null; }

/**
 * Ask once, and report what is worth telling somebody.
 *
 * Exported apart from the timer so a test can drive it, and so the first run
 * can be proven silent rather than asserted to be.
 */
export async function pollCards(now = Date.now()): Promise<CardNote[]> {
  if (!reader && !hasCredential("clickup")) return [];
  const s = load();
  const first = s.at === 0;
  // A day on the first run, so a fresh install learns the shape of things
  // without asking ClickUp for the whole history. After that, exactly the
  // window since the last look, less a minute of overlap — ClickUp's clock is
  // not ours, and a card that lands in that seam should arrive late rather
  // than never.
  const since = first ? now - 24 * 3600_000 : Math.max(0, s.at - 60_000);
  const r = await (reader ?? changedForMe)(since);
  // A failed read must not move the high-water mark: the changes it did not
  // see are still changes. It must also not pass unnoticed — a 401 here is the
  // whole feature stopping, and it used to look exactly like an empty result.
  if (!r.ok || !r.data) { noteTrouble(r, now); return []; }
  troubleOver();

  const notes: CardNote[] = [];
  const seen = { ...s.seen };
  /** Every card worth opening the comments on, by id, with what to call it. */
  const look = new Map<string, ProviderTask>();
  for (const t of r.data.tasks) {
    const before = seen[t.id];
    seen[t.id] = { status: t.status, customId: t.customId, title: t.title };
    look.set(t.id, t);
    if (first) continue;
    if (!before) {
      notes.push({ kind: "assigned", id: t.id, label: t.customId ?? t.id, title: t.title, status: t.status, url: t.url });
    } else if (before.status !== t.status) {
      notes.push({ kind: "status", id: t.id, label: t.customId ?? t.id, title: t.title, status: t.status, was: before.status, url: t.url });
    }
  }

  /*
   * The cards that moved on the boards you follow, which is the only way to see
   * a mention on a card that is not yours. Scoped to your own lists: a
   * company's workspace moves constantly and none of the rest is yours to be
   * told about. A failure here costs the mentions, not the assignments.
   */
  const lists = savedViews().map((v) => v.listId).filter((x): x is string => !!x);
  const board = await (boardReader ?? ((since) => changedOnLists(since, lists)))(since);
  if (board.ok && board.data) for (const t of board.data.tasks) look.set(t.id, t);

  /*
   * Now the comments, and only on cards something already said had moved — a
   * comment bumps the card's `date_updated`, checked against real cards where
   * the two timestamps match to the minute. So this is usually nought calls and
   * occasionally one, rather than one per card you own.
   */
  const told = new Set(s.told ?? []);
  const mine = myId();
  const read = comments ?? commentsOn;
  for (const t of [...look.values()].slice(0, MAX_COMMENT_READS)) {
    const cs = await read(t.id);
    if (!cs.ok || !cs.data) continue;
    for (const c of cs.data.comments) {
      if (c.at <= since || told.has(c.id)) continue;
      // Your own comment is not news, and neither is one on somebody else's
      // card that did not name you.
      if (c.whoId && c.whoId === mine) { told.add(c.id); continue; }
      const named = mine ? c.mentions.includes(mine) : false;
      const isMine = !!seen[t.id];
      if (!named && !isMine) { told.add(c.id); continue; }
      told.add(c.id);
      if (first) continue;
      notes.push({
        kind: named ? "mention" : "comment",
        id: t.id, label: t.customId ?? t.id, title: t.title, status: t.status,
        who: c.who, said: c.text.replace(/\s+/g, " ").slice(0, 140), url: t.url,
      });
    }
  }

  save({ seen, at: now, told: [...told].slice(-TOLD_MAX) });
  // Newest first when there are too many: if only eight of a hundred can be
  // said, they should be the eight that just happened.
  return notes.length > MAX_NOTES ? notes.slice(-MAX_NOTES) : notes;
}

/**
 * How often to look.
 *
 * Three minutes. The call takes about six seconds and costs one request
 * against a budget of a hundred a minute, so the ceiling is not the rate limit
 * — it is that a notification which arrives twenty minutes late is not a
 * notification. Three is inside the window where somebody is still on the same
 * thought.
 */
export const WATCH_MS = 3 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Start watching, if there is anything to watch. Safe to call twice. */
export function startCardWatch(emit: (n: CardNote) => void): void {
  if (timer) return;
  const tick = async () => {
    try { for (const n of await pollCards()) emit(n); }
    catch (e) {
      // A poll that throws is still a poll skipped, not a server down — but it
      // is no longer a poll that vanishes. This catch was the second of two
      // layers of silence over one fact; it now latches like any other failure,
      // so a watcher that has been throwing all afternoon says so on the
      // ClickUp row instead of looking like a week with no cards in it.
      noteTrouble({ error: String((e as Error)?.message ?? e).slice(0, 160) }, Date.now());
    }
  };
  // Not immediately: a server that has just started has a browser attaching to
  // it, a scan running and a fleet to read. This can wait a minute.
  timer = setInterval(() => { void tick(); }, WATCH_MS);
  setTimeout(() => { void tick(); }, 60_000);
}

export function stopCardWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// which card a mirrored notification is about
// ---------------------------------------------------------------------------

/**
 * ClickUp's own desktop notification, matched back to a card.
 *
 * The desktop app posts "Alejandro set the status to: READY FOR QA" with the
 * task's TITLE as the summary and nothing else — no id, no url, and a D-Bus
 * monitor cannot invoke the notification's own action to find out. So the row
 * behind the bell had nowhere to go but ClickUp's website, which is the one
 * destination that leaves this app.
 *
 * The title, though, is enough: the watcher already keeps every card of yours
 * it has seen, with its id and its `ORBIT-…` label, in the file it uses to tell
 * a status change from a new assignment. Looking a title up in that costs
 * nothing and is not a guess.
 *
 * Deliberately silent when TWO cards match. Two tickets can share a title —
 * "Fix the flaky test" — and opening the wrong one is worse than opening
 * nothing, because the reader has no way to tell it happened.
 */
export function cardForTitle(title: unknown): { id: string; label: string } | null {
  const want = normalizeTitle(title);
  // Short titles match too many things. "QA" would resolve to whichever card
  // happened to start with it.
  if (want.length < 8) return null;
  const seen = load().seen;
  const hits: { id: string; label: string }[] = [];
  for (const [id, v] of Object.entries(seen)) {
    const have = normalizeTitle(v.title);
    if (!have) continue;
    // Either side may be the shorter one: a notification daemon truncates long
    // summaries, and so does the panel that stores them.
    if (have === want || have.startsWith(want) || want.startsWith(have)) {
      hits.push({ id, label: v.customId ?? id });
      if (hits.length > 1) return null;
    }
  }
  return hits[0] ?? null;
}

/** Case, spacing and the ellipsis a truncated summary ends with are all noise
 *  for this comparison. */
function normalizeTitle(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.trim().replace(/(\.{3}|…)\s*$/, "").replace(/\s+/g, " ").toLowerCase();
}
