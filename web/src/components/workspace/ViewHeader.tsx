import type { CSSProperties, ReactNode } from "react";

/**
 * The one top bar, shared by every view.
 *
 * These five headers were written at five different times and drifted the way
 * separately-maintained things do — one was 2.5px shorter, one carried an icon,
 * one sized its title two points down, and Chat had no top bar at all because
 * its title lived in the sidebar. Switching views made the whole frame twitch,
 * which reads as five tools bolted together rather than one.
 *
 * So the height is FIXED, not min or max: padding plus content means the bar is
 * as tall as whatever the tallest control in it happens to be, and a view that
 * later adds a taller button silently grows its own header again. A fixed
 * height cannot drift — the content centres inside it, and only the panel below
 * changes when you switch views.
 *
 * No overflow-hidden, ever. Header controls open dropdowns positioned inside
 * this row, and clipping the row clipped the menus to a sliver.
 */
export const VIEW_HEADER_H = 48;

export const viewHeaderClass = "flex items-center gap-3 px-5 border-b shrink-0";

export const viewHeaderStyle: CSSProperties = {
  height: VIEW_HEADER_H,
  minHeight: VIEW_HEADER_H,
  maxHeight: VIEW_HEADER_H,
  borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
};

/** Same size, same weight, same nowrap, in all five. A wrapped title is what
 *  made the bars different heights in the first place. */
export const viewTitleClass = "text-[15px] font-semibold whitespace-nowrap shrink-0";

export function ViewHeader({
  title,
  count,
  children,
  actions,
}: {
  title: string;
  /** The one number that says how much is in here — chats, containers. Beside
   *  the title because that is where every view already put it. */
  count?: number;
  /** Controls that scope the view: a repo picker, an engine chip. */
  children?: ReactNode;
  /** Actions, pinned right. */
  actions?: ReactNode;
}) {
  return (
    <div className={viewHeaderClass} style={viewHeaderStyle}>
      <span className={viewTitleClass} style={{ color: "var(--text)" }}>{title}</span>
      {count != null && <span className="text-[10px] t-dim2 tabular-nums shrink-0">{count}</span>}
      {children}
      {actions && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
