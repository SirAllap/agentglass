import { useEffect, useState } from "react";
import { watchLane } from "../../lib/desktop.ts";
import type { IslandLane } from "../../lib/laneView.ts";
import { BROWSER } from "../../lib/layers.ts";
import { ICON } from "../../lib/iconSize.ts";
import { LINE } from "../workspace/Chrome.tsx";
import { CloseIcon } from "./icons.tsx";

/**
 * An agent's lane, live, over the page in the Browser pane.
 *
 * The lane is the agent's own offscreen window; what is shown here is its
 * frames as it paints them (electron/lane-watch.js). Looking only: the picture
 * takes no pointer or key, the lane's page gets no focus and no event, so the
 * agent works on exactly as it would unwatched. Closing it stops the frames.
 */
export function LaneWatch({ lane, onClose }: { lane: IslandLane; onClose: () => void }) {
  const [frame, setFrame] = useState<{ src: string; title: string; url: string } | null>(null);
  const [none, setNone] = useState(false);
  useEffect(() => {
    setFrame(null);
    const stop = watchLane(lane.id, (f) => setFrame({ src: f.src, title: f.title, url: f.url }));
    setNone(!stop);
    return () => { stop?.(); };
  }, [lane.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const title = frame?.title || lane.title || frame?.url || lane.url;
  return (
    <div data-lane-watch={lane.id} className="absolute inset-0 flex flex-col"
      style={{ zIndex: BROWSER.laneWatch, background: "var(--bg)" }}>
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden" aria-live="off">
        {frame
          ? <img src={frame.src} alt={`What ${lane.agent} sees in its lane`} draggable={false}
              className="max-w-full max-h-full object-contain select-none pointer-events-none" />
          : <p className="text-[12px]" style={{ color: "var(--text3)" }}>
              {none ? "This build cannot show a lane. Open agentglass on the desktop to watch it." : "Waiting for the lane's first picture…"}
            </p>}
      </div>
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
        style={{ borderTop: LINE, background: "var(--surface-card)", color: "var(--text2)" }}>
        <span className="font-medium truncate" style={{ color: "var(--text)" }}>{lane.name}</span>
        <span className="truncate" style={{ color: "var(--text3)" }}>{`${lane.agent} · ${lane.busy ? "working" : "idle"}`}{title ? ` · ${title}` : ""}</span>
        <span className="ml-auto shrink-0" style={{ color: "var(--text3)" }}>Watching only: the agent keeps the page</span>
        <button type="button" aria-label="Stop watching" data-tip="Stop watching (Esc)" onClick={onClose}
          className="shrink-0 inline-flex items-center justify-center rounded-md"
          style={{ width: 26, height: 26, color: "var(--text2)" }}>
          <CloseIcon size={ICON.md} />
        </button>
      </div>
    </div>
  );
}
