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
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reducedMotion } from "../../lib/lookPrefs.ts";
import type { AgentStateKey, Steady, TabAgent } from "../../lib/browserAgentActivity.ts";
import { PRESENCE_LINGER_MS, STATE_HOLD_MS, glassHeld, pageOf, STEADY_INIT, agentState, isActVerb, stateOf, steadyStep, lapKeyframes, lookAt, pointerAt, presenceLabel, travelMs, labelFit } from "../../lib/browserAgentActivity.ts";
import type { ActLanding } from "../../lib/browserDrive.ts";
import { LivingMark } from "../Logo.tsx";

const LAP_MS = 18_000;
/** How long the glass waits for the next ask: longer than an agent thinks between two clicks. */
export const GLASS_QUIET_MS = 10_000;

/** Verbs that move the page without being acts in the log's sense, and so raise the glass too. */
const MOVES = new Set(["open", "scroll", "hover"]);
const calmNow = () => reducedMotion();

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

/* The glass's clock, and with it the island's dot: one answer to "is the agent
   working", held through the model call between two asks. `held` is up while an
   ask is in flight and for GLASS_QUIET_MS after; `up` is the part of it that
   puts the pane over the page, which only an agent that changes the page earns
   (a look, a screenshot) and leaves the person's hand on it. */
export function useGlass(agent: TabAgent | undefined, live: boolean): { held: boolean; up: boolean } {
  const working = agent?.working ?? 0, op = agent?.op ?? "";
  const [acting, setActing] = useState(false);
  useEffect(() => {
    if (!live) setActing(false);
    else if (working > 0 && (isActVerb(op) || MOVES.has(op))) setActing(true);
  }, [live, working, op]);
  /* Down on Take over, when it says done, or after GLASS_QUIET_MS without an
     ask. Never the whole 30 s linger: a tab nobody is acting on is the
     person's, and a pane over a webview eats its wheel and its clicks. */
  const [stilled, setStilled] = useState(false);
  useEffect(() => {
    if (working > 0) { setStilled(false); return; }
    const t = setTimeout(() => setStilled(true), GLASS_QUIET_MS);
    return () => clearTimeout(t);
  }, [working]);
  const held = !!agent && glassHeld({ live, done: agent.done, paused: agent.paused, working }, stilled);
  return { held, up: held && acting };
}

/* The raw state, held still: see steadyStep. Re-renders itself when a pending change comes due. */
export function useSteadyState(raw: AgentStateKey | null): { key: AgentStateKey; word: string } | null {
  const ref = useRef<Steady>(STEADY_INIT);
  const [, tick] = useState(0);
  const r = steadyStep(ref.current, raw, Date.now());
  ref.current = r.s;
  useEffect(() => {
    if (r.wait <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), r.wait);
    return () => clearTimeout(t);
  }, [raw, r.s.shown, r.s.candAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return r.s.shown && stateOf(r.s.shown);
}

export function AgentPresence({ agent, landing, url = "", onToggle, quiet = false }: {
  agent: TabAgent;
  /** The tab's address: a new page leaves the pointer pointing at something no longer there. */
  url?: string;
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
  /* Held like the overview's: between back-to-back asks the dock keeps the
     last word for STATE_HOLD_MS, then one re-render lets it say Thinking. */
  const [held, setHeld] = useState(false);
  // Layout effect: set before paint, or the frame between shows Thinking.
  useLayoutEffect(() => {
    if (agent.working > 0 || agent.paused) { setHeld(false); return; }
    setHeld(true);
    const t = setTimeout(() => setHeld(false), STATE_HOLD_MS);
    return () => clearTimeout(t);
  }, [agent.working, agent.paused]);
  const state = useSteadyState(agentState(held ? { ...agent, working: 1 } : agent).key) ?? agentState(agent);
  const { up: glassUp } = useGlass(agent, live);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; travel: number; seq: number } | null>(null);
  const glass = useRef<HTMLDivElement | null>(null);
  /* The pointer stays where the last act landed, in screen pixels; once the
     page under it changes it points at whatever took that place, so it leaves
     with the page and comes back with the next act. */
  const [stale, setStale] = useState(false);
  /* Not for a #fragment: a same-page link changes the address and not the page, and
     every click on one hid the pointer the moment it landed. */
  const seenUrl = useRef(pageOf(url));
  useEffect(() => { const p = pageOf(url); if (p !== seenUrl.current) { seenUrl.current = p; setStale(true); } }, [url]);
  /* The glass stops the keys too, but a page that already had the focus would
     keep getting them: it takes the focus off this tab's page when it rises,
     and only from this tab's page, never from wherever else the person is typing. */
  useEffect(() => {
    const a = document.activeElement;
    if (glassUp && a && a.tagName === "WEBVIEW" && root.current?.parentElement?.contains(a)) glass.current?.focus({ preventScroll: true });
  }, [glassUp]);

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
    const { x, y } = pointerAt(landing, root.current?.clientWidth ?? 0);
    const travel = calmNow() ? 0 : travelMs(x - last.current.x, y - last.current.y);
    last.current = { x, y };
    setStale(false);
    setGhost((g) => ({ x, y, travel, label: presenceLabel(landing.verb, landing.name, landing.key), seq: (g?.seq ?? 0) + 1 }));
  }, [landing]);

  /* The label stays inside the page: beside the arrow, or on its other side near an edge. */
  const label = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const l = label.current, r = root.current;
    if (!l || !r || !ghost) return;
    const { left, top } = labelFit(ghost.x, ghost.y, l.offsetWidth, l.offsetHeight, r.clientWidth, r.clientHeight);
    l.style.left = `${left}px`; l.style.top = `${top}px`;
  }, [ghost]);

  /* The alien on Take over looks at where the agent's pointer lands: pupils <=1.5px,
     head <=6deg, from the same ghost state the arrow is drawn from. It looks at the
     landing, not along the glide (the glide is <=240ms and the eyes ease 200ms).
     No pointer, a stale one or reduced motion: it looks forward. */
  const dock = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const d = dock.current, r = root.current, g = d?.querySelector(".agx-al-head");
    if (!d || !r || !g) return;
    let lx = 0, ly = 0, tilt = 0;
    if (ghost && !stale && !calmNow()) {
      const a = g.getBoundingClientRect(), p = r.getBoundingClientRect();
      ({ lx, ly, tilt } = lookAt(p.left + ghost.x + 3 - (a.left + a.width / 2), p.top + ghost.y + 2 - (a.top + a.height / 2)));
    }
    d.style.setProperty("--agx-lx", lx.toFixed(2));
    d.style.setProperty("--agx-ly", ly.toFixed(2));
    d.style.setProperty("--agx-tilt", tilt.toFixed(2));
  }, [ghost, stale, state.key, agent.paused]);

  const shown = live ? " agx-presence-on" : "";
  return (
    <div ref={root} className={"agx-presence" + shown} aria-hidden={!agent.paused && !live}>
      <div className="agx-presence-rim" />
      <div ref={sat} className="agx-presence-sat" />
      {/* A pane of glass over the page while an agent drives it: the person's
          pointer, wheel and keys stop here, so not even a hover reaches the page
          until Take over. The agent's own input goes to the guest directly. */}
      {glassUp && <div ref={glass} className="agx-presence-glass" tabIndex={-1} onPointerDown={(e) => e.currentTarget.focus({ preventScroll: true })} />}
      {ghost && (
        <div className={"agx-presence-ghost" + (stale ? " is-stale" : "")} style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)`, transitionDuration: `${ghost.travel}ms` }}>
          <svg className="agx-presence-arrow" viewBox="0 0 20 20" aria-hidden>
            <path d="M3 2 16.5 9.6l-6.1 1.3-2.9 6.1z" fill="var(--agx-mark)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="7.6" cy="16.4" r="2.4" fill="var(--agx-contact)" stroke="#fff" strokeWidth="1.2" />
          </svg>
          <span ref={label} className="agx-presence-label">{ghost.label}</span>
        </div>
      )}
      {(live || agent.paused) && !quiet && (
        <div ref={dock} className={"agx-presence-dock is-" + state.key} role="status" aria-live="polite">
          <span className="agx-presence-well"><LivingMark size={28} className="agx-presence-mark" style={{ color: "var(--agx-dock-mark)" }} /></span>
          <div className="agx-presence-who">
            <span className="agx-presence-task" title={`${agent.agent} (this agent's container name)`}>{agent.agent}</span>
            {/* Always there: a dock whose chip comes and goes changes size under the person's hand. */}
            <span className="agx-presence-state"><Swap k={state.key}><StateIcon k={state.key} />{state.word}</Swap></span>
          </div>
          <button type="button" className={agent.paused ? "is-back" : ""} onClick={onToggle} aria-label={agent.paused ? "Hand back" : "Take over"}>
            <Swap k={agent.paused ? "back" : "take"}>{agent.paused ? <><SparkGlyph />Hand back</> : <><AlienGlyph />Take over</>}</Swap>
          </button>
        </div>
      )}
    </div>
  );
}

/* A word or icon that changes crosses over instead of swapping in place: the new
   one rises in, the old one lifts out, and the host's width follows the new one,
   so what sits beside it slides rather than jumps. Transform, opacity, blur and
   width only; the out layer is aria-hidden so a reader hears one word. */
function Swap({ k, children }: { k: string; children: ReactNode }) {
  const [st, setSt] = useState<{ k: string; node: ReactNode; old: { k: string; node: ReactNode } | null }>({ k, node: children, old: null });
  if (st.k !== k) setSt({ k, node: children, old: { k: st.k, node: st.node } });
  useEffect(() => {
    if (!st.old) return;
    const t = setTimeout(() => setSt((x) => ({ ...x, old: null })), 280);
    return () => clearTimeout(t);
  }, [st.old]);
  const cur = useRef<HTMLSpanElement | null>(null);
  const [w, setW] = useState<number | undefined>(undefined);
  // Measured again whenever the layer's size changes, not once per word: a dock
  // mounted in a hidden panel measured 0 and stayed a 26 px button with its label
  // spilling out, and a font-size change left the label 11 px wider than its host.
  useLayoutEffect(() => {
    const el = cur.current;
    if (!el) return;
    // The used width, fractional and before transforms: offsetWidth rounds, and left the chip's word up to 1 px over.
    const fit = () => setW(Math.ceil(parseFloat(getComputedStyle(el).width)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [st.k]);
  return (
    <span className="agx-swap" style={{ width: w }}>
      {st.old && <span key={"o" + st.old.k} className="agx-swap-lay is-out" aria-hidden>{st.old.node}</span>}
      <span key={"n" + st.k} ref={cur} className="agx-swap-lay is-in">{st.node}</span>
    </span>
  );
}

/* Take over: a small alien, our planet's visitor. The eyes widen on hover and
   blink on press (CSS), and look at the agent's pointer (lookAt). */
function AlienGlyph() {
  return (
    <svg className="agx-gl agx-al" viewBox="0 0 24 24" aria-hidden>
      <defs><clipPath id="agx-al-clip"><path d="M12 2.4c-5 0-8.4 4.1-8.4 8.7 0 4.8 3.9 9.6 7.2 10.4.4.1.9.1 1.4 0 3.3-.8 7.2-5.6 7.2-10.4 0-4.6-3.4-8.7-7.4-8.7Z" /></clipPath></defs>
      <g className="agx-al-head">
        <path fill="currentColor" d="M12 2.4c-5 0-8.4 4.1-8.4 8.7 0 4.8 3.9 9.6 7.2 10.4.4.1.9.1 1.4 0 3.3-.8 7.2-5.6 7.2-10.4 0-4.6-3.4-8.7-7.4-8.7Z" />
        <g clipPath="url(#agx-al-clip)"><g className="agx-al-eyes">
          <path className="agx-al-eye" fill="var(--agx-dock-take)" d="M5.9 9.9c2.1-.5 4.7.7 5.4 3.3-2.3.5-4.9-.5-5.4-3.3Z" />
          <path className="agx-al-eye" fill="var(--agx-dock-take)" d="M18.1 9.9c-2.1-.5-4.7.7-5.4 3.3 2.3.5 4.9-.5 5.4-3.3Z" />
        </g></g>
        <path d="M10.6 17.4h2.8" stroke="var(--agx-dock-take)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}

/* Hand back: the AI's own little visitor, a star with eyes inside the planet's
   orbit. It pulses and a dot circles it at rest, leans in on hover, blinks on press. */
function SparkGlyph() {
  return (
    <svg className="agx-gl agx-sp" viewBox="0 0 24 24" aria-hidden>
      <g transform="rotate(-32 12 12)">
        <ellipse className="agx-sp-ring" cx="12" cy="12" rx="10.5" ry="4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <g className="agx-sp-x"><g className="agx-sp-y"><circle cx="12" cy="12" r="1.55" fill="#e9defd" /></g></g>
      </g>
      <g className="agx-sp-lift">
        <path className="agx-sp-star" fill="currentColor" d="M12 3.2C13 8.3 15.7 11 20.8 12 15.7 13 13 15.7 12 20.8 11 15.7 8.3 13 3.2 12 8.3 11 11 8.3 12 3.2Z" />
        <ellipse className="agx-sp-eye" cx="10.35" cy="12" rx="1.1" ry="1.45" fill="#7c4de8" />
        <ellipse className="agx-sp-eye" cx="13.65" cy="12" rx="1.1" ry="1.45" fill="#7c4de8" />
      </g>
    </svg>
  );
}

/* One small drawing per state, in the dock's chip. Stroked at 1.75 on a 16 grid
   like the house icons; the moving part of each is in CSS (.agx-st-*). */
export function StateIcon({ k }: { k: AgentStateKey }) {
  const p = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (k) {
    case "clicking": return <svg {...p}><path d="M6 5.5 12.5 8 9.6 9l-1 3z" /><circle className="agx-st-ring" cx="6" cy="5.5" r="3.5" /></svg>;
    case "typing": return <svg {...p}><rect x="1.5" y="4" width="13" height="8" rx="2" /><path className="agx-st-caret" d="M5 10h6" /></svg>;
    case "navigating": return <svg {...p}><circle cx="8" cy="8" r="6" /><path className="agx-st-needle" d="m10.5 5.5-1.6 3.4-3.4 1.6 1.6-3.4z" /></svg>;
    case "scrolling": return <svg {...p}><path className="agx-st-up" d="m5 6 3-3 3 3" /><path className="agx-st-down" d="m5 10 3 3 3-3" /></svg>;
    case "pointing": return <svg {...p}><path d="M4 2.5 12 7l-3.6.9L6.8 11.5z" /></svg>;
    case "reading": return <svg {...p}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle className="agx-st-pupil" cx="8" cy="8" r="2" /></svg>;
    case "scripting": return <svg {...p}><path d="m6 5-3.5 3L6 11M10 5l3.5 3L10 11" /></svg>;
    case "thinking": return <svg {...p} stroke="none" fill="currentColor"><circle className="agx-st-dot" cx="3.5" cy="8" r="1.5" /><circle className="agx-st-dot" cx="8" cy="8" r="1.5" /><circle className="agx-st-dot" cx="12.5" cy="8" r="1.5" /></svg>;
    case "done": return <svg {...p}><circle cx="8" cy="8" r="6" /><path className="agx-st-tick" d="m5.4 8.2 1.8 1.8 3.4-3.6" /></svg>;
    case "waiting": return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.4" /></svg>;
    case "working": return <svg {...p}><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="5.6" /></svg>;
    case "yours": return <svg {...p}><path d="M5.5 8V3.8a1.2 1.2 0 0 1 2.4 0V7m0-1.2a1.2 1.2 0 0 1 2.4 0V7.5m0-.7a1.2 1.2 0 0 1 2.4 0v2.7a4.5 4.5 0 0 1-4.5 4.5h-.4a4 4 0 0 1-3.2-1.6L2.8 10a1.2 1.2 0 0 1 1.9-1.4L5.5 9.6" /></svg>;
  }
}
