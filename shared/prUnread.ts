/*
 * The pure half of "what have I not read yet": shared by the browser (prNew.ts,
 * prUnread.ts) and the phone, which counts the same way so a badge on one and
 * the divider on the other never disagree. Nothing here touches storage; the
 * marks arrive as an argument.
 */
import type { PrDetail, PrSummary, PrTalk } from "./types.ts";
import { reviewSpeaks } from "./prConversation.ts";

/** `owner/repo#123`. The repo is part of it because pull request numbers are
 *  per repository and a bare number collides across every project you have. */
export function prSeenKey(repo: string | undefined, number: number): string {
  return `${repo || "?"}#${number}`;
}

/** Epoch milliseconds, or 0 for anything unparseable — an unreadable date must
 *  not read as "just now" and put a NEW badge on a two-year-old comment. */
export function at(iso: string | undefined | null): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/** The keys a conversation remark carries as an atom, one place so whoever
 *  matches atoms back to what it draws (the phone's Talk pane) cannot drift. */
export const commentAtomKey = (id: number | string): string => `c${id}`;
export const reviewAtomKey = (r: { author: string; submittedAt: string }): string => `r${r.author}-${r.submittedAt}`;

/** When the newest comment or review on this pull request was written. */
export function newestAt(d: Pick<PrDetail, "comments" | "reviews">): number {
  let n = 0;
  for (const c of d.comments) n = Math.max(n, at(c.createdAt));
  for (const r of d.reviews) n = Math.max(n, at(r.submittedAt));
  return n;
}

/** One thing that has been said since your last visit, in the order it was
 *  said. `key` is the anchor the jump scrolls to. */
export interface NewAtom {
  key: string;
  at: number;
  author: string;
  /** Human-readable place, for the bar: a path or "the conversation". */
  where: string;
  kind: "thread" | "comment" | "review";
  /** The thread it belongs to, when it is a reply. */
  threadId?: string;
}

/**
 * Everything said since `since`, oldest first.
 *
 * `since` of 0 means "never looked at this one" and returns nothing on purpose.
 * The first time you open a pull request every comment on it is, technically,
 * new to you — and a bar announcing "41 new" on a pull request you have simply
 * never seen is noise dressed as news. The visit is recorded and the next
 * arrival is the first thing marked.
 *
 * Your own remarks never count. A reply you just posted is not something to go
 * and find, and counting it means the badge lights up because you spoke.
 *
 * Neither does automation, unless asked for. On a live pull request the
 * machines outnumber the people two to one — that ratio is the whole reason
 * this panel has a Humans filter — so counting them would light this up on
 * every push and turn "3 new" into a number nobody reads. A coverage report is
 * not somebody waiting on you.
 */
export function newSince(
  d: PrDetail | null | undefined,
  since: number,
  opts: { includeBots?: boolean } = {},
): NewAtom[] {
  if (!d || !since) return [];
  const out: NewAtom[] = [];
  const mine = (viewerDidAuthor?: boolean) => viewerDidAuthor === true;
  const machine = (isBot?: boolean) => !opts.includeBots && isBot === true;

  for (const t of d.threads ?? []) {
    for (const c of t.comments) {
      const when = at(c.createdAt);
      if (when <= since || mine(c.viewerDidAuthor) || machine(c.isBot)) continue;
      out.push({
        key: `${t.id}:${c.id}`, at: when, author: c.author, kind: "thread",
        where: t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "a line comment",
        threadId: t.id,
      });
    }
  }
  for (const c of d.comments ?? []) {
    const when = at(c.createdAt);
    if (when <= since || mine(c.viewerDidAuthor) || machine(c.isBot)) continue;
    out.push({ key: commentAtomKey(c.id), at: when, author: c.author, kind: "comment", where: "the conversation" });
  }
  for (const r of d.reviews ?? []) {
    const when = at(r.submittedAt);
    if (when <= since || mine(r.viewerDidAuthor) || machine(r.isBot) || !reviewSpeaks(r)) continue;
    out.push({ key: reviewAtomKey(r), at: when, author: r.author, kind: "review", where: "a review" });
  }

  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/**
 * What counts as "last looked" on a pull request this browser has no mark for.
 *
 * The first version had no answer to this and returned nothing, which is
 * defensible and useless: the pull request you are staring at right now is
 * exactly the one with no mark, so the feature announced itself by doing
 * nothing at all. Measured with the panel open on a thread where somebody had
 * answered two days after the viewer wrote: nothing was marked.
 *
 * The honest fallback is your own last word. Everything after the last thing
 * YOU said on a pull request is, by definition, the part you have not answered
 * — it is the same question as "what came in while I was away", asked of a
 * pull request instead of of a browser. And it is exactly the case that hurts:
 * a reply to your comment, buried in a thread you started.
 *
 * Still 0 for a pull request you have never spoken on. There, everything is
 * somebody else's conversation and marking all of it as owed to you would be
 * an opinion, not a fact.
 */
export function bootstrapSince(d: PrDetail | null | undefined): number {
  if (!d) return 0;
  let last = 0;
  const mine = (v: boolean | undefined, iso: string | undefined) => {
    if (v === true) last = Math.max(last, at(iso));
  };
  for (const t of d.threads ?? []) for (const c of t.comments) mine(c.viewerDidAuthor, c.createdAt);
  for (const c of d.comments ?? []) mine(c.viewerDidAuthor, c.createdAt);
  for (const r of d.reviews ?? []) mine(r.viewerDidAuthor, r.submittedAt);
  return last;
}

/** What a card says, and enough of why to put it on the tooltip. */
export interface Unread {
  /** Remarks, counted the way the conversation counts them. */
  count: number;
  /** Who said the newest one. */
  who: string;
  /** Everybody with something unread on it, newest speaker first. */
  people: string[];
  /** The newest review verdict among them, when one of them was a review — the
   *  difference between "somebody commented" and "somebody blocked this". */
  state?: PrTalk["state"];
  /** When the newest one arrived, ISO. */
  at: string;
}

/**
 * How much there is to read in one remark.
 *
 * A review is one entry carrying up to a hundred: `lines` is how many line
 * comments arrived in that batch, and the conversation lists each of them. A
 * review that only exists to carry them (`says` false — see mapTalk) is not
 * itself something to read, or every batch of three would count as four.
 */
export function weightOf(t: PrTalk): number {
  const lines = t.lines ?? 0;
  if (t.kind === "review") return lines + (t.says ? 1 : 0);
  return 1;
}

/**
 * The mark to count against, for a row this browser has never opened.
 *
 * The same fallback the conversation uses, and for the same reason: the pull
 * request you have never opened is exactly the one with no mark, so "nothing is
 * new until you have been here once" makes the feature introduce itself by doing
 * nothing. Everything after your own last word on it is, by definition, the part
 * you have not answered.
 *
 * Zero when you have never spoken on it either — which is honest. A pull request
 * you have never opened and never commented on is not "eleven unread", it is one
 * you have not started.
 */
export function bootstrapMark(talk: PrTalk[]): number {
  let mine = 0;
  for (const t of talk) if (t.mine) mine = Math.max(mine, at(t.at));
  return mine;
}

/**
 * What is unread on this row, or null for "nothing to say".
 *
 * Null covers three different situations on purpose, because a card treats them
 * identically — it draws nothing:
 *
 *   no talk yet     the list's second pass has not landed. An absent answer is
 *                   not an empty one, and a badge that appears a second after
 *                   the card does is a board that moves while you read it.
 *   no mark         never looked, never spoke. See bootstrapMark.
 *   nothing new     the ordinary case.
 */
export function unreadOf(
  pr: Pick<PrSummary, "number" | "talk">,
  repoKey: string | undefined,
  seen: Record<string, number>,
): Unread | null {
  const talk = pr.talk;
  if (!talk?.length) return null;
  const mark = seen[prSeenKey(repoKey, pr.number)] ?? bootstrapMark(talk);
  if (!mark) return null;
  /* Yours never counts. A remark you left is not something to go and find, and
     counting it lights the badge because you spoke. */
  const fresh = talk.filter((t) => !t.mine && at(t.at) > mark);
  if (!fresh.length) return null;
  const newestFirst = [...fresh].sort((a, b) => at(b.at) - at(a.at));
  const people: string[] = [];
  for (const t of newestFirst) if (t.who && !people.includes(t.who)) people.push(t.who);
  const verdict = newestFirst.find((t) => t.state && t.state !== "COMMENTED")
    ?? newestFirst.find((t) => t.kind === "review");
  return {
    count: fresh.reduce((n, t) => n + weightOf(t), 0),
    who: newestFirst[0]!.who,
    people,
    ...(verdict?.state ? { state: verdict.state } : null),
    at: newestFirst[0]!.at,
  };
}

/** The badge's own sentence, for its tooltip. Says who and what, because
 *  "2 new" tells you to go and look without telling you whether you need to. */
export function unreadTitle(u: Unread): string {
  const what = u.count === 1 ? "1 new remark" : `${u.count} new remarks`;
  const who = u.people.length === 1 ? u.people[0]
    : `${u.people.slice(0, 3).join(", ")}${u.people.length > 3 ? ` +${u.people.length - 3}` : ""}`;
  const verdict = u.state === "CHANGES_REQUESTED" ? " — changes requested"
    : u.state === "APPROVED" ? " — approved"
    : u.state === "DISMISSED" ? " — a review was dismissed" : "";
  return `${what} since you last looked, from ${who}${verdict}`;
}

/**
 * The key a pull request's mark is stored under, worked out from its own url.
 *
 * The browser keys by the repository it has open (`github.com/acme/orbit`); the
 * phone has the row and nothing else, and the row's url is that same string
 * with `/pull/42` after it. Same shape by construction, so a mark written on
 * one device is read on the other. The ceiling: the browser's key comes from
 * the git remote and this one from GitHub's canonical spelling, so a remote
 * written in another letter case would not match.
 */
export function prRepoKey(pr: Pick<PrSummary, "url">): string | undefined {
  return /^https?:\/\/([^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(pr.url ?? "")?.[1];
}

export const prMarkKey = (pr: Pick<PrSummary, "number" | "url">): string => prSeenKey(prRepoKey(pr), pr.number);
