/*
 * The head of a lane: 40 high. Fold chevron, the lane's tile, its name, the count, the points, and the "Sort this lane"
 * button. The whole head folds the lane on a click; the chevron is the keyboard's way in. A right click is the lane menu
 * (the host wires it, S3). The sort choices are the lane menu's own sort menu, and what is picked is remembered per view.
 */
import { useState, type MouseEvent } from "react";
import { BoltIcon, CaretIcon, DoneIcon, FlagIcon, FolderIcon, ListIcon, SortIcon, TargetIcon, UserIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { setLaneSort } from "../../../lib/jiraLaneState.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { ListIconBtn } from "./ListControls.tsx";
import { LANE_SORTS, type LaneSort } from "./laneModel.ts";
import { JiraMenuView } from "./menus/JiraMenu.tsx";
import { sortMenu } from "./menus/menuModel.ts";
import type { JiraLane } from "./model.ts";

function Mark({ lane }: { lane: JiraLane }) {
  const size = ICON.xs;
  switch (lane.mark) {
    case "backlog": return <ListIcon size={size} />;
    case "project": return <FolderIcon size={size} />;
    case "priority": return <FlagIcon size={size} />;
    case "person": return <UserIcon size={size} />;
    case "area": return <TargetIcon size={size} />;
    case "sprint": return <BoltIcon size={size} />;
    default: return lane.done ? <DoneIcon size={size} /> : <BoltIcon size={size} />;
  }
}

export interface JiraLaneHeadProps {
  lane: JiraLane;
  /** The lane's key in the view's lane state. */
  id: string;
  viewId: string;
  folded: boolean;
  sort: LaneSort;
  onToggle: () => void;
  onMenu?: ((e: MouseEvent, lane: JiraLane) => void) | undefined;
}

export function JiraLaneHead({ lane, id, viewId, folded, sort, onToggle, onMenu }: JiraLaneHeadProps) {
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const how = LANE_SORTS.find((s) => s.id === sort)!;
  return (
    <div className="agx-jl-head" style={lane.color ? { ["--t" as string]: lane.color } : undefined}
      onClick={onToggle} onContextMenu={onMenu ? (e) => onMenu(e, lane) : undefined}>
      <button type="button" className="agx-jl-twist" aria-expanded={!folded} aria-label={`${folded ? "Open" : "Collapse"} ${lane.status}`}
        data-tip={tipAttr(folded ? "Open this lane" : "Collapse this lane")} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
        <CaretIcon size={ICON.xs} />
      </button>
      <span className="agx-jl-tile" aria-hidden><Mark lane={lane} /></span>
      <span className="agx-jl-name agx-jl-trunc" data-tip={tipAttr(lane.status)}>{lane.status}</span>
      <span className="agx-jl-count" aria-label={`${lane.cards.length} cards`}>{lane.cards.length}</span>
      <span className="agx-jl-gap" />
      {lane.points > 0 && <span className="agx-jl-pts">{lane.points} pts</span>}
      <ListIconBtn label="Sort this lane" tip={sort === "rank" ? "Sort this lane" : `Sorted by ${how.label.toLowerCase()}`} size={28} on={sort !== "rank"}
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setPick({ x: r.left, y: r.bottom + 4 }); }}>
        <SortIcon size={ICON.sm} />
      </ListIconBtn>
      {pick && (
        <div onClick={(e) => e.stopPropagation()}>
          <JiraMenuView menu={sortMenu(lane.status, sort)} x={pick.x} y={pick.y} onClose={() => setPick(null)}
            onPick={(pickId) => { if (pickId.startsWith("sort:")) setLaneSort(viewId, id, pickId.slice("sort:".length) as LaneSort); }} />
        </div>
      )}
    </div>
  );
}
