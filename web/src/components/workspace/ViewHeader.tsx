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
 *
 * And the name of the view is NOT drawn here. "Terminal" over a terminal,
 * "Docker" over a wall of containers: the word repeated what the panel below it
 * already was, while the lit icon in the rail had been saying the same thing a
 * third time. Three statements of one fact, and the widest of the three sat
 * where the controls wanted to be — so every header started indented by a
 * different amount depending on how long its own name happened to be. The name
 * survives for screen readers, which cannot see the rail (see `label`).
 */
export const VIEW_HEADER_H = 48;

export const viewHeaderClass = "flex items-center gap-3 px-5 border-b shrink-0";

export const viewHeaderStyle: CSSProperties = {
  height: VIEW_HEADER_H,
  minHeight: VIEW_HEADER_H,
  maxHeight: VIEW_HEADER_H,
  borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
};

export function ViewHeader({
  label,
  children,
  actions,
}: {
  /**
   * The view's name, for assistive tech only — never painted.
   *
   * Sighted users have the rail: the lit icon says which view this is, and the
   * content says it again. A screen reader has neither, so the heading stays in
   * the document and only the pixels go. It is an `h2` rather than an
   * `aria-label` on the row because a bare `div` with a label and no role is
   * skipped by most readers, and a heading also puts the view back in the
   * document outline that the rail navigates.
   */
  label: string;
  /** Controls that scope the view: a repo picker, an engine chip. */
  children?: ReactNode;
  /** Actions, pinned right. */
  actions?: ReactNode;
}) {
  return (
    <div className={viewHeaderClass} style={viewHeaderStyle}>
      <h2 className="sr-only">{label}</h2>
      {children}
      {actions && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
