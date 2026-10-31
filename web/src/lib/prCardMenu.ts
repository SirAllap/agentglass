// The card's right-click menu, decided apart from the screen.
//
// Which entries exist, which are off and the one-line reason they give, and how
// many sit behind "More" all follow from the same facts the card's footer
// already reads (prCardView). They are decided once, here, so the menu cannot
// offer what the footer greys out, and "N more" is counted from the list rather
// than written down: it is 12 on a card with no tracker and 15 with one.
//
// The ceiling: this says what the menu offers and why an entry is off. What an
// entry does lives in the panel, which owns the requests; an entry that needs the
// pull request's page loaded (a merge, a conflict) opens it first.
import type { PrSummary } from "../../../shared/types.ts";
import { finishedKind } from "../../../shared/prClosed.ts";
import type { CardView } from "./prCardView.ts";

export type MenuIcon =
  | "hand" | "user" | "spark" | "link" | "down" | "alert" | "refresh" | "bell" | "merge" | "ext" | "pin"
  | "pr" | "max" | "copy" | "branch" | "term" | "edit" | "eye" | "x" | "plug" | "megaphone" | "tag" | "lines" | "sparkles"
  | "box" | "layers" | "eyeon";

export type CardMenuId =
  | "clean" | "hand" | "reviewers" | "nudge" | "agent" | "card" | "linkcard" | "connect" | "title" | "labels"
  | "update" | "resolve" | "rerun" | "watch" | "merge"
  | "github" | "copylink" | "pin"
  | "open" | "full" | "copycard" | "copycardname" | "copycardlink" | "squash" | "rebase" | "copynum" | "copybranch" | "base" | "term" | "draft" | "unstick"
  | "hideauthor" | "hidebranch" | "close";

/** The id type is the caller's: the Jira sidebar's menus use this shape with their own ids. */
export interface MenuItem<I extends string = CardMenuId> {
  kind: "item";
  id: I;
  label: string;
  icon: MenuIcon;
  /** The key or gesture named at the right edge. A label: the menu does not bind it. */
  hint?: string;
  /** The grey second line. */
  sub?: string;
  /** Why the entry is off. Present means disabled, and this is the line under it. */
  why?: string;
  strong?: boolean;
  danger?: boolean;
}
export interface MenuHeading { kind: "heading"; text: string }
export interface MenuRule { kind: "rule" }
export type MenuRow<I extends string = CardMenuId> = MenuItem<I> | MenuHeading | MenuRule;

export interface CardMenu<I extends string = CardMenuId> {
  /** `#42 · Title cut at 30 characters`. */
  head: string;
  rows: MenuRow<I>[];
  /** What "More" folds, in order, and its length is the number the row prints. Empty: the menu has no "More" row. */
  more: MenuItem<I>[];
  /** The last entry, after a rule: the one that cannot be undone. */
  close: MenuItem<I>;
  /** True when it does not apply at all (already closed): the menu leaves it out. */
  closeAbsent: boolean;
}

/** How a card relates to the tracker, which decides the Card section and the hand-over sentence. */
export type TrackerMode = "clickup" | "jira" | "ro" | "none" | "unlinked";

export const HEAD_CUT = 30;

export function menuHead(p: Pick<PrSummary, "number" | "title">): string {
  const t = p.title.length > HEAD_CUT ? `${p.title.slice(0, HEAD_CUT - 1)}…` : p.title;
  return `#${p.number} · ${t}`;
}

/**
 * Which tracker a card id belongs to when both are connected: a Jira project key
 * claims its own ids; anything else is read as ClickUp's. With one connected,
 * that one. Returns null when neither is.
 */
export function trackerNameOf(id: string | undefined, setup: { clickup?: unknown; jira?: { prefixes: string[] } } | null | undefined): "ClickUp" | "Jira" | null {
  if (!setup) return null;
  const jira = setup.jira, cu = setup.clickup;
  if (jira && cu) return id && jira.prefixes.some((k) => id.toUpperCase().startsWith(`${k.toUpperCase()}-`)) ? "Jira" : "ClickUp";
  return jira ? "Jira" : cu ? "ClickUp" : null;
}

const item = (id: CardMenuId, label: string, icon: MenuIcon, o: Partial<MenuItem> = {}): MenuItem =>
  ({ kind: "item", id, label, icon, ...o });

export function cardMenu(i: {
  p: Pick<PrSummary, "number" | "title" | "author" | "state" | "isDraft" | "baseRefName" | "headRefName" | "mergeable" | "reviewDecision" | "checks">;
  view: Pick<CardView, "reasons">;
  pinned: boolean;
  mode: TrackerMode;
  /** `ClickUp` or `Jira`; read only when the mode is a tracker's. */
  tracker?: "ClickUp" | "Jira";
  /** The linked card's id, e.g. `ORBIT-1042`. */
  cardId?: string;
  stacked: boolean;
  /** Somebody is asked and has not answered: Nudge has someone to nudge. */
  waiting?: boolean;
  /** The token has no write access here. The list does not carry it, so a caller that does not know passes nothing. */
  readOnly?: boolean;
  /** The size of what a merged pull request left on this computer, when it is known. */
  leftovers?: string;
}): CardMenu {
  const { p, view } = i;
  const live = !finishedKind(p);
  const tn = i.tracker ?? "ClickUp";
  const mw = (i.readOnly ? "Read-only: no write access" : view.reasons.merge) ?? undefined;
  /* What switches the edits off, in the words the page uses for each kind of finished. */
  const finished = i.readOnly ? "Read-only: no write access" : p.state === "MERGED" ? "Already merged"
    : !live ? "Closed: reopen it first" : undefined;
  const merged = p.state === "MERGED";

  const handSub = i.mode === "none" ? "GitHub only: no tracker is connected"
    : i.mode === "unlinked" ? "GitHub only: no card is linked"
    : i.mode === "ro" ? `GitHub only: ${tn} is read-only`
    : "Review, card assignee and status";

  const card: MenuItem = i.mode === "none" ? item("connect", "Connect a tracker in Settings", "plug", { why: "No tracker is connected" })
    : i.mode === "unlinked" ? item("linkcard", "Link a card…", "link", { why: finished })
    : item("card", `Open ${i.cardId ?? "the card"} in ${tn}`, "ext");

  const hasCard = i.mode === "clickup" || i.mode === "jira" || i.mode === "ro";
  const rows: MenuRow[] = [
    ...(merged && i.leftovers !== undefined ? [
      item("clean", "Clean up local leftovers", "sparkles", {
        strong: true, sub: `${i.leftovers ? `${i.leftovers} on this computer` : "On this computer"}: worktree, branch, containers`,
      }),
      { kind: "rule" } as MenuRow,
    ] : []),
    item("hand", "Hand over to…", "hand", { hint: "H", strong: true, sub: handSub, why: finished }),
    item("reviewers", "Request a review…", "user", { why: finished }),
    item("nudge", "Nudge reviewers", "megaphone", { why: finished ?? (i.waiting ? undefined : "Nobody is waiting") }),
    item("agent", "Review with agent", "spark"),
    { kind: "rule" },
    { kind: "heading", text: i.cardId && hasCard ? `Card · ${i.cardId}` : "Card" },
    card,
    { kind: "rule" },
    { kind: "heading", text: "Edit" },
    item("title", "Edit title…", "edit", { why: finished }),
    item("labels", "Edit labels…", "tag", { why: finished }),
    { kind: "rule" },
    { kind: "heading", text: "Branch and checks" },
    item("update", "Update branch", "down", { why: finished ?? view.reasons.update ?? undefined }),
    item("resolve", "Resolve conflicts…", "alert", { why: finished ?? view.reasons.resolve ?? undefined }),
    item("rerun", "Rerun failed checks", "refresh", { why: finished ?? view.reasons.rerun ?? undefined }),
    item("watch", "Watch checks…", "bell", { why: live ? undefined : "Nothing left to watch" }),
    item("merge", "Merge…", "merge", { why: mw }),
    { kind: "rule" },
    item("github", "Open on GitHub", "ext", { hint: "G" }),
    item("copylink", "Copy link", "link", { hint: "L" }),
    item("pin", i.pinned ? "Unpin" : "Pin", "pin", { hint: "P" }),
    { kind: "rule" },
  ];

  const more: MenuItem[] = [
    item("open", "Open beside the board", "pr", { hint: "Click" }),
    item("full", "Open full screen", "max", { hint: "Double-click" }),
    ...(hasCard ? [
      item("copycard", "Copy card ID", "copy"),
      item("copycardname", "Copy card name", "lines"),
      item("copycardlink", "Copy card link", "link"),
    ] : []),
    item("squash", "Squash and merge", "merge", { why: mw }),
    item("rebase", "Rebase and merge", "merge", { why: mw }),
    item("copynum", `Copy number (#${p.number})`, "copy"),
    item("copybranch", "Copy branch name", "branch"),
    item("base", "Change base…", "branch", {
      why: finished ?? (i.stacked ? "In a stack: changing the base breaks it" : undefined),
    }),
    item("term", "Send to terminal…", "term"),
    item("draft", p.isDraft ? "Mark ready for review" : "Convert to draft", "edit", { why: finished }),
    item("unstick", "Unstick…", "alert", { why: finished ?? (p.mergeable === "UNKNOWN" ? undefined : "GitHub is not stuck on this one") }),
    item("hideauthor", `Hide everything by ${p.author}`, "eye"),
    item("hidebranch", "Hide this branch", "eye"),
  ];

  return {
    head: menuHead(p),
    rows,
    more,
    close: item("close", "Close pull request…", "x", { danger: true, why: finished }),
    /* A closed pull request has nothing left to close: the entry is absent, not off. */
    closeAbsent: p.state === "CLOSED",
  };
}

/** The enabled entries in the order the arrow keys walk them, with "More" open or folded. */
export function walkIds<I extends string = CardMenuId>(m: CardMenu<I>, open: boolean): (I | "more")[] {
  const out: (I | "more")[] = [];
  for (const r of m.rows) if (r.kind === "item" && !r.why) out.push(r.id);
  if (m.more.length) out.push("more");
  if (open) for (const r of m.more) if (!r.why) out.push(r.id);
  if (!m.closeAbsent && !m.close.why) out.push(m.close.id);
  return out;
}

/**
 * Turns entries off that the panel cannot do (yet), each with its own sentence.
 * An entry that is already off keeps the reason it had: that one is the truer.
 */
export function applyOff(m: CardMenu, off: Partial<Record<CardMenuId, string>> | undefined): CardMenu {
  if (!off) return m;
  const one = (r: MenuItem): MenuItem => (off[r.id] && !r.why ? { ...r, why: off[r.id] } : r);
  return {
    ...m,
    rows: m.rows.map((r) => (r.kind === "item" ? one(r) : r)),
    more: m.more.map(one),
    close: one(m.close),
  };
}
