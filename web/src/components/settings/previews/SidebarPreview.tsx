import { DEFAULT_RAIL, MiniApp } from "./MiniApp.tsx";
import { PreviewNote, Scaled } from "./Frame.tsx";
import type { RailItem } from "./logic.ts";

export interface SidebarPreviewProps {
  /** Every view with the drawer it sits in ("off" is not on the rail) and its count badge. */
  items: readonly RailItem[];
  /** The view being edited: drawn as the active one. */
  selected: string;
}

export { DEFAULT_RAIL };

/** The rail as the window would draw it now: drawers, order, hidden views gone, badges on. */
export function SidebarPreview({ items, selected }: SidebarPreviewProps) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <Scaled label="The sidebar as it looks now">
        <div data-preview="sidebar"><MiniApp view="dash" rail={items} selected={selected} /></div>
      </Scaled>
      <PreviewNote>A miniature on demo data. Drag a row on the left and the rail follows.</PreviewNote>
    </div>
  );
}
