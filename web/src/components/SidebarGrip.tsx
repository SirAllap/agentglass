import { beginSidebarDrag, sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, setSidebarWidth } from "../lib/sidebarWidth.ts";

/**
 * The seam between a list pane and its content, and the handle for it.
 *
 * Deliberately its own element rather than a border on the pane: a 1px border
 * is a 1px target, and a resize handle you have to aim at is one nobody
 * discovers. This is a few pixels wide, invisible until hovered, and takes the
 * pane's border with it so the seam does not double up.
 *
 * Keyboard-reachable too — arrows nudge, Home/End go to the bounds — because a
 * mouse-only control quietly excludes anyone driving this from the keyboard,
 * which in a tool like this is most of the point.
 */
export function SidebarGrip() {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the list"
      aria-valuenow={sidebarWidth()}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onMouseDown={(e) => beginSidebarDrag(e, sidebarWidth())}
      onDoubleClick={() => setSidebarWidth(300)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft") { e.preventDefault(); setSidebarWidth(sidebarWidth() - step); }
        else if (e.key === "ArrowRight") { e.preventDefault(); setSidebarWidth(sidebarWidth() + step); }
        else if (e.key === "Home") { e.preventDefault(); setSidebarWidth(SIDEBAR_MIN); }
        else if (e.key === "End") { e.preventDefault(); setSidebarWidth(SIDEBAR_MAX); }
      }}
      title="Drag to resize · double-click to reset"
      className="agx-grip shrink-0"
    />
  );
}
