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
export interface OwnWidth {
  width: number;
  min: number;
  /** Widest it may get right now; read at every move, so a pane that shrank is respected. */
  max: () => number;
  onWidth: (px: number) => void;
  onReset: () => void;
}

/** Drag on the window, same as the shared one, but setting a width the caller owns. */
function beginOwnDrag(e: { clientX: number; preventDefault: () => void }, own: OwnWidth) {
  e.preventDefault();
  const startX = e.clientX, start = own.width;
  const move = (ev: MouseEvent) => own.onWidth(Math.min(own.max(), Math.max(own.min, start + (ev.clientX - startX))));
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/** `own` is for a list whose width is not the shared one (the side pane's), so the drag moves what is on screen. */
export function SidebarGrip({ own }: { own?: OwnWidth } = {}) {
  if (own) {
    return (
      <div role="separator" aria-orientation="vertical" aria-label="Resize the list" aria-valuenow={own.width}
        aria-valuemin={own.min} tabIndex={0} data-own-grip
        onMouseDown={(e) => beginOwnDrag(e, own)} onDoubleClick={own.onReset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          if (e.key === "ArrowLeft") { e.preventDefault(); own.onWidth(Math.max(own.min, own.width - step)); }
          else if (e.key === "ArrowRight") { e.preventDefault(); own.onWidth(Math.min(own.max(), own.width + step)); }
        }}
        title="Drag to resize · double-click to reset" className="agx-grip shrink-0" />
    );
  }
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
