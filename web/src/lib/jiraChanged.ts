/*
 * "What changed since you last looked", per card and per board. Pure: the store (jiraChangedStore.ts) keeps the
 * snapshots, this file only compares one with what the board has loaded now.
 *
 * Nothing is fetched. A board read carries the card's status, assignees, comment count and updated time, so those
 * are what a snapshot holds and what the reason is built from. Who moved a card, and a mention of you, live in the
 * history and the comment bodies, which a board read does not carry; a caller that has them loaded (the open card)
 * passes them in `more` and the sentence gains the name. Ceiling: on a board tile a move reads "moved to Code
 * review" without a name, and a mention is only seen where the comments are loaded.
 */

/** What was true of a card the last time it was looked at. `mine`: assigned to the connected account. */
export interface Snap { at: number; status: string; assignees: string[]; comments: number | null; mine: boolean }

/** The fields of a loaded card this file reads (a ProviderTask has them all). */
export interface SeenCard { id: string; status: string; assignees: readonly string[]; comments?: number | undefined; updated?: number | undefined; created?: number | undefined; mine?: boolean | undefined; url?: string }

/** Loaded detail, when there is some: the history rows and comments, to name who and to find a mention. */
export interface More {
  events?: readonly { at: number; kind: string; status?: string | undefined; who?: string | undefined }[];
  comments?: readonly { at: number; who: string; text: string; mine?: boolean | undefined }[];
  /** The connected account's display name, for "mentions you". */
  me?: string | undefined;
}

export type ChangeKind = "mention" | "comments" | "moved" | "assigned" | "new" | "edited";
/** `count`: new comments, when there are any. `who`: who wrote them, only where the comments are loaded (a board read has no names). */
export interface Change { kinds: ChangeKind[]; reason: string; count?: number; who?: string[] }

export const snapOf = (c: SeenCard, at: number): Snap => ({ at, status: c.status, assignees: [...c.assignees], comments: c.comments ?? null, mine: !!c.mine });

/** The site a card belongs to, for keying what was seen: its address's host. Empty when the card has no address. */
export function siteOf(c: { url?: string | undefined }): string {
  try { return c.url ? new URL(c.url).host : ""; } catch { return ""; }
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const first = (name: string): string => { const p = name.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1]![0]}.` : name; };

/**
 * Whether the card moved since `base`, and the one line that says how. No snapshot, no claim: a card never looked at
 * is not "changed", or the first visit would mark everything. Priority of the line: a mention, comments, a move, an
 * assignment, then a bare edit; two reasons at most.
 */
export function changeOf(c: SeenCard, base: Snap | undefined, more: More = {}): Change | null {
  if (!base || !c.updated || c.updated <= base.at) return null;
  const kinds: ChangeKind[] = [];
  const parts: string[] = [];
  const me = more.me?.trim().toLowerCase();
  const fresh = (more.comments ?? []).filter((m) => m.at > base.at && !m.mine);
  const mention = me ? fresh.find((m) => m.text.toLowerCase().includes(`@${me}`)) : undefined;
  if (mention) { kinds.push("mention"); parts.push(`${first(mention.who)} mentioned you`); }
  const added = c.comments != null && base.comments != null ? c.comments - base.comments : fresh.length;
  if (added > 0) { kinds.push("comments"); parts.push(plural(added, "new comment")); }
  if (c.status !== base.status) {
    const ev = [...(more.events ?? [])].reverse().find((e) => e.kind === "status" && e.at > base.at && e.who);
    kinds.push("moved"); parts.push(`moved to ${c.status}${ev?.who ? ` by ${first(ev.who)}` : ""}`);
  }
  if (c.mine && !base.mine) { kinds.push("assigned"); parts.push("assigned to you"); }
  else if (c.assignees.join("|") !== base.assignees.join("|")) { kinds.push("assigned"); parts.push(c.assignees.length ? `assigned to ${c.assignees.map(first).join(", ")}` : "unassigned"); }
  if (!kinds.length) { kinds.push("edited"); parts.push("edited"); }
  const who = [...new Set(fresh.map((m) => first(m.who)))];
  return { kinds, reason: parts.slice(0, 2).join(", "), ...(added > 0 ? { count: added } : null), ...(who.length ? { who } : null) };
}

/**
 * The words on a card's chip, as the pull request card says its remarks: "1 new comment", then "2 new". A change with no
 * new comment keeps its own reason ("moved to Done"), which is why the chip also covers moves and assignments.
 */
export const chipWords = (ch: Change): string => (ch.count ? (ch.count === 1 ? "1 new comment" : `${ch.count} new`) : ch.reason);

/** The chip's tooltip, the pull request's sentence: what, since when, and from whom when the comments are loaded. */
export function sinceLooked(ch: Change): string {
  const from = ch.who?.length ? `, from ${ch.who.slice(0, 3).join(", ")}${ch.who.length > 3 ? ` +${ch.who.length - 3}` : ""}` : "";
  return `${ch.reason} since you last looked${from}`;
}

/** The comments written since `since` by somebody else, oldest first. `since` 0: never looked, so nothing is new. */
export function freshComments<C extends { id: string; at: number; mine?: boolean | undefined }>(comments: readonly C[], since: number): C[] {
  return since ? comments.filter((c) => c.at > since && !c.mine).sort((a, b) => a.at - b.at) : [];
}

/** A card made after the board was last opened (and with no snapshot of its own): new here. */
export function newSinceBoard(c: SeenCard, boardAt: number): Change | null {
  return boardAt && c.created && c.created > boardAt ? { kinds: ["new"], reason: "new card" } : null;
}

/** Every changed card of a board, by id. `boardAt` 0 means the board was never opened: nothing is flagged. */
export function changedMap(cards: readonly SeenCard[], snaps: Readonly<Record<string, Snap>>, boardAt: number, key: (c: SeenCard) => string): Map<string, Change> {
  const out = new Map<string, Change>();
  for (const c of cards) {
    const snap = snaps[key(c)];
    const ch = snap ? changeOf(c, snap) : newSinceBoard(c, boardAt);
    if (ch) out.set(c.id, ch);
  }
  return out;
}

/** The header chip's words. */
export const changedChip = (n: number): string => `${n} changed since you looked`;

type Laned = { cards: readonly { id: string }[]; sub?: readonly Laned[] | undefined };
const laneOnly = <L extends Laned>(l: L, keep: (id: string) => boolean): L => ({ ...l, cards: l.cards.filter((c) => keep(c.id)), ...(l.sub ? { sub: l.sub.map((s) => laneOnly(s, keep)) } : {}) });

/**
 * Keep the cards `keep` says yes to, in the cards list and in every lane, with the shown count to match. Lanes nest
 * (a swimlane's `sub` lanes): the board draws the innermost lanes' cards, so those are filtered too. Measured: a
 * board of 355 cards with one changed still drew 355 when only the outer lanes were filtered.
 */
export function onlyCards<M extends { cards: readonly { id: string }[]; lanes: readonly Laned[]; counts: { shown: number } }>(model: M, keep: (id: string) => boolean): M {
  const cards = model.cards.filter((c) => keep(c.id));
  return { ...model, cards, lanes: model.lanes.map((l) => laneOnly(l, keep)), counts: { ...model.counts, shown: cards.length } };
}

/** The ids of the cards the board draws: the innermost lanes' cards (a swimlane's `sub` lanes hold what is on screen). */
export function drawnIds(lanes: readonly Laned[]): Set<string> {
  const out = new Set<string>();
  const walk = (l: Laned): void => { if (l.sub?.length) l.sub.forEach(walk); else for (const c of l.cards) out.add(c.id); };
  lanes.forEach(walk);
  return out;
}

/**
 * What the chip, the count line and the caption say. Measured: with the chip on and every shown card already a
 * changed one, the board looked identical and the chip's pressed look was a bolder font, so a click seemed to do
 * nothing. `inView`: changed cards the board draws now; `changed`: all of them. Off, the plain chip and nothing else.
 * Ceiling: "hidden" is by the person's own display prefs (Hide done, collapsed lanes); a filter in Jira's query is
 * already out of the loaded cards and so out of `changed`.
 *
 * Measured on a real board: the chip said 4 and drew 2. The changed ids were read from every loaded card, but the
 * lanes only hold the cards the view's filters keep (Show done off hides a card in a done column), so `inView` must
 * be counted over `drawnIds`, never over `model.cards`. Off, the chip promises only what a press will draw.
 */
export function changedSay(on: boolean, changed: number, inView: number): { chip: string; count: string | null; note: string | null } {
  if (!on) return { chip: changedChip(inView), count: null, note: null };
  const out = changed - inView;
  if (inView === 0) return { chip: `Showing ${changed} changed`, count: "changed only", note: `The ${changed} changed ${changed === 1 ? "card is" : "cards are"} hidden by your filters or display settings, so nothing shows. Turn the chip off to see every card.` };
  return { chip: `Showing ${inView} changed`, count: "changed only", note: out > 0 ? `${out} more changed ${out === 1 ? "card is" : "cards are"} hidden by your filters or display settings.` : null };
}

/** The most snapshots one site keeps: the oldest go first. */
export const SNAP_CAP = 2000;
export function capSnaps(m: Record<string, Snap>): Record<string, Snap> {
  const e = Object.entries(m);
  return e.length <= SNAP_CAP ? m : Object.fromEntries(e.sort((a, b) => b[1].at - a[1].at).slice(0, SNAP_CAP));
}
