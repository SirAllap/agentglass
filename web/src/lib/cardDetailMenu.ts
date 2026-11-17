/*
 * The menus of the card's detail panel, decided apart from the screen: the header's "..." menu, the Send to terminal menu and the
 * context menu of a sub-task row. Each is a JiraMenu (components/jira/list/menus/menuModel.ts), so the rows, the keys and the
 * reasons behind an off row are the ones every other Jira menu has.
 *
 * What a row may do is decided by what the app can already write, never by what the menu would like to offer: a row with no
 * write path behind it is drawn off with a line that says so, and a write is off with the switch.
 */
import type { ProviderTask } from "../../../shared/providers.ts";
import { jiraBranchName } from "./cardBranch.ts";
import { LETTER, WRITES_OFF_WHY, menuHead, type JiraMenu, type JiraMenuItem, type JiraMenuRow } from "../components/jira/list/menus/menuModel.ts";

const item = (id: string, label: string, icon: JiraMenuItem["icon"], o: Partial<JiraMenuItem> = {}): JiraMenuItem => ({ kind: "item", id, label, icon, ...o });
const keyOf = (t: ProviderTask): string => t.customId ?? t.id;
const rule: JiraMenuRow = { kind: "rule" };

export const NO_CHECKOUT_WHY = "No checkout is known for this card";
export const NO_PATH_WHY = "Jira's write for this is not wired in agentglass yet";

/** What the header's one square group no longer draws: the watch mark, the way back and the two places of the panel that have no square.
 *  Each is present only when the caller has it, so a card opened outside the dock gets none of them. */
export interface HeaderMore {
  /** The account's watch mark; `why` set means it cannot be pressed (the row is drawn off with the reason). */
  watch?: { on: boolean; label: string; why?: string };
  back?: boolean;
  /** The panel's current place; the two that are not squares in the group. */
  place?: { mode: string };
}

/** The "..." beside the header's buttons: what is about the card itself. Linked rows carry their own Remove, behind its confirm. */
export function headerMenu(t: ProviderTask, more: HeaderMore = {}): JiraMenu {
  const key = keyOf(t);
  const panel: JiraMenuRow[] = [
    ...(more.back ? [item("back", "Back", "back", { sub: "The card opened before this one", key: "Alt+Left" })] : []),
    ...(more.watch ? [item("watch", more.watch.label, more.watch.on ? "eyeoff" : "eye", more.watch.why ? { why: more.watch.why } : {})] : []),
    ...(more.place ? [
      item("placeFloat", "Float", "sidebar", more.place.mode === "float" ? { sub: "Where it is now" } : { sub: "A window you can move" }),
      item("placeBottom", "Dock bottom", "sidebar", more.place.mode === "bottom" ? { sub: "Where it is now" } : { sub: "A strip under the board" }),
    ] : []),
  ];
  return {
    head: menuHead(key, t.title),
    rows: [
      ...panel,
      ...(panel.length ? [rule] : []),
      item("openJira", "Open in Jira", "ext", t.url ? { sub: "In your browser", key: LETTER.openJira } : { why: "It has no address", key: LETTER.openJira }),
      rule,
      item("copyKey", "Copy key", "copy", { sub: key, key: LETTER.copyKey }),
      item("copyLink", "Copy link", "link", t.url ? { sub: "Address of this card", key: LETTER.copyLink } : { why: "It has no address", key: LETTER.copyLink }),
      item("copyBranch", "Copy branch name", "branch", { sub: jiraBranchName(key, t.title).slice(0, 26), key: LETTER.copyBranch }),
      rule,
      item("reread", "Read this card again", "refresh", { sub: "Asks Jira now", key: LETTER.reread }),
    ],
    more: [],
    close: null,
  };
}

/** Send to terminal: the card's work goes to a tmux window of the checkout; with no checkout known the rows say so. */
export function sendMenu(t: ProviderTask, cwd: string | null): JiraMenu {
  const key = keyOf(t);
  const off = cwd ? undefined : NO_CHECKOUT_WHY;
  return {
    head: menuHead(key, t.title),
    rows: [
      item("send", "Send the card to a terminal", "branch", off ? { why: off } : { sub: "Starts your agent on it", strong: true }),
      item("shell", "Open a shell in the checkout", "list", off ? { why: off } : { sub: "A plain terminal window" }),
      rule,
      item("copyWorktree", "Copy the worktree command", "copy", { sub: "Run it inside the checkout" }),
    ],
    more: [],
    close: null,
  };
}

export interface SubtaskMenuFacts { writable: boolean; index: number; count: number; done: boolean }

/** P09: Promote, Change parent, Move up/down (Alt+Up/Down), Mark done. Move and Mark done have a write behind them; the other two do not. */
export function subtaskDetailMenu(t: ProviderTask, f: SubtaskMenuFacts): JiraMenu {
  const key = keyOf(t);
  const off = f.writable ? undefined : WRITES_OFF_WHY;
  return {
    head: menuHead(key, t.title),
    rows: [
      item("open", "Open sub-task", "sidebar", { sub: "Beside the list", key: LETTER.open, strong: true }),
      rule,
      item("promote", "Promote to a task", "chev", { why: off ?? NO_PATH_WHY }),
      item("reparent", "Change parent", "move", { why: off ?? NO_PATH_WHY }),
      item("up", "Move up", "sort", off ? { why: off } : f.index <= 0 ? { why: "It is the first" } : { sub: "Alt+Up" }),
      item("down", "Move down", "sort", off ? { why: off } : f.index >= f.count - 1 ? { why: "It is the last" } : { sub: "Alt+Down" }),
      item("done", "Mark done", "check", off ? { why: off } : f.done ? { why: "Already done" } : { sub: "Space · the card's own done step" }),
      rule,
      item("copyKey", "Copy key", "copy", { sub: key, key: LETTER.copyKey }),
    ],
    more: [],
    close: null,
  };
}

/** Where a move lands: the sibling to rank before or after, as the rank write asks for it; null at an end. */
export function rankAsk(keys: readonly string[], index: number, dir: -1 | 1): { before?: string; after?: string } | null {
  const to = index + dir;
  if (index < 0 || to < 0 || to >= keys.length) return null;
  return dir === -1 ? { before: keys[to]! } : { after: keys[to]! };
}

/** The same order, with the moved row swapped with its neighbour: what the panel shows while the write is out. */
export function swapped<T>(rows: readonly T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const out = [...rows];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

/** The prompt Send to terminal hands the agent: the card and where to read it, nothing about who asked. */
export function sendPrompt(t: ProviderTask): string {
  return `Work on ${keyOf(t)}: ${t.title}${t.url ? `\n${t.url}` : ""}`;
}
