/*
 * Which inbox rows wait on the person, and why.
 *
 * GitHub's reason word answers most of it for free: `review_requested` and
 * `mention` need nothing more. The two that do not are the ones on the person's
 * OWN pull request: `author` says "something happened", never who did it, and
 * a review that asks for changes is not a reason at all. Those need the last
 * comments and reviews, and the only thing that matters about their author is
 * whether it is a person — a coverage bot writing on your pull request every
 * push is news to nobody.
 *
 * One GraphQL request answers every row that needs it, however many there are
 * (one alias per row; `__typename` says Bot or User without guessing at a
 * login), and each answer is kept under `id` + `updated_at`: a thread that has
 * not changed is never asked about again, so a stable inbox costs nothing on
 * top of the list's own conditional read. Measured against a stub `gh` in
 * test/gh-inbox-turn.test.ts.
 *
 * The ceilings, stated so they read as chosen: a `comment` reason (a thread you
 * wrote in, not addressed to you) is not "your turn" and is left out; a row
 * whose question failed stays out of the view and is asked again on a later
 * poll, at most once a minute, rather than being shown as bot-only on a guess;
 * and only the last five comments and five reviews are read, so a burst longer
 * than that is judged by its tail.
 */
import { gh, isBotLogin } from "./prs.ts";
import type { InboxItem, InboxTurn } from "../../shared/types.ts";

/** One comment or review on a thread, reduced to what the decision reads. */
export interface TurnEvent {
  by: string;
  /** `__typename` was User, not Bot, and the login does not end in `[bot]`. */
  human: boolean;
  at: number;
  review?: string;
  text: string;
}

export interface TurnFacts {
  reason: string;
  type: string;
  /** The signed-in login: what they wrote themselves never waits on them. */
  viewer: string;
  /** When the person last read the thread; 0 if never. */
  lastRead: number;
  /** Who opened the pull request or issue. */
  opener?: string;
  events: TurnEvent[];
}

/** GitHub's `__typename` says Bot for an app; `isBotLogin` catches the ones
 *  that review as a plain login (code scanning), measured in prs.ts. */
export const isHumanAuthor = (typename: string | undefined, login: string | undefined): boolean =>
  typename !== "Bot" && !!login && !isBotLogin(login);

/** The reasons GitHub already names: the row is the person's turn by its word. */
const DIRECT = new Set(["review_requested", "mention", "team_mention"]);

/** One line, short: what the row quotes. */
export function snippetOf(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const say = (e: TurnEvent | undefined): { by?: string; snippet?: string } =>
  e ? { by: e.by, ...(e.text ? { snippet: snippetOf(e.text) } : null) } : {};

/**
 * The decision. Undefined is "not one of the things this view is for" — a
 * thread you merely follow, your own pull request with nothing new on it —
 * and is different from `bot`, which is news that only a bot wrote and which
 * the view mentions in one quiet line instead of dropping it silently.
 */
export function classifyTurn(f: TurnFacts): InboxTurn | undefined {
  const others = f.events.filter((e) => e.by !== f.viewer).sort((a, b) => a.at - b.at);
  if (f.reason === "review_requested") return { kind: "review", ...(f.opener ? { by: f.opener } : null) };
  if (DIRECT.has(f.reason)) {
    // Who named you is a person: a bot writing after them is not who to quote.
    const last = others.filter((e) => e.human && e.at > f.lastRead).pop();
    return { kind: "mention", ...(last ? say(last) : f.opener ? { by: f.opener } : null) };
  }
  if (f.reason !== "author" || f.type !== "PullRequest") return undefined;
  const fresh = others.filter((e) => e.at > f.lastRead);
  if (!fresh.length) return undefined;
  const people = fresh.filter((e) => e.human);
  if (!people.length) return { kind: "bot", ...say(fresh[fresh.length - 1]) };
  // A block stands until the SAME reviewer says otherwise: one person approving
  // does not lift another's request for changes, and a later plain comment
  // from the blocker does not either. Judged over every review read, not only
  // the new ones — the block is older than your last read, the news is not.
  const standing = new Map<string, TurnEvent>();
  for (const e of others) if (e.human && e.review && e.review !== "COMMENTED") standing.set(e.by, e);
  const blocking = [...standing.values()].filter((e) => e.review === "CHANGES_REQUESTED").pop();
  if (blocking) return { kind: "changes", ...say(blocking) };
  return { kind: "person", ...say(people[people.length - 1]) };
}

/** A thread GitHub told us about, as much of it as the decision needs. */
export interface TurnNote {
  id: string;
  at: number;
  lastRead: number;
  unread: boolean;
  reason: string;
  type: string;
  repo: string;
  number?: number;
}

/** Only the rows the view can be about, and only those a reason cannot settle
 *  alone need the network; the rest are decided without it. */
const needsAsk = (n: TurnNote): boolean =>
  n.number !== undefined && /^[\w.-]+\/[\w.-]+$/.test(n.repo)
  && (n.type === "PullRequest" || n.type === "Issue")
  // Only what is unread is worth a question: an own pull request read after its
  // last update has nothing new on it, and a request or mention already read
  // stays a row by its reason alone, without who or what.
  && (n.reason === "author" ? n.type === "PullRequest" && n.lastRead < n.at : DIRECT.has(n.reason) && n.unread);

const AUTHOR = "author{__typename login}";
const COMMENTS = `comments(last:5){nodes{${AUTHOR} bodyText createdAt}}`;
const REVIEWS = `reviews(last:5){nodes{${AUTHOR} state bodyText submittedAt}}`;

/** One request for every row: `r0`, `r1`… are the rows, in order. */
export function turnQuery(notes: TurnNote[]): string {
  const rows = notes.map((n, i) => {
    const [owner, name] = n.repo.split("/");
    // A review request only needs to say who opened the pull request.
    const sub = n.reason === "review_requested"
      ? `pullRequest(number:${n.number}){${AUTHOR}}`
      : n.type === "PullRequest"
      ? `pullRequest(number:${n.number}){${AUTHOR} ${COMMENTS} ${REVIEWS}}`
      : `issue(number:${n.number}){${AUTHOR} ${COMMENTS}}`;
    return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${sub}}`;
  });
  return `{viewer{login} ${rows.join(" ")}}`;
}

interface RawActor { __typename?: string; login?: string }
interface RawThread {
  author?: RawActor | null;
  comments?: { nodes?: { author?: RawActor | null; bodyText?: string; createdAt?: string }[] };
  reviews?: { nodes?: { author?: RawActor | null; state?: string; bodyText?: string; submittedAt?: string }[] };
}

/** `viewer` and then `r0`, `r1`… — one alias per row asked about. */
type TurnData = { viewer?: { login?: string } } & Record<string, unknown>;

/** GitHub's answer for one row, as the decision's facts. */
export function factsFrom(n: TurnNote, viewer: string, t: RawThread): TurnFacts {
  const ev = (a: RawActor | null | undefined, when: string | undefined, text: string | undefined, review?: string): TurnEvent | null =>
    a?.login && when ? { by: a.login, human: isHumanAuthor(a.__typename, a.login), at: Date.parse(when) || 0, text: text ?? "", ...(review ? { review } : null) } : null;
  const events = [
    ...(t.comments?.nodes ?? []).map((c) => ev(c.author, c.createdAt, c.bodyText)),
    ...(t.reviews?.nodes ?? []).map((r) => ev(r.author, r.submittedAt, r.bodyText, r.state)),
  ].filter((e): e is TurnEvent => !!e);
  return { reason: n.reason, type: n.type, viewer, lastRead: n.lastRead, opener: t.author?.login, events };
}

/** `id:updated_at`, so a thread that moves is asked about again and one that
 *  does not never is. `undefined` in the map is a settled "not for this view". */
const known = new Map<string, InboxTurn | undefined>();
const KEEP = 500;
const keyOf = (n: TurnNote) => `${n.id}:${n.at}`;
let retryAfter = 0;
const RETRY_MS = 60_000;
/** Whole-request failures in a row: the wait doubles, up to ten minutes, so a
 *  broken token is not asked about once a minute for ever. */
let fails = 0;
/** A row GitHub keeps answering null for (gone, or no access) is settled as
 *  "not for this view" after this many asks, so it cannot hold the retry open. */
const GIVE_UP = 3;
const misses = new Map<string, number>();
/** Two windows reading at once share one question. */
let inflight: Promise<void> | null = null;

export function __resetTurns(): void { known.clear(); misses.clear(); retryAfter = 0; fails = 0; inflight = null; }

/** One GraphQL request for every row in `ask`; what it answers goes in `known`. */
async function fetchTurns(ask: TurnNote[]): Promise<void> {
  const r = await gh(["api", "graphql", "-f", `query=${turnQuery(ask)}`]);
  let data: TurnData | null = null;
  try { data = (JSON.parse(r.stdout) as { data?: TurnData }).data ?? null; } catch { data = null; }
  const viewer = data?.viewer?.login;
  if (!data || !viewer) { retryAfter = Date.now() + Math.min(RETRY_MS * 2 ** fails, 600_000); fails++; return; }
  fails = 0;
  ask.forEach((n, i) => {
    const repo = data[`r${i}`] as { pullRequest?: RawThread | null; issue?: RawThread | null } | null | undefined;
    const t = repo?.pullRequest ?? repo?.issue;
    if (!t) {
      retryAfter = Date.now() + RETRY_MS;
      const tries = (misses.get(keyOf(n)) ?? 0) + 1;
      misses.set(keyOf(n), tries);
      if (tries >= GIVE_UP) known.set(keyOf(n), undefined);
      return;
    }
    known.set(keyOf(n), classifyTurn(factsFrom(n, viewer, t)));
  });
  while (known.size > KEEP) known.delete(known.keys().next().value as string);
  while (misses.size > KEEP) misses.delete(misses.keys().next().value as string);
}

/**
 * The turn for each of these rows, asking GitHub once for all the ones not
 * already known. Never throws and never blocks the list: a failed question
 * leaves those rows without a turn (`pending`) until a later poll.
 */
export async function resolveTurns(notes: TurnNote[]): Promise<{ turns: Map<string, InboxTurn | undefined>; pending: boolean }> {
  const out = new Map<string, InboxTurn | undefined>();
  const ask: TurnNote[] = [];
  for (const n of notes) {
    if (!needsAsk(n)) {
      if (DIRECT.has(n.reason)) out.set(n.id, classifyTurn({ reason: n.reason, type: n.type, viewer: "", lastRead: n.lastRead, events: [] }));
    } else if (known.has(keyOf(n))) out.set(n.id, known.get(keyOf(n)));
    else ask.push(n);
  }
  if (ask.length && Date.now() >= retryAfter) await (inflight ??= fetchTurns(ask).finally(() => { inflight = null; }));
  let pending = false;
  for (const n of ask) {
    if (known.has(keyOf(n))) out.set(n.id, known.get(keyOf(n)));
    else pending = true;
  }
  return { turns: out, pending };
}

/** The rows with their turn added, same rows in the same order. `pending` says
 *  some were not answered, so the caller asks again on a later poll. */
export async function withTurns(items: InboxItem[], lastRead: Map<string, number>): Promise<{ items: InboxItem[]; pending: boolean }> {
  const { turns, pending } = await resolveTurns(items.map((i) => ({
    id: i.id, at: i.at, lastRead: lastRead.get(i.id) ?? 0, unread: i.unread, reason: i.reason, type: i.type, repo: i.repo, number: i.number,
  })));
  return {
    items: items.map((i) => {
      const turn = turns.get(i.id);
      return turn ? { ...i, turn } : i;
    }),
    pending,
  };
}
