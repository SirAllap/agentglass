/*
 * Which surface and which emphasis each part of the Miller view wears, as
 * Strata draws it (src/style.css: `.columns` and `.directory-column` on
 * strata_bg, `.preview-pane` on strata_surface, `.column-header` dimmed until
 * `.active-column`).
 *
 * The columns sit on the page's own base and the preview on the card above it,
 * so with the preview open it reads as a lighter pane, and with it closed the
 * columns and the free room beside them are one surface. Both are house tokens
 * (--bg, --surface-card), so a theme that moves one moves the pair.
 */

export const COLUMNS_SURFACE = "var(--bg)";
export const PREVIEW_SURFACE = "var(--surface-card)";
/** The sidebar is on strata_surface like the preview, and its right edge is the border at 0.6 alpha (style.css `.sidebar-shell`). */
export const SIDEBAR_SURFACE = PREVIEW_SURFACE;
export const SIDEBAR_EDGE = "1px solid color-mix(in srgb, var(--surface-line) 60%, transparent)";

/** How a row of a column is drawn: the selection of the column that has the keyboard, the quiet trace of the choice in a parent column, or nothing. */
export type RowTone = "active" | "parent" | "none";

export function rowTone(selected: boolean, columnActive: boolean): RowTone {
  if (!selected) return "none";
  return columnActive ? "active" : "parent";
}

/** The count or size badge belongs to the selection that is being acted on, not to the folders that lead to it. */
export const showsBadge = (selected: boolean, columnActive: boolean): boolean => rowTone(selected, columnActive) === "active";

/** A column title is bright only while that column has the keyboard. */
export const titleColor = (columnActive: boolean): string => (columnActive ? "var(--text)" : "var(--text3)");

/**
 * The fill and ring a row wears for its tone. The fill is the selection and every selected row has it; the ring is
 * Strata's keyboard cursor (docs/keyboard-navigation.md), a text-contrast outline on the one current row of the column
 * that has the keyboard, so a range of filled rows still has exactly one ring. A parent column keeps a plain, low fill
 * with no ring, so only one place on screen carries the accent.
 */
export function rowPaint(tone: RowTone, cursor = true): { background?: string; boxShadow?: string; fontWeight: number } {
  if (tone === "active") return {
    background: "color-mix(in srgb, var(--primary) 16%, transparent)",
    ...(cursor ? { boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 70%, transparent)" } : {}),
    fontWeight: 600,
  };
  if (tone === "parent") return { background: "color-mix(in srgb, var(--text) 9%, transparent)", fontWeight: 600 };
  return { fontWeight: 400 };
}
