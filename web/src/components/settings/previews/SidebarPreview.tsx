import { DEFAULT_RAIL } from "./MiniApp.tsx";
import { LiveWindow, type LiveView } from "./LiveWindow.tsx";
import { PreviewNote } from "./Frame.tsx";
import type { RailItem } from "./logic.ts";

export interface SidebarPreviewProps {
  /** Every view with the drawer it sits in ("off" is not on the rail) and its count badge. */
  items: readonly RailItem[];
  /** The view being edited: drawn as the active one. */
  selected: string;
  /** Which of the app's screens sits beside the rail (the tabs live in the card's header). */
  view?: LiveView;
}

export { DEFAULT_RAIL };

/** The rail as the window would draw it now, beside one of the app's own screens on invented data: drawers, order, hidden views gone, counts on or off. */
export function SidebarPreview({ items, selected, view = "lantern" }: SidebarPreviewProps) {
  return (
    <div className="flex flex-col gap-2 min-w-0" data-preview="sidebar">
      <LiveWindow view={view} zoomPct={100} rail={items} selected={selected} aspect={2.2} />
      <PreviewNote>Drag a row on the left to reorder; the rail follows at once.</PreviewNote>
    </div>
  );
}
