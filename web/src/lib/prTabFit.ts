// Which of the detail's section tabs fit beside its primary action, decided apart from the strip.
//
// The strip is Overview / Conversation / Commits / Files / Checks / Review, each with a count, and on the
// right the primary "Add your review" (and sometimes a draft badge). At the narrowest dock (320px) with long
// counts ("Conversation 123", "Checks 99+") they do not all fit. A strip that scrolls sideways hides the
// tabs it cannot show and a button that clips says "Add your"; neither says anything went wrong. So
// the order of giving way is fixed: first the action loses its words (it stays whole as an icon with its
// name on the tooltip), then the tabs at the end go into a "…" menu. The active tab is never one of them.
//
// Widths are measured by the strip, in px, so a long count or a wider font changes the answer. This only
// decides. The ceiling: tabs collapse from the end, in order, never by importance, and only the active
// one is kept; a "hot" tab hidden in the menu is signalled on the menu's own button.
export interface TabBox { id: string; width: number }

export interface TabFitInput {
  tabs: readonly TabBox[];
  active: string;
  /** Room the whole row has, in px. */
  avail: number;
  /** What sits on the right and never changes size (draft badges); 0 for nothing. */
  fixed: number;
  /** The primary action with its words, and as a square icon. 0 for no action. */
  actionFull: number;
  actionIcon: number;
  /** The "…" button, and the gap between everything in the row. */
  moreWidth: number;
  gap: number;
}

export interface TabFit { visible: string[]; hidden: string[]; action: "full" | "icon" | "none" }

/** The right-hand group: what never changes, then the action, a gap apart. */
const rightOf = (i: TabFitInput, action: number) => i.fixed + (i.fixed > 0 && action > 0 ? i.gap : 0) + action;
const rowOf = (i: TabFitInput, tabs: number, action: number) => tabs + (tabs > 0 ? i.gap : 0) + rightOf(i, action);

export function fitTabs(i: TabFitInput): TabFit {
  const ids = i.tabs.map((t) => t.id);
  const all = i.tabs.reduce((n, t) => n + t.width, 0);
  const hasAction = i.actionFull > 0;
  if (!hasAction && rowOf(i, all, 0) <= i.avail) return { visible: ids, hidden: [], action: "none" };
  if (hasAction && rowOf(i, all, i.actionFull) <= i.avail) return { visible: ids, hidden: [], action: "full" };
  if (hasAction && rowOf(i, all, i.actionIcon) <= i.avail) return { visible: ids, hidden: [], action: "icon" };

  // Collapse: the action is an icon, the "…" takes room, and tabs are kept from the front while they fit.
  const action = hasAction ? i.actionIcon : 0;
  const room = i.avail - i.gap - rightOf(i, action) - i.moreWidth - i.gap;
  const keep: TabBox[] = [];
  let used = 0;
  for (const t of i.tabs) {
    if (used + t.width > room) break;
    keep.push(t); used += t.width;
  }
  const act = i.tabs.find((t) => t.id === i.active);
  if (act && !keep.includes(act)) {
    // The active tab always shows: it takes the place of the last ones that no longer fit beside it.
    while (keep.length && used + act.width > room) used -= keep.pop()!.width;
    keep.push(act);
  }
  const shown = new Set(keep.map((t) => t.id));
  return { visible: ids.filter((id) => shown.has(id)), hidden: ids.filter((id) => !shown.has(id)), action: hasAction ? "icon" : "none" };
}
