/*
 * The head of a lane: 40 high. Fold chevron, the lane's tile, its name, the count, the points, and the "Sort this lane"
 * button. The whole head folds the lane on a click, the faces included; the chevron is the keyboard's way in. A right
 * click is the lane menu (the host wires it, S3). The sort choices are the lane menu's own sort menu, and what is picked
 * is remembered per view.
 */
import { useState, type MouseEvent } from "react";
import { CaretIcon, SortIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { setLaneSort } from "../../../lib/jiraLaneState.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { ListIconBtn } from "./ListControls.tsx";
import { LANE_SORTS, type LaneSort } from "./laneModel.ts";
import { JiraMenuView } from "./menus/JiraMenu.tsx";
import { sortMenu } from "./menus/menuModel.ts";
import type { JiraLane } from "./model.ts";

/** What an epic's header shows beyond its name: the key, how far it is, who works on it, the status breakdown and the one next step. */
export interface EpicFacts {
  key: string | null;
  done: number;
  live: number;
  /** Cards whose agent waits on a person: said apart, since they are the ones to go to. */
  waiting?: number;
  /** What the agent sessions on this epic's cards have cost, every one the fleet still holds. */
  spent?: number;
  stack: { status: string; color: string | undefined; n: number }[];
  next: { id: string; label: string } | null;
  onNext: (id: string) => void;
}

export interface JiraLaneHeadProps {
  epic?: EpicFacts | null;
  lane: JiraLane;
  /** The lane's key in the view's lane state. */
  id: string;
  viewId: string;
  folded: boolean;
  sort: LaneSort;
  onToggle: () => void;
  onMenu?: ((e: MouseEvent, lane: JiraLane) => void) | undefined;
}

export function JiraLaneHead({ lane, id, viewId, folded, sort, onToggle, onMenu, epic }: JiraLaneHeadProps) {
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const how = LANE_SORTS.find((s) => s.id === sort)!;
  return (
    <div className="agx-jl-head" style={lane.color ? { ["--t" as string]: lane.color } : undefined}
      onClick={onToggle} onContextMenu={onMenu ? (e) => onMenu(e, lane) : undefined}>
      <button type="button" className="agx-jl-twist" aria-expanded={!folded} aria-label={`${folded ? "Open" : "Collapse"} ${lane.status}`}
        data-tip={tipAttr(folded ? "Open this lane" : "Collapse this lane")} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
        <CaretIcon size={ICON.xs} />
      </button>
      {epic ? (
        <>
          <div className="agx-jl-eph">
            <span className="agx-jl-name agx-jl-trunc" data-tip={tipAttr(lane.status)}>{lane.status}</span>
            <span className="sub">{[epic.key, `${epic.done}/${lane.cards.length} done`, `${epic.live} live ${epic.live === 1 ? "worker" : "workers"}`, epic.waiting ? `${epic.waiting} ${epic.waiting === 1 ? "needs" : "need"} you` : null, epic.spent ? `$${epic.spent.toFixed(2)} in agents` : null, lane.points > 0 ? `${lane.points} pts` : null].filter(Boolean).join(" · ")}</span>
          </div>
          <span className="agx-jl-stack" role="img" aria-label={`Status breakdown: ${epic.stack.map((x) => `${x.n} ${x.status}`).join(", ")}`}
            data-tip={tipAttr({ name: "Status breakdown", text: epic.stack.map((x) => `${x.n} ${x.status}`).join(" · ") })}>
            {epic.stack.map((x) => <i key={x.status} style={{ flex: x.n, background: x.color ?? "var(--text4)" }} />)}
          </span>
          <span className="agx-jl-next" onClick={(e) => e.stopPropagation()}>
            {epic.next
              ? <>Next: <button type="button" className="agx-jl-btn pri" onClick={() => epic.onNext(epic.next!.id)} data-tip={tipAttr(epic.next.label)}>{epic.next.label}</button></>
              : <span>Next: nothing waiting</span>}
          </span>
        </>
      ) : (
        <>
          <span className="agx-jl-sdot" aria-hidden />
          <span className="agx-jl-name agx-jl-trunc" data-tip={tipAttr(lane.status)}>{lane.status}</span>
          <span className="agx-jl-count" aria-label={`${lane.cards.length} cards`}>{lane.cards.length}</span>
          <span className="agx-jl-gap" />
          {lane.points > 0 && <span className="agx-jl-pts">{lane.points} pts</span>}
        </>
      )}
      {!epic && <ListIconBtn label="Sort this lane" tip={sort === "rank" ? "Sort this lane" : `Sorted by ${how.label.toLowerCase()}`} size={28} on={sort !== "rank"}
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setPick({ x: r.left, y: r.bottom + 4 }); }}>
        <SortIcon size={ICON.sm} />
      </ListIconBtn>}
      {pick && (
        <div onClick={(e) => e.stopPropagation()}>
          <JiraMenuView menu={sortMenu(lane.status, sort)} x={pick.x} y={pick.y} onClose={() => setPick(null)}
            onPick={(pickId) => { if (pickId.startsWith("sort:")) setLaneSort(viewId, id, pickId.slice("sort:".length) as LaneSort); }} />
        </div>
      )}
    </div>
  );
}
