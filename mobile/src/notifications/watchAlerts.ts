/*
 * Which pull-request watches and cards are worth a buzz on THIS phone, and how
 * many notifications they make.
 *
 * Pure and separate from the raising, like policy.ts, because the decision is
 * the feature. The server already decided WHAT is worth telling (a rule the
 * person armed on a pull request, a card of theirs that moved); what is left
 * here is how to say it without a storm:
 *
 *   * one notification per pull request or card (`group`): a later fire on the
 *     same one replaces the earlier, it does not stack under it;
 *   * what the phone missed while it was offline arrives as ONE summary, not
 *     one buzz per fire (`decideCatchUp`);
 *   * nothing while the app is on screen (the lists already move) or while the
 *     person has switched the phone off.
 *
 * Everything that comes from a frame is data: ids, numbers and paths are shape-
 * checked here (target.ts) before they reach a notification, and text is cut to
 * a line.
 *
 * Ceiling: the phone hears this only while its socket is up, so an app that
 * was killed with the keep-alive off raises nothing until it next opens, and a
 * card that moved in that time is lost (the computer keeps no backlog of card
 * notes; pull-request fires come back through the open alerts, see
 * decideCatchUp). One switch for every paired phone, not one per phone.
 * Live, many different pull requests firing in one tick are still one
 * notification each; only a reconnect is merged. The summary is dismissed by
 * the person, not by closing its alerts on the desk.
 */
import type { AskedAlert } from "../../../shared/notifyPayload.ts";
import { oneLine } from "../../../shared/notifyPayload.ts";
import type { CardNote, PrWatchFire } from "../../../shared/types.ts";
import { SAME_ALERT_MS } from "./policy.ts";
import { validAlertId, validCardId, validPrNumber, validRepo, validRoot } from "./target.ts";

export interface WatchItem {
  /** What makes two of these the same event. */
  id: string;
  /** The thing it is about; one notification per group. */
  group: string;
  title: string;
  body: string;
  /** A failure or a mention: worth a heads-up rather than a quiet line. */
  urgent: boolean;
  /** The server's own record of the alert, when there is one: what a tap closes
   *  and a close elsewhere takes down. */
  alertId?: string;
  /** Server time it was raised; only set for an alert read back from the server. */
  at?: number;
  pr?: { repo: string; number: number; root?: string };
  card?: { id: string };
}

/** What `notify.ts` draws. `tag` replaces: the same tag is the same notification. */
export interface WatchRaise {
  tag: string;
  title: string;
  body: string;
  urgent: boolean;
  /** Rides in the notification and comes back on a tap, as untrusted data. */
  data: { kind: "watch"; pr?: number; repo?: string; root?: string; card?: string; alertId?: string; summary?: true };
}

/** Frame text is data of unknown type: anything that is not a string is nothing. */
const str = (x: unknown): string => (typeof x === "string" ? x : "");

const TITLE_MAX = 80;
const BODY_MAX = 120;

function prItem(i: { id: string; alertId?: string; repo: string; number: number; title: string; body: string; ok: boolean; root?: string; at?: number }): WatchItem | null {
  if (!validRepo(i.repo) || !validPrNumber(i.number)) return null;
  const title = oneLine(str(i.title), TITLE_MAX);
  if (!title) return null;
  return {
    id: i.id,
    group: `pr:${i.repo}#${i.number}`,
    title,
    body: oneLine(str(i.body), BODY_MAX),
    urgent: i.ok === false,
    ...(validAlertId(i.alertId) ? { alertId: i.alertId } : {}),
    ...(i.at !== undefined ? { at: i.at } : {}),
    pr: { repo: i.repo, number: i.number, ...(validRoot(i.root) ? { root: i.root } : {}) },
  };
}

const rootOf = (t: { kind?: string; root?: string } | undefined): string | undefined => (t?.kind === "pr" ? t.root : undefined);

/** A watch that just fired, from the `prwatchfire` frame. */
export function itemFromFire(f: PrWatchFire): WatchItem | null {
  if (!f || typeof f !== "object") return null;
  return prItem({
    id: validAlertId(f.alertId) ? f.alertId : `fire:${f.seq}`,
    alertId: f.alertId, repo: f.repo, number: f.number, ok: f.ok, root: rootOf(f.payload?.target),
    title: str(f.payload?.title) || `${str(f.summary)} · ${f.repo} #${f.number}`,
    body: str(f.payload?.line) || str(f.detail) || str(f.title),
  });
}

/** An alert the computer still holds open, read back after the phone was away. */
export function itemFromAsked(a: AskedAlert): WatchItem | null {
  const t = a?.payload?.target;
  if (!a || !validAlertId(a.id) || t?.kind !== "pr" || typeof a.firedAt !== "number") return null;
  return prItem({ id: a.id, alertId: a.id, repo: t.repo, number: t.number, ok: a.ok, root: t.root, title: a.payload.title, body: a.payload.line, at: a.firedAt });
}

/**
 * A card of yours that moved. Only what somebody SAID: a comment or a mention.
 * A status or assignment note carries no author, so it includes the person's
 * own moves, and the desk draws those in the bell without an OS pop-up too.
 * Jira cards have no screen on the phone.
 */
export function itemFromCard(c: CardNote): WatchItem | null {
  if (!c || c.tracker === "jira" || !validCardId(c.id)) return null;
  if (c.kind !== "comment" && c.kind !== "mention") return null;
  const label = oneLine(str(c.label) || c.id, 40);
  const who = oneLine(str(c.who) || "Somebody", 40);
  const title = c.kind === "mention" ? `${who} mentioned you on ${label}` : `${who} commented on ${label}`;
  const body = oneLine(str(c.said) || str(c.title), BODY_MAX);
  return {
    id: `card:${c.id}:${c.kind}:${str(c.status)}:${str(c.said)}`,
    group: `card:${c.id}`,
    title: oneLine(title, TITLE_MAX), body,
    urgent: c.kind === "mention",
    card: { id: c.id },
  };
}

const raiseOf = (i: WatchItem): WatchRaise => ({
  tag: i.group,
  title: i.title,
  body: i.body,
  urgent: i.urgent,
  data: {
    kind: "watch",
    ...(i.pr ? { pr: i.pr.number, repo: i.pr.repo, ...(i.pr.root ? { root: i.pr.root } : {}) } : {}),
    ...(i.card ? { card: i.card.id } : {}),
    ...(i.alertId ? { alertId: i.alertId } : {}),
  },
});

export interface WatchContext {
  /** The phone's switch: "Alerts on this phone". */
  enabled: boolean;
  /** The app is open and on screen. */
  foreground: boolean;
  /** Event id to when it was handled. Shared by live frames and the catch-up, so
   *  the one that arrives second finds the first. */
  handled: Map<string, number>;
  now: number;
}

export type WatchVerdict =
  | { notify: true; raise: WatchRaise }
  | { notify: false; because: "off" | "foreground" | "repeat" | "empty" };

/**
 * Should this one fire buzz?
 *
 *   * `off` — the phone's switch.
 *   * `foreground` — the app is open on it. The lists and the open screen move
 *     on the same frame; a notification over them is the app telling you what
 *     you can see.
 *   * `repeat` — the same event inside `SAME_ALERT_MS`: a live frame and the
 *     catch-up after a reconnect can carry one fire between them.
 *   * `empty` — nothing to say.
 */
export function decideLive(item: WatchItem | null, ctx: WatchContext): WatchVerdict {
  if (!item || !item.title.trim()) return { notify: false, because: "empty" };
  if (!ctx.enabled) return { notify: false, because: "off" };
  const at = ctx.handled.get(item.id);
  if (at !== undefined && ctx.now - at < SAME_ALERT_MS) return { notify: false, because: "repeat" };
  if (ctx.foreground) return { notify: false, because: "foreground" };
  return { notify: true, raise: raiseOf(item) };
}

/** Remember that this event was handled, and forget the ones too old to matter. */
export function markHandled(handled: Map<string, number>, id: string, now: number): void {
  handled.set(id, now);
  for (const [k, at] of handled) if (now - at > SAME_ALERT_MS * 4) handled.delete(k);
}

/**
 * How far the phone has been told about a computer's open alerts: the newest
 * server time seen, and the ids seen AT that time. Fires from one tick of the
 * watch share a timestamp, so the time alone would skip the second of two (a
 * fire that came while the socket was down, stamped like the one before it).
 */
export interface Cursor { at: number; ids: string[] }

export const NO_CURSOR: Cursor = { at: 0, ids: [] };

/** The cursor after seeing one alert. */
export function advanceCursor(c: Cursor, at: number, id: string): Cursor {
  if (at > c.at) return { at, ids: [id] };
  if (at === c.at && !c.ids.includes(id)) return { at, ids: [...c.ids, id] };
  return c;
}

/** The further of two cursors, joined when they stand at the same time. */
export function mergeCursor(a: Cursor, b: Cursor): Cursor {
  return b.ids.reduce((c, id) => advanceCursor(c, b.at, id), a.at >= b.at ? a : { at: b.at, ids: [] });
}

export interface CatchUp {
  /** What to draw: nothing, the one thing, or one summary. */
  raise: WatchRaise | null;
  /** Every event not handled yet, to be remembered whatever was drawn: a switch
   *  that is off, or a screen that was open, still counts as having been told. */
  seen: string[];
  /** Where the next reconnect starts: past everything looked at here, handled
   *  already or not, so a live frame that got there first cannot leave it behind. */
  cursor: Cursor;
}

/**
 * What the phone missed while it was away: the alerts the computer still holds
 * open that were raised after the cursor and have not been handled here.
 *
 * Collapsed to one per pull request (the latest wins), then one notification at
 * most: the item itself when only one pull request moved, otherwise a single
 * summary that names the first few. A reconnect after a night in a pocket is
 * one buzz, not one per fire.
 */
export function decideCatchUp(items: (WatchItem | null)[], cursor: Cursor, ctx: WatchContext): CatchUp {
  const after = items.filter((i): i is WatchItem => !!i && ((i.at ?? 0) > cursor.at || ((i.at ?? 0) === cursor.at && !cursor.ids.includes(i.id))));
  const next = after.reduce((c, i) => advanceCursor(c, i.at ?? 0, i.id), cursor);
  const fresh = after.filter((i) => !ctx.handled.has(i.id));
  const seen = fresh.map((i) => i.id);
  if (!fresh.length || !ctx.enabled || ctx.foreground) return { raise: null, seen, cursor: next };

  const latest = new Map<string, WatchItem>();
  for (const i of [...fresh].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) latest.set(i.group, i);
  const groups = [...latest.values()];
  if (groups.length === 1) return { raise: raiseOf(groups[0]!), seen, cursor: next };

  const named = groups.slice(-3).reverse().map((g) => (g.pr ? `#${g.pr.number}` : g.card ? g.card.id : "")).filter(Boolean).join(", ");
  const more = groups.length > 3 ? ` +${groups.length - 3}` : "";
  return {
    raise: {
      tag: "summary",
      title: `${groups.length} updates while you were away`,
      body: oneLine(`${named}${more}`, BODY_MAX),
      urgent: groups.some((g) => g.urgent),
      data: { kind: "watch", summary: true },
    },
    seen, cursor: next,
  };
}
