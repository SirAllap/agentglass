/*
 * The Jira right-click menus, decided apart from the screen (the way lib/prCardMenu.ts decides the pull-request
 * card's): which rows exist, which are off and the one-line reason, the letter that presses each, and the sort a lane
 * can take. menus/JiraMenu.tsx draws a JiraMenu and walks it; the host (JiraMenuHost.tsx) says what a row does.
 *
 * Generic on purpose: a menu is a head, rows, a fold ("More") and an optional last row after a rule. The epic,
 * component and space menus of the sidebar tree are three more functions here and nothing else.
 *
 * Keys: one letter per action everywhere (LETTER). Enter is not bound here: the first row takes focus when the menu
 * opens, so Enter presses it like any focused button, and a binding on top of that would press it twice.
 */
import type { ProviderTask, SavedView } from "../../../../../../shared/providers.ts";
import { branchName } from "../../../../lib/cardBranch.ts";
import { LANE_SORTS, type LaneSort } from "../laneModel.ts";

export type MenuGlyph =
  | "sidebar" | "ext" | "move" | "user" | "comment" | "copy" | "link" | "branch" | "pr" | "pin" | "refresh" | "eyeoff" | "eye"
  | "back" | "chev" | "sort" | "list" | "x" | "pencil" | "filter" | "sliders" | "check";

export interface JiraMenuItem {
  kind: "item";
  /** What the host does. Not shown. */
  id: string;
  label: string;
  icon: MenuGlyph;
  /** The key that presses it while the menu is open: a letter, or `ArrowLeft` / `Shift+ArrowLeft`. */
  key?: string;
  /** The grey second line. */
  sub?: string;
  /** Why the row is off. Present means disabled, and this is the line under it. */
  why?: string;
  strong?: boolean;
  danger?: boolean;
}
export interface JiraMenuHeading { kind: "heading"; text: string }
export interface JiraMenuRule { kind: "rule" }
export type JiraMenuRow = JiraMenuItem | JiraMenuHeading | JiraMenuRule;

export interface JiraMenu {
  head: string;
  rows: JiraMenuRow[];
  /** What "More" folds; empty means there is no More row. */
  more: JiraMenuItem[];
  /** The last row, after a rule: the one that cannot be undone. */
  close: JiraMenuItem | null;
}

/** One letter per action, everywhere. A menu that offers an action takes its letter from here. */
export const LETTER = {
  open: "Enter", openJira: "o", move: "m", assign: "a", comment: "c", copyKey: "k", copyLink: "l", copyBranch: "b",
  pr: "p", pin: "t", reread: "r", hide: "h", parent: "u", sort: "s", rename: "n", edit: "e",
  collapse: "ArrowLeft", collapseAll: "Shift+ArrowLeft",
} as const;

const item = (id: string, label: string, icon: MenuGlyph, o: Partial<JiraMenuItem> = {}): JiraMenuItem =>
  ({ kind: "item", id, label, icon, ...o });
const section = (text: string, items: JiraMenuItem[], first = false): JiraMenuRow[] =>
  [...(first ? [] : [{ kind: "rule" } as const]), { kind: "heading", text }, ...items];

export const HEAD_CUT = 30;

/** `ORB-52 · Title cut at 30 characters`. */
export function menuHead(key: string, title: string): string {
  return headCut(`${key} · ${title}`);
}
const headCut = (full: string): string => (full.length > HEAD_CUT + 2 ? `${full.slice(0, HEAD_CUT)}…` : full);

const keyOf = (t: ProviderTask): string => t.customId ?? t.id;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const people = (t: ProviderTask): string => (t.assignees.length ? t.assignees.join(" and ") : "nobody yet");

/** What the site says this card can do from where it stands: the steps, still being read, or why not. */
export type MoveFacts = { to: readonly { status: string; asks: boolean }[] } | "reading" | { error: string };

export interface CardMenuFacts {
  /** The pull request #, when the card has one. */
  pr: number | null;
  pinned: boolean;
  /** Whether this app may change Jira at all; absent means yes. */
  writable?: boolean;
  /** The steps from here; absent means not read yet. */
  moves?: MoveFacts;
}

export const WRITES_OFF_WHY = "Changes to Jira are off";

/** The grey line of a step list: the next statuses, cut to one line. */
export function stepsLine(to: readonly { status: string }[]): string {
  const names = [...new Set(to.map((x) => x.status))];
  const head = cut(names.slice(0, 2).join(", "), 28);
  return names.length > 2 ? `${head} +${names.length - 2}` : head;
}

/** Move / Assign / Comment each open the dock on its control, so each is off with the real reason when the dock could not act. */
export function changeRows(t: ProviderTask, f: Pick<CardMenuFacts, "writable" | "moves">, comment: string): JiraMenuItem[] {
  const off = f.writable === false ? WRITES_OFF_WHY : undefined;
  const m = f.moves;
  const move: Partial<JiraMenuItem> = off ? { why: off }
    : m && m !== "reading" && "to" in m
      ? m.to.length ? { sub: stepsLine(m.to) } : { why: `No step from ${t.status}` }
      : m && m !== "reading" ? { sub: "Could not read the steps" } : { sub: "Reading the steps…" };
  return [
    item("move", "Move to…", "move", { key: LETTER.move, ...move }),
    item("assign", "Assign to…", "user", off ? { why: off, key: LETTER.assign } : { sub: `Now: ${people(t)}`, key: LETTER.assign }),
    item("comment", "Comment", "comment", off ? { why: off, key: LETTER.comment } : { sub: comment, key: LETTER.comment }),
  ];
}

export function cardMenu(t: ProviderTask, f: CardMenuFacts): JiraMenu {
  const key = keyOf(t);
  const br = branchName(key, t.title);
  return {
    head: menuHead(key, t.title),
    rows: [
      ...section(`Card · ${key}`, [
        item("open", "Open card", "sidebar", { sub: "Beside the list", key: LETTER.open, strong: true }),
        openInJira(t),
      ], true),
      ...section("Change", changeRows(t, f, "Opens the card on Activity")),
      ...section("Copy", [
        item("copyKey", "Copy key", "copy", { sub: key, key: LETTER.copyKey }),
        copyLink(t, "The Jira address of this card"),
        item("copyBranch", "Copy branch name", "branch", { sub: cut(br, 26), key: LETTER.copyBranch }),
      ]),
      ...section("Linked", [
        f.pr !== null
          ? item("pr", `Open pull request #${f.pr}`, "pr", { sub: "Opens in agentglass", key: LETTER.pr })
          : item("pr", "Open pull request", "pr", { why: "No pull request linked yet", key: LETTER.pr }),
      ]),
    ],
    more: [
      item("pin", f.pinned ? "Unpin from the top" : "Pin to top of lane", "pin", { key: LETTER.pin }),
      item("reread", "Read this card again", "refresh", { key: LETTER.reread }),
      item("hide", "Hide from this list", "eyeoff", { sub: "Only here, not in Jira", key: LETTER.hide }),
    ],
    close: null,
  };
}

/** `parent` is the card the sub-task hangs under, when this list can open it. */
export function subtaskMenu(t: ProviderTask, parent: { key: string; openable: boolean } | null, f: Pick<CardMenuFacts, "writable" | "moves"> = {}): JiraMenu {
  const key = keyOf(t);
  return {
    head: menuHead(key, t.title),
    rows: [
      ...section(`Sub-task · ${key}`, [
        item("open", "Open sub-task", "sidebar", { sub: "Beside the list", key: LETTER.open, strong: true }),
        parent
          ? item("parent", `Open parent ${parent.key}`, "back", parent.openable
            ? { sub: "Back to the card", key: LETTER.parent }
            : { why: "Not in this list", key: LETTER.parent })
          : item("parent", "Open parent", "back", { why: "Its parent is not known", key: LETTER.parent }),
        openInJira(t),
      ], true),
      ...section("Change", changeRows(t, f, "Opens on Activity")),
      ...section("Copy", [
        item("copyKey", "Copy key", "copy", { sub: key, key: LETTER.copyKey }),
        copyLink(t, "Address of this sub-task"),
      ]),
    ],
    more: [],
    close: null,
  };
}

/** The letter that picks each sort in the sort menu. The ids, labels and the sorting itself are the lane model's (laneModel.ts). */
const SORT_LETTER: Record<LaneSort, string> = { rank: "r", key: "k", priority: "p", due: "d" };
const sortLabel = (k: LaneSort): string => LANE_SORTS.find((s) => s.id === k)!.label;

export interface LaneMenuFacts { status: string; cards: readonly ProviderTask[]; folded: boolean; sort: LaneSort; hidden: number }

export function laneMenu(f: LaneMenuFacts): JiraMenu {
  const n = f.cards.length;
  const keys = f.cards.map(keyOf);
  const none = n === 0 ? "No cards in it" : undefined;
  return {
    head: `${f.status} · ${n} ${n === 1 ? "card" : "cards"}`,
    rows: [
      ...section(`Lane · ${f.status}`, [
        item("collapse", f.folded ? "Open lane" : "Collapse lane", "chev", { key: LETTER.collapse, strong: true }),
        item("collapseAll", "Collapse all lanes", "chev", { key: LETTER.collapseAll }),
        item("sort", "Sort cards by…", "sort", { sub: `Now: ${sortLabel(f.sort)}`, key: LETTER.sort }),
      ], true),
      ...section("Cards", [
        item("copyKeys", `Copy the ${n} ${n === 1 ? "key" : "keys"}`, "copy", none ? { why: none, key: LETTER.copyKey } : { sub: cut(keys.slice(0, 3).join(", "), 28), key: LETTER.copyKey }),
        item("openJql", `Open the ${n} in Jira`, "ext", none ? { why: none, key: LETTER.openJira } : jqlUrl(f.cards) ? { sub: "A search with these keys", key: LETTER.openJira } : { why: "The cards have no address", key: LETTER.openJira }),
        ...(f.hidden ? [item("unhide", `Show the ${f.hidden} hidden`, "eye", { sub: "Only here, not in Jira", key: LETTER.hide })] : []),
      ]),
    ],
    more: [],
    close: null,
  };
}

/** The sort choices a lane offers; the current one is marked. */
export function sortMenu(status: string, current: LaneSort): JiraMenu {
  return {
    head: `Sort ${status} by`,
    rows: LANE_SORTS.map((s) => item(`sort:${s.id}`, s.label, s.id === current ? "check" : "sort", { sub: s.hint, key: SORT_LETTER[s.id], strong: s.id === current })),
    more: [],
    close: null,
  };
}

export function meMenu(count: number | null, hidable = true): JiraMenu {
  return {
    head: count === null ? "Assigned to me" : `Assigned to me · ${count}`,
    rows: [
      ...section("View · Assigned to me", [
        item("open", "Open", "user", { sub: "Your open cards", key: LETTER.open, strong: true }),
        item("reread", "Read it again", "refresh", { sub: "All your spaces", key: LETTER.reread }),
      ], true),
      ...section("In the sidebar", [
        item("hideRail", "Hide from the sidebar", "eyeoff", hidable ? { sub: "Comes back from the + menu", key: LETTER.hide } : { why: "Already hidden", key: LETTER.hide }),
      ]),
    ],
    more: [],
    close: null,
  };
}

/** A saved filter or board on the bar. `address` is empty when it has none; `own` is false for one that came with a folder. */
export function viewMenu(v: Pick<SavedView, "name" | "listName">, o: { cards: number | null; address: string | undefined; own: boolean }): JiraMenu {
  const name = v.listName || v.name;
  return {
    head: headCut(`${name} · Filter`),
    rows: [
      ...section(`Filter · ${name}`, [
        item("open", "Open", "filter", { sub: o.cards === null ? undefined : `${o.cards} ${o.cards === 1 ? "card" : "cards"}`, key: LETTER.open, strong: true }),
        o.address
          ? item("openJira", "Open in Jira", "ext", { sub: "The filter, in your browser", key: LETTER.openJira })
          : item("openJira", "Open in Jira", "ext", { why: "It has no address", key: LETTER.openJira }),
      ], true),
      ...section("Edit", [
        item("rename", "Rename", "pencil", { sub: "Only in this sidebar", key: LETTER.rename }),
        item("edit", "Edit the search", "sliders", { why: "Change it in Jira", key: LETTER.edit }),
      ]),
      ...section("Copy", [
        o.address
          ? item("copyAddress", "Copy address", "link", { sub: "Address of the filter", key: LETTER.copyLink })
          : item("copyAddress", "Copy address", "link", { why: "It has no address", key: LETTER.copyLink }),
      ]),
    ],
    more: [],
    close: o.own ? item("takeOff", "Take off this bar", "x", { sub: "Only here, Jira keeps it", danger: true }) : null,
  };
}

function openInJira(t: ProviderTask): JiraMenuItem {
  return t.url ? item("openJira", "Open in Jira", "ext", { sub: "In your browser", key: LETTER.openJira })
    : item("openJira", "Open in Jira", "ext", { why: "It has no address", key: LETTER.openJira });
}
function copyLink(t: ProviderTask, sub: string): JiraMenuItem {
  return t.url ? item("copyLink", "Copy link", "link", { sub, key: LETTER.copyLink })
    : item("copyLink", "Copy link", "link", { why: "It has no address", key: LETTER.copyLink });
}

/** A search on the site for these cards, built on the address of the first one that has one; null when none has. */
export function jqlUrl(cards: readonly ProviderTask[]): string | null {
  const keys = cards.map(keyOf);
  for (const c of cards) {
    try {
      const u = new URL(c.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      return `${u.origin}/issues/?jql=${encodeURIComponent(`key in (${keys.join(", ")})`)}`;
    } catch { /* not an address: try the next */ }
  }
  return null;
}

// ---- keys ----

/** The binding a key press names: `k`, `Enter`, `Shift+ArrowLeft`. Null with Ctrl, Meta or Alt held. */
export function keySpec(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return e.shiftKey && k.length > 1 ? `Shift+${k}` : k;
}

/** What the key presses: an on row's id, "more" for the fold, or null. Enter is never bound (see the head). */
export function keyAction(menu: JiraMenu, spec: string | null): string | null {
  if (!spec || spec === "Enter") return null;
  const all = [...menu.rows.filter((r): r is JiraMenuItem => r.kind === "item"), ...menu.more, ...(menu.close ? [menu.close] : [])];
  return all.find((i) => i.key === spec && !i.why)?.id ?? null;
}

/** The rows the arrows walk, in order: the ones that are on, then "more" when there is one, its rows when open, the last row. */
export function walkIds(menu: JiraMenu, more: boolean): string[] {
  const on = (i: JiraMenuRow): i is JiraMenuItem => i.kind === "item" && !i.why;
  return [
    ...menu.rows.filter(on).map((i) => i.id),
    ...(menu.more.length ? ["more"] : []),
    ...(more ? menu.more.filter(on).map((i) => i.id) : []),
    ...(menu.close && !menu.close.why ? [menu.close.id] : []),
  ];
}

/** The label on the key cap. */
const CAP_GLYPHS: Record<string, string> = { Enter: "⏎", ArrowLeft: "←", "Shift+ArrowLeft": "⇧←" };
export function keyLabel(key: string): string {
  return CAP_GLYPHS[key] ?? key.toUpperCase();
}
