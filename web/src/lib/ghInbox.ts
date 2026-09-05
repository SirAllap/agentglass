/*
 * The inbox, narrowed.
 *
 * GitHub's own page answers three questions with three controls — is it unread,
 * why did it reach me, which repository is it in — and the useful part is that
 * they COMPOSE: "unread review requests in the work repo" is the question
 * somebody actually has on a Monday. Kept out of the component so the
 * composition can be tested without a list on screen.
 */
import type { InboxItem } from "../../../shared/types.ts";

export interface InboxFilter {
  /** Only what has not been read. */
  unread?: boolean;
  /** GitHub's own reason word, or empty for any. */
  reason?: string;
  /** `owner/name`, or empty for any. */
  repo?: string;
}

export function filterInbox(items: InboxItem[], f: InboxFilter): InboxItem[] {
  return items.filter((n) =>
    (!f.unread || n.unread)
    && (!f.reason || n.reason === f.reason)
    && (!f.repo || n.repo === f.repo));
}

/** How many rows each value of one facet would leave, with the OTHER facets
 *  still applied — the count on a chip has to answer "what happens if I press
 *  this", not "how many exist somewhere". */
export function facetCounts(items: InboxItem[], f: InboxFilter, of: "reason" | "repo"): Map<string, number> {
  const rest: InboxFilter = { ...f, [of]: "" };
  const out = new Map<string, number>();
  for (const n of filterInbox(items, rest)) out.set(n[of], (out.get(n[of]) ?? 0) + 1);
  return out;
}

/** Facet values, busiest first, with a stable tie-break so the row does not
 *  reshuffle itself every poll. */
export function facetOrder(counts: Map<string, number>): { value: string; n: number }[] {
  return [...counts.entries()]
    .map(([value, n]) => ({ value, n }))
    .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** GitHub's reason words, in the app's own language. Unknown ones are shown as
 *  they came — their list grows, and a mapping that swallows what is new would
 *  hide exactly the notification worth reading. */
const REASONS: Record<string, string> = {
  mention: "mentioned you",
  team_mention: "mentioned your team",
  review_requested: "asked for your review",
  assign: "assigned to you",
  author: "yours",
  comment: "commented",
  subscribed: "watching",
  state_change: "opened or closed",
  ci_activity: "checks",
  manual: "you subscribed",
  security_alert: "security",
};

export const reasonLabel = (reason: string): string => REASONS[reason] ?? reason.replace(/_/g, " ");

/** The unread count for the tab — the only number the panel shows before the
 *  inbox is open, so it is the whole of what it promises. */
export const unreadCount = (items: InboxItem[]): number => items.filter((n) => n.unread).length;

/**
 * Group rows by day, newest first, the way a mail client does.
 *
 * Not by repository: the question this list answers is "what happened while I
 * was away", which is a question about time. The repository is a chip.
 */
export function byDay(items: InboxItem[], now = Date.now()): { label: string; items: InboxItem[] }[] {
  const day = (ms: number) => new Date(ms).toDateString();
  const today = day(now);
  const yesterday = day(now - 86_400_000);
  const out: { label: string; items: InboxItem[] }[] = [];
  for (const n of items) {
    const d = day(n.at);
    const label = d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(n.at).toLocaleDateString([], { day: "numeric", month: "short" });
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(n);
    else out.push({ label, items: [n] });
  }
  return out;
}

/*
 * The named filters, which are GitHub's own left rail.
 *
 * Each is a set of reasons rather than a call: the API can filter
 * `participating=true` server-side, but that is a second request answering a
 * question the rows already carry, and switching a filter must not cost a round
 * trip. "Participating" is GitHub's own definition — the threads you are in
 * rather than merely watching.
 */
export interface InboxFacet {
  id: string;
  label: string;
  /** Drawn beside the label. Emoji on purpose: these are GitHub's own marks and
   *  the row is read at a glance, not at 16px of stroke. */
  mark: string;
  reasons: string[];
  hint: string;
}

export const FACETS: InboxFacet[] = [
  { id: "assigned", label: "Assigned", mark: "◎", reasons: ["assign"], hint: "Put on you by somebody" },
  { id: "participating", label: "Participating", mark: "❞", reasons: ["author", "comment", "mention", "team_mention", "assign", "review_requested", "manual"], hint: "Threads you are in, not merely watching" },
  { id: "mentioned", label: "Mentioned", mark: "✋", reasons: ["mention"], hint: "Somebody wrote your name" },
  { id: "team", label: "Team mentioned", mark: "❊", reasons: ["team_mention"], hint: "Somebody wrote your team's name" },
  { id: "review", label: "Review requested", mark: "◉", reasons: ["review_requested"], hint: "Somebody asked you to look" },
];

export const facetById = (id: string): InboxFacet | undefined => FACETS.find((f) => f.id === id);

/** Does this row belong to that named filter? An unknown id filters nothing,
 *  which is the safe direction: a facet we do not understand must not hide
 *  somebody's inbox. */
export function inFacet(item: InboxItem, id: string): boolean {
  const f = facetById(id);
  return !f || f.reasons.includes(item.reason);
}

/** Which rows a search box leaves. Number, title and repository — the three
 *  things a row shows — and a bare `#123` finds that number rather than every
 *  title with those digits in it. */
export function searchInbox(items: InboxItem[], q: string): InboxItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  const num = /^#?(\d+)$/.exec(needle);
  if (num) return items.filter((n) => String(n.number ?? "") === num[1]);
  return items.filter((n) => `${n.title} ${n.repo} #${n.number ?? ""} ${n.reason}`.toLowerCase().includes(needle));
}
