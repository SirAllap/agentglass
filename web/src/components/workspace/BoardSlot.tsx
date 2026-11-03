/*
 * A place a board can be shown in: its view on the rail, or a bench tab.
 *
 * It holds nothing itself. The board is rendered once by the workspace and its
 * element is moved in here while this place holds it — see lib/boardHost.ts.
 * While it does not, this says where the board is and offers to bring it,
 * because an empty view that looks broken is worse than one sentence.
 */
import { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  boardActive, boardHolder, boardPlace, claimSlot, registerSlot, setSlotVisible, subscribeBoards,
  type BoardKind, type BoardPlace,
} from "../../lib/boardHost.ts";
import { Chip } from "./Chrome.tsx";
import { closeBench } from "../../lib/benchStore.ts";

const NAME: Record<BoardKind, string> = { pr: "Pull requests", tasks: "Tasks" };

const ELSEWHERE: Record<BoardPlace, string> = {
  bench: "is open in the floating window",
  rail: "is open in its view, behind this window",
};

export function BoardSlot({ kind, place, visible }: { kind: BoardKind; place: BoardPlace; visible: boolean }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const seenVisible = useRef(visible);
  seenVisible.current = visible;

  /* Layout effects, so the board is inside this box before the frame is
     painted — a passive effect paints the placeholder for a frame first. */
  useLayoutEffect(() => {
    if (!box.current) return;
    return registerSlot(id, kind, place, box.current, seenVisible.current);
  }, [id, kind, place]);
  useLayoutEffect(() => {
    /* Going to the view while the bench is showing the board is asking to read
       it in the view — so the bench, which would be left covering it with a
       sentence saying the board is behind it, gets out of the way. Its tabs
       are kept; opening it again on this tab takes the board back. */
    if (visible && place === "rail" && boardPlace(kind) === "bench" && boardActive(kind)) closeBench();
    setSlotVisible(id, visible);
  }, [id, visible, kind, place]);

  const holds = useSyncExternalStore(subscribeBoards, () => boardHolder(kind) === id, () => false);
  const where = useSyncExternalStore(subscribeBoards, () => boardPlace(kind), () => null);

  return (
    <div ref={box} className="relative flex-1 min-h-0 h-full w-full flex flex-col"
      /* The board's own ground, wherever it is shown. The bench is --bg2, and a
         task row's sticky title cell is opaque --bg so a sideways scroll does
         not show through it (index.css, .agx-stick) — on --bg2 every row wore a
         darker box behind its title. */
      style={{ background: "var(--bg)" }}>
      {!holds && where && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-[12px]" style={{ color: "var(--text2)" }}>{NAME[kind]} {ELSEWHERE[where]}.</div>
          <div className="text-[10.5px] max-w-[360px]" style={{ color: "var(--text4)" }}>
            One board, shown in one place at a time, so both places always agree.
          </div>
          <Chip primary onClick={() => claimSlot(id)}>Show it here</Chip>
        </div>
      )}
    </div>
  );
}
