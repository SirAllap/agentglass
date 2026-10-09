/*
 * The inbox, narrowed.
 *
 * GitHub's own page answers three questions with three controls — is it unread,
 * why did it reach me, which repository is it in — and the useful part is that
 * they COMPOSE: "unread review requests in the work repo" is the question
 * somebody actually has on a Monday. Kept out of the component so the
 * composition can be tested without a list on screen.
 */
import type { InboxItem, InboxTurn, InboxTurnKind } from "../../../shared/types.ts";

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

/*
 * Your turn: what waits on the person, as opposed to what merely happened.
 *
 * The decision is made where the facts are — the server reads who wrote what
 * and says so in `turn` (server/src/ghinbox-turn.ts) — so this is only the
 * two questions a view asks of it. A row with no `turn` is not one of the
 * things the view is for, and a `bot` turn is news that only a bot wrote:
 * counted, never a row.
 */
export const yourTurn = (n: InboxItem): boolean => !!n.turn && n.turn.kind !== "bot";
export const botOnly = (n: InboxItem): boolean => n.turn?.kind === "bot";

/** The chip a row on that view wears, instead of GitHub's reason word. */
export const TURN_CHIP: Record<InboxTurnKind, { label: string; tone: "accent" | "warn" | "neutral" }> = {
  review: { label: "review requested", tone: "accent" },
  changes: { label: "changes requested", tone: "warn" },
  person: { label: "new comment from a person", tone: "neutral" },
  mention: { label: "mention", tone: "neutral" },
  bot: { label: "bot only", tone: "neutral" },
};

/** The quiet second line: who, then what they said — or, for a request, what
 *  they asked. Empty when GitHub gave neither. */
export function turnLine(t: InboxTurn): { by: string; text: string } {
  const by = t.by ?? "";
  if (t.kind === "review") return { by, text: by ? "asked for your review" : "" };
  return { by, text: t.snippet ? `\u201c${t.snippet}\u201d` : "" };
}

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
  reasons: string[];
  hint: string;
}

export const FACETS: InboxFacet[] = [
  { id: "assigned", label: "Assigned", reasons: ["assign"], hint: "Put on you by somebody" },
  { id: "participating", label: "Participating", reasons: ["author", "comment", "mention", "team_mention", "assign", "review_requested", "manual"], hint: "Threads you are in, not merely watching" },
  { id: "mentioned", label: "Mentioned", reasons: ["mention"], hint: "Somebody wrote your name" },
  { id: "team", label: "Team mentioned", reasons: ["team_mention"], hint: "Somebody wrote your team's name" },
  { id: "review", label: "Review requested", reasons: ["review_requested"], hint: "Somebody asked you to look" },
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

/*
 * What plugins say about rows: a number to order by, and the plugins that gave
 * one.
 *
 * The order is a CHOICE the person makes — "Sort: <plugin>" — and the default
 * stays newest first, so installing a plugin never moves a row on its own. It
 * reorders and nothing else: `orderByAnnotation` returns every row it was
 * given, and the ceiling is stated here rather than discovered — a row the
 * plugin gave no number sorts after the ones it did, newest first, so a
 * plugin that wants an unknown row in the middle says so with a number.
 */

/** The number a plugin ordered a row by: `rank` when it set one, else `score`. */
export function annotationKey(item: InboxItem, plugin: string): number | undefined {
  const a = item.annotations?.find((x) => x.plugin === plugin);
  return a?.rank ?? a?.score;
}

/** Plugins that ordered at least one of these rows, in the order first seen. */
export function sorters(items: InboxItem[]): string[] {
  const out: string[] = [];
  for (const n of items) {
    for (const a of n.annotations ?? []) {
      if ((a.rank ?? a.score) !== undefined && !out.includes(a.plugin)) out.push(a.plugin);
    }
  }
  return out;
}

/** Highest number first; ties and unnumbered rows newest first. Never drops a row. */
export function orderByAnnotation(items: InboxItem[], plugin: string): InboxItem[] {
  return [...items].sort((a, b) => {
    const ka = annotationKey(a, plugin);
    const kb = annotationKey(b, plugin);
    if (ka !== undefined && kb !== undefined && ka !== kb) return kb - ka;
    if ((ka === undefined) !== (kb === undefined)) return ka === undefined ? 1 : -1;
    return b.at - a.at;
  });
}
