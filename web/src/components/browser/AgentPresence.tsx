/*
 * The page-side half of "an agent is on this tab": drawn by the panel OVER the
 * guest, never inside the page, so no element of ours lands in somebody's DOM
 * and nothing is lost when the page navigates.
 *
 *   - the rim: a violet hairline on the page edge and a faint inner haze,
 *     painted once when acting starts;
 *   - the satellite: the mark's green contact riding the edge, the only thing
 *     that moves, transform alone on one 20px element (the compositor runs it);
 *   - the pointer: a drawn arrow that glides to where the last act landed, with
 *     a few words of what it was. The person's own mouse is never touched;
 *   - the dock: who is driving, what it just did, and the one control.
 *
 * All of it is driven by the act events the panel already has. Nothing polls.
 * Ceiling: the pointer arrives AFTER the act (the landing is reported when the
 * act is done), and page zoom other than 100 % puts it off by the zoom factor.
 */
import { useEffect, useRef, useState } from "react";
import type { TabAgent } from "../../lib/browserAgentActivity.ts";
import { PRESENCE_LINGER_MS, lapKeyframes, presenceLabel, travelMs } from "../../lib/browserAgentActivity.ts";
import type { ActLanding } from "../../lib/browserDrive.ts";
import { LivingMark } from "../Logo.tsx";

const LAP_MS = 18_000;
const calmNow = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Up while the agent works, and for a beat after: an agent works in bursts
   with a model call between them, and a rim that blinks between every two
   clicks reads as nervous, not as held. The island reads the same answer, so
   the pill never says an agent is driving while the page shows nobody. */
export function useAgentLive(agent: TabAgent | undefined): boolean {
  const working = agent?.working ?? 0, paused = !!agent?.paused;
  const [live, setLive] = useState(working > 0 && !paused);
  useEffect(() => {
    if (paused) { setLive(false); return; }
    if (working > 0) { setLive(true); return; }
    const t = setTimeout(() => setLive(false), PRESENCE_LINGER_MS);
    return () => clearTimeout(t);
  }, [working, paused]);
  return live;
}

export function AgentPresence({ agent, landing, onToggle, quiet = false }: {
  agent: TabAgent;
  landing: ActLanding | null;
  onToggle: () => void;
  /** The island tucked away because the page is the person's: the dock leaves with it. */
  quiet?: boolean;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const sat = useRef<HTMLDivElement | null>(null);
  const lap = useRef<Animation | null>(null);
  const last = useRef({ x: 48, y: 40 });
  const live = useAgentLive(agent);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; travel: number; seq: number } | null>(null);

  /* The lap is rebuilt only when the page changes size. */
  useEffect(() => {
    const el = root.current, s = sat.current;
    if (!el || !s || typeof ResizeObserver === "undefined") return;
    const build = () => {
      lap.current?.cancel();
      const kf = lapKeyframes(el.clientWidth, el.clientHeight);
      if (!kf.length || typeof s.animate !== "function") return;
      lap.current = s.animate(kf, { duration: LAP_MS, iterations: Infinity, easing: "linear" });
      if (!liveRef.current || calmNow()) lap.current.pause();
    };
    const ro = new ResizeObserver(build);
    ro.observe(el);
    return () => { ro.disconnect(); lap.current?.cancel(); lap.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const a = lap.current;
    if (!a) return;
    if (live && !calmNow()) a.play(); else a.pause();
  }, [live]);

  useEffect(() => {
    if (!landing) return;
    const x = Math.round(landing.x + Math.min(34, landing.w / 2)), y = Math.round(landing.y + landing.h / 2);
    const travel = calmNow() ? 0 : travelMs(x - last.current.x, y - last.current.y);
    last.current = { x, y };
    setGhost((g) => ({ x, y, travel, label: presenceLabel(landing.verb, landing.name, landing.key), seq: (g?.seq ?? 0) + 1 }));
  }, [landing]);

  const shown = live ? " agx-presence-on" : "";
  return (
    <div ref={root} className={"agx-presence" + shown} aria-hidden={!agent.paused && !live}>
      <div className="agx-presence-rim" />
      <div ref={sat} className="agx-presence-sat" />
      {/* A pane of glass over the page while an agent drives it: the person's
          pointer, wheel and keys stop here, so not even a hover reaches the page
          until Take over. The agent's own input goes to the guest directly. */}
      {live && <div className="agx-presence-glass" tabIndex={-1} onPointerDown={(e) => e.currentTarget.focus({ preventScroll: true })} />}
      {ghost && (
        <div className="agx-presence-ghost" style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)`, transitionDuration: `${ghost.travel}ms` }}>
          <svg className="agx-presence-arrow" viewBox="0 0 20 20" aria-hidden>
            <path d="M3 2 16.5 9.6l-6.1 1.3-2.9 6.1z" fill="var(--agx-mark)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="7.6" cy="16.4" r="2.4" fill="var(--agx-contact)" stroke="#fff" strokeWidth="1.2" />
          </svg>
          <span className="agx-presence-label">{ghost.label}</span>
        </div>
      )}
      {(live || agent.paused) && !quiet && (
        <div className={"agx-presence-dock" + (agent.paused ? " is-yours" : "")} role="status" aria-live="polite">
          <LivingMark size={22} style={{ color: "var(--agx-mark)" }} />
          <div className="agx-presence-who">
            <span className="agx-presence-task">{agent.paused ? "You have this tab" : `${agent.agent} is driving this tab`}</span>
            <span className="agx-presence-sub">
              {agent.paused ? `${agent.agent} waits; its asks are refused until you hand it back` : (agent.working > 0 ? ghost?.label ?? "working" : "thinking")}
            </span>
          </div>
          <button type="button" className={agent.paused ? "is-primary" : ""} onClick={onToggle}>
            {agent.paused ? "Hand back" : "Take over"}
          </button>
        </div>
      )}
    </div>
  );
}
