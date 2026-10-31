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

/** The word on a row's tag: the name of the filter chip that would list it, so the tag and the chip say the same thing. */
export function tagLabel(reason: string): string {
  return FACETS.find((f) => f.reasons.includes(reason) && f.id !== "participating" && f.id !== "team")?.label ?? reasonLabel(reason);
}

const SENTENCE: Record<string, string> = {
  review_requested: "Asked for your review",
  mention: "You were mentioned",
  team_mention: "Your team was mentioned",
  assign: "You were assigned",
  author: "Activity on your pull request",
  comment: "New comment",
  subscribed: "Activity on a thread you watch",
  manual: "Activity on a thread you follow",
  state_change: "Opened or closed",
  ci_activity: "A check finished",
};

/** The quiet line under a title when nothing richer is known: what happened, in a sentence, not where. */
export const reasonSentence = (reason: string): string => SENTENCE[reason] ?? reasonLabel(reason);

/** The chips drawn at rest. The rest of the facets wait in the "More" menu, and one that is on is drawn too, so the list is never narrowed by something that cannot be seen. */
export const CHIP_FACETS = ["review", "mentioned", "ci", "assigned", "subscribed"];

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

/** The mockup's six reason chips first, then the two GitHub filters it does not draw (Team mentioned, Participating): dropping them would drop a question the inbox could answer. */
export const FACETS: InboxFacet[] = [
  { id: "review", label: "Review requested", reasons: ["review_requested"], hint: "Somebody asked you to look" },
  { id: "mentioned", label: "Mentioned", reasons: ["mention"], hint: "Somebody wrote your name" },
  { id: "ci", label: "CI", reasons: ["ci_activity"], hint: "A workflow run you are watching finished" },
  { id: "assigned", label: "Assigned", reasons: ["assign"], hint: "Put on you by somebody" },
  { id: "subscribed", label: "Subscribed", reasons: ["subscribed", "manual"], hint: "Threads you are watching without being in them" },
  { id: "team", label: "Team mentioned", reasons: ["team_mention"], hint: "Somebody wrote your team's name" },
  { id: "participating", label: "Participating", reasons: ["author", "comment", "mention", "team_mention", "assign", "review_requested", "manual"], hint: "Threads you are in, not merely watching" },
];

/** "Everything" and the named filters as chips, each with the number of rows it would leave. */
export function reasonChips(items: InboxItem[]): { id: string; label: string; hint: string; n: number }[] {
  return [
    { id: "", label: "Everything", hint: "Every reason", n: items.length },
    ...FACETS.map((f) => ({ id: f.id, label: f.label, hint: f.hint, n: items.filter((n) => inFacet(n, f.id)).length })),
  ];
}

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

/*
 * How a row looks: the tile on its left says what kind of thing woke it (a
 * review, a mention, a run) in the tone of the reason, so a column of rows can
 * be read by colour before any word.
 */
export type RowIcon = "pr" | "issue" | "ci" | "comment" | "review";
export type RowToneName = "info" | "bad" | "warn" | "muted";

export function rowLook(n: Pick<InboxItem, "type" | "reason">): { icon: RowIcon; tone: RowToneName } {
  /* The design tints the tag by what is asked: review amber, mention red, assigned blue, CI orange, the rest grey. */
  const tone: RowToneName =
    n.reason === "assign" ? "info"
    : n.reason === "mention" || n.reason === "team_mention" ? "bad"
    : n.reason === "review_requested" || n.reason === "ci_activity" ? "warn"
    : "muted";
  const icon: RowIcon =
    n.type === "CheckSuite" ? "ci"
    : n.reason === "review_requested" ? "review"
    : n.reason === "mention" || n.reason === "team_mention" || n.reason === "comment" ? "comment"
    : n.type === "Issue" ? "issue"
    : "pr";
  return { icon, tone };
}

/** What the list area shows. A refused read with nothing to show is an error, not an empty inbox: "Inbox zero" over a rate-limit answer would be a lie. */
export function inboxScreen(loaded: number | null, err: string, shown: number): "loading" | "error" | "empty" | "rows" {
  if (loaded === null) return err ? "error" : "loading";
  if (err && loaded === 0) return "error";
  return shown ? "rows" : "empty";
}

/** The words of an empty list. `clear` is set when the filter box is what emptied it, so the screen offers to clear it. */
export function emptyCopy(o: { shelf: string; repo: string; query: string; reason: boolean; unreadOnly: boolean }): { title: string; sentence: string; clear: boolean; ghost: boolean } {
  const q = o.query.trim();
  if (q) return { title: `Nothing matches \u201c${q}\u201d`, sentence: "Try fewer words, a repository or a #number.", clear: true, ghost: false };
  if (o.shelf === "turn") return { title: "Nothing waits on you", sentence: "Review requests, mentions, changes requested and people writing on your pull requests land here.", clear: false, ghost: false };
  if (o.shelf === "saved") return { title: "Nothing saved yet", sentence: "Save a notification and it stays here, on this machine.", clear: false, ghost: false };
  if (o.shelf === "done") return { title: "Nothing finished yet", sentence: "What you finish leaves the inbox and waits here.", clear: false, ghost: false };
  if (o.reason) return { title: "Nothing for this reason", sentence: "Press Everything to see the rest.", clear: false, ghost: false };
  if (o.unreadOnly) return { title: "Nothing unread", sentence: "Every notification here has been read.", clear: false, ghost: false };
  return { title: "Inbox zero", sentence: `GitHub notifications for ${o.repo || "this repository"} land here.`, clear: false, ghost: true };
}
