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
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { reducedMotion } from "../../lib/lookPrefs.ts";
import type { AgentStateKey, GuideAnswer, GuideRect, GuideStepUi, Steady, TabAgent, TabGuide } from "../../lib/browserAgentActivity.ts";
import { auditLeft, bubbleOf, bubblePlace, dockPlace, type PaneBox, guideCard, GUIDE_LEAVE_ASK, GUIDE_SUMMARY_HEAD, GUIDE_LEAVE_YES, guideOffscreen, guidePaneWidth, guideRectIn, guiding, tabState, typingMs } from "../../lib/browserAgentActivity.ts";
import { CARD_FLOW_INIT, CARD_LEAVE_CALM_MS, CARD_LEAVE_MS, CARD_WAIT_CAP_MS, cardDotted, cardFlow, cardMotion, cardReady, auditAfterFade, auditWait, guideResumable, GUIDE_TYPING_IDLE_MS, guideCardKey, guideDotAt, type CardFlow } from "../../lib/browserAgentActivity.ts";
import { PRESENCE_LINGER_MS, STATE_HOLD_MS, glassBlocks, glassHeld, pageOf, STEADY_INIT, agentState, isActVerb, stateOf, steadyStep, lapKeyframes, lookAt, pointerAt, presenceLabel, travelMs, labelFit } from "../../lib/browserAgentActivity.ts";
import type { ActLanding } from "../../lib/browserDrive.ts";
import { LivingMark } from "../Logo.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";

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
  return { held, up: glassBlocks({ held, acting, paused: !!agent?.paused, handoff: agent?.handoff, guiding: guiding(agent) }) };
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

export function AgentPresence({ agent, landing, url = "", onToggle, onGuide, onSuggest, onRegenerate, quiet = false }: {
  agent: TabAgent;
  /** The person answered the guide: OK, Back, Stop, Done, or `close` for the audit card. */
  onGuide?: (answer: GuideAnswer | "close") => void;
  /** The person clicked Insert (or Replace with) suggestion: puts the step's draft in its field. */
  onSuggest?: (replace: boolean) => Promise<SuggestResult>;
  onRegenerate?: (note: string) => boolean;
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
  const guide = agent.guide;
  const isGuiding = guiding(agent);
  /* One readout for the pill, the overview and the dock: tabState puts guiding first. */
  const raw = isGuiding ? tabState(agent, undefined, Date.now())!.key : agentState(held ? { ...agent, working: 1 } : agent).key;
  const state = useSteadyState(raw) ?? agentState(agent);
  const lastStep = isGuiding ? guide!.steps[guide!.steps.length - 1] : undefined;
  /* The observer's rect is in the page's px; the ring, pointer and bubble draw in the pane's,
     scaled by the pane's width now: a pane or window resize re-renders this at once. */
  const [paneW, setPaneW] = useState(0);
  useEffect(() => {
    const r = root.current;
    if (!r || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setPaneW(r.clientWidth));
    ro.observe(r);
    return () => ro.disconnect();
  }, []);
  const step = lastStep?.rect ? { ...lastStep, rect: guideRectIn(lastStep.rect, guidePaneWidth(root.current?.clientWidth, paneW)) } : lastStep;
  /* Scrolled out of the page's view: no ring, and the bubble says which way to scroll. */
  const off = lastStep?.rect && !lastStep.navigated ? guideOffscreen(lastStep.rect) : null;
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

  /* In a guide the pointer sits on the target's live rect, not on the last act's landing. */
  useEffect(() => {
    const r = step?.rect;
    if (!r) return;
    const x = Math.round(r.x + Math.min(34, r.w / 2)) - 3, y = Math.round(r.y + r.h / 2) - 2;
    const travel = calmNow() ? 0 : travelMs(x - last.current.x, y - last.current.y);
    last.current = { x, y };
    setStale(false);
    setGhost((g) => ({ x, y, travel, label: "", seq: (g?.seq ?? 0) + 1 }));
  }, [step?.rect?.x, step?.rect?.y, step?.rect?.w, step?.rect?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = live || isGuiding ? " agx-presence-on" : "";
  /* No dock during a guide: the top pill carries it (step, who, End guide). Taken over, Hand back still shows here. */
  const docked = (agent.paused || (live && !isGuiding)) && !quiet;
  /* The ring the person must reach: nothing of ours may cover it. */
  const ring = isGuiding && step?.rect && !step.navigated && !off ? step.rect : null;
  /* During a guide the dock moves off the ring (dockPlace); otherwise its CSS place, bottom centre. */
  useLayoutEffect(() => {
    const d = dock.current, r = root.current;
    if (!d || !r) return;
    const place = () => {
      const p = dockBoxFor(ring, r, d);
      d.classList.toggle("is-placed", !!p);
      d.classList.toggle("is-through", !!p?.through);
      d.style.left = p ? `${p.x}px` : "";
      d.style.top = p ? `${p.y}px` : "";
    };
    place();
    if (!ring || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(r); ro.observe(d);
    return () => ro.disconnect();
  }, [ring?.x, ring?.y, ring?.w, ring?.h, docked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={root} className={"agx-presence" + shown} aria-hidden={!agent.paused && !live && !guide}>
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
          {!isGuiding && ghost.label && <span ref={label} className="agx-presence-label">{ghost.label}</span>}
        </div>
      )}
      {ring && <GuideRing rect={ring} got={!!step?.clicked} />}
      {isGuiding && step && (
        <GuideCards step={step} off={off} ring={ring} first={guide!.steps.length === 1 || step.n === 1} root={root} dock={dock} onAnswer={(a) => onGuide?.(a)} {...(onSuggest ? { onSuggest } : {})} {...(onRegenerate ? { onRegenerate } : {})} />
      )}
      {/* Not gone with the tucked island: its Resume must stay reachable while it is valid. */}
      {guide && !guide.on && <GuideAudit key={guide.startedAt} guide={guide} onResume={() => onGuide?.("resume")} onGone={() => onGuide?.("close")} />}
      {docked && (
        <div ref={dock} className={"agx-presence-dock is-" + state.key} role="status" aria-live="polite">
          <span className="agx-presence-well"><LivingMark size={28} className="agx-presence-mark" style={{ color: "var(--agx-dock-mark)" }} /></span>
          <div className="agx-presence-who">
            <span className="agx-presence-task" data-tip={`${agent.agent} (this agent's container name)`}>{agent.agent}</span>
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

/* The dock's box during a guide, from the same pure placement the bubble reads, so the two agree. Null with no ring. */
function dockBoxFor(ring: GuideRect | null, r: HTMLElement, d: HTMLElement): (PaneBox & { through: boolean }) | null {
  if (!ring) return null;
  const p = dockPlace(ring, { w: r.clientWidth, h: r.clientHeight }, { w: d.offsetWidth, h: d.offsetHeight }, overlaysOver(r));
  return { x: p.left, y: p.top, w: d.offsetWidth, h: d.offsetHeight, through: p.through };
}

/* Overlays drawn over this pane that are not ours (the island's pill, marked data-agx-overlay), in the pane's pixels. */
function overlaysOver(r: HTMLElement): PaneBox[] {
  const o = r.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("[data-agx-overlay]")].flatMap((el) => {
    const b = el.getBoundingClientRect();
    const box = { x: b.left - o.left, y: b.top - o.top, w: b.width, h: b.height };
    return b.width && b.height && box.x < o.width && box.y < o.height && box.x + box.w > 0 && box.y + box.h > 0 ? [box] : [];
  });
}

/* The ring round the pointed element, drawn over the guest from its live rect. On the person's
   click it presses (.97, 100 ms) and turns green, then fades: got it. */
function GuideRing({ rect, got }: { rect: GuideRect; got: boolean }) {
  return <div className={"agx-presence-ring" + (got ? " is-got" : "")} style={{ transform: `translate(${rect.x - 3}px, ${rect.y - 3}px)`, width: rect.w + 6, height: rect.h + 6 }} />;
}

/*
 * The step cards, one visit at a time (mockup "New · standard"). A new step
 * sends the shown card out where it is, frozen (it stops reading the rect, so
 * it never slides to wherever the page put it); the next card mounts only
 * once the leave is done AND its rect is known (cardFlow, at most
 * CARD_WAIT_CAP_MS), at its own anchor. Nothing travels between anchors.
 */
function GuideCards(props: {
  step: GuideStepUi; off: "up" | "down" | null; ring: GuideRect | null; first: boolean;
  root: { current: HTMLDivElement | null }; dock: { current: HTMLDivElement | null };
  onAnswer: (a: GuideAnswer) => void;
  onSuggest?: (replace: boolean) => Promise<SuggestResult>;
  onRegenerate?: (note: string) => boolean;
}) {
  const { step } = props;
  const key = guideCardKey(step);
  const [flow, setFlow] = useState<CardFlow>(CARD_FLOW_INIT);
  /* What the shown card last drew, kept for its leave: the step after it is already the new one. */
  const seen = useRef<{ key: string; step: GuideStepUi; first: boolean; off: "up" | "down" | null } | null>(null);
  const out = useRef<typeof seen.current>(null);
  useLayoutEffect(() => {
    setFlow((f) => {
      const n = cardFlow(f, { type: "step", key, at: Date.now() });
      if (n.leaving && n.leaving !== f.leaving && seen.current?.key === n.leaving) out.current = seen.current;
      return n;
    });
  }, [key]);
  useEffect(() => {
    if (!flow.leaving) return;
    const k = flow.leaving;
    const t = setTimeout(() => setFlow((f) => cardFlow(f, { type: "left", key: k })), calmNow() ? CARD_LEAVE_CALM_MS : CARD_LEAVE_MS);
    return () => clearTimeout(t);
  }, [flow.leaving]);
  const ready = cardReady(step);
  useEffect(() => {
    if (!flow.next || flow.leaving) return;
    if (ready) { setFlow((f) => cardFlow(f, { type: "tick", at: Date.now(), ready: true })); return; }
    const t = setTimeout(() => setFlow((f) => cardFlow(f, { type: "tick", at: Date.now(), ready: false })), Math.max(0, flow.since + CARD_WAIT_CAP_MS - Date.now()));
    return () => clearTimeout(t);
  }, [flow.next, flow.leaving, flow.since, ready]);
  if (flow.shown === key) seen.current = { key, step, first: props.first, off: props.off };
  /* The person typing in the target field: the card folds to a dot beside it, back on blur or after GUIDE_TYPING_IDLE_MS. */
  const [, tick] = useState(0);
  useEffect(() => {
    if (step.typingAt === undefined) return;
    const left = step.typingAt + GUIDE_TYPING_IDLE_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [step.typingAt]);
  const [peek, setPeek] = useState(false);
  const dotted = flow.shown === key && cardDotted(step, Date.now()) && !!props.ring;
  useEffect(() => { if (!dotted) setPeek(false); }, [dotted]);
  const cards = [
    ...(flow.leaving && out.current?.key === flow.leaving ? [{ ...out.current, leaving: true }] : []),
    ...(flow.shown === key ? [{ key, step, first: props.first, off: props.off, leaving: false }] : []),
  ];
  const r = props.root.current;
  const dot = dotted && r ? guideDotAt(props.ring!, { w: r.clientWidth, h: r.clientHeight }, HIT) : null;
  return (
    <>
      {cards.map((c) => (
        <GuideBubble key={c.key} step={c.step} off={c.off} ring={c.leaving ? null : props.ring} first={c.first} root={props.root} dock={props.dock}
          frozen={c.leaving || !!c.step.clicked || !!c.step.navigated} leaving={c.leaving} folded={!c.leaving && dotted && !peek}
          onPeek={setPeek} onAnswer={props.onAnswer} {...(props.onSuggest ? { onSuggest: props.onSuggest } : {})} {...(props.onRegenerate ? { onRegenerate: props.onRegenerate } : {})} />
      ))}
      {dot && (
        <button type="button" className={"agx-bubble-dot" + (peek ? " is-open" : "")} aria-label="Show the step"
          style={{ translate: `${dot.x}px ${dot.y}px`, width: HIT, height: HIT }}
          onPointerEnter={() => setPeek(true)} onFocus={() => setPeek(true)} onPointerLeave={() => setPeek(false)} onBlur={() => setPeek(false)} />
      )}
    </>
  );
}

/* The caption types in (at most 600 ms, none with reduced motion); any answer shows the rest at once. */
function useTyped(text: string): [number, () => void] {
  const total = typingMs(text.length, calmNow());
  const [n, setN] = useState(total ? 0 : text.length);
  useEffect(() => {
    if (!total || n >= text.length) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / total);
      setN(Math.max(1, Math.round(k * text.length)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return [n, () => setN(text.length)];
}

const ANSWER_WORD: Record<GuideAnswer, string> = { ok: "OK", back: "Back", stop: "Stop", done: "Done", resume: "Resume" };

/* What the page is about, under the say line: the agent's own words from a
   read of the page, so the person knows the ground before they act. Text, never
   markup; long ones scroll inside the block, the buttons stay in view. */
export function GuideSummary({ text }: { text: string }) {
  return (
    <div className="agx-bubble-summary">
      <span className="agx-bubble-summary-head">{GUIDE_SUMMARY_HEAD}</span>
      <p className="agx-bubble-summary-text">{text}</p>
    </div>
  );
}

/* The words the person will paste, under the say line: a 3-line preview and a
   Copy chip. A React text node, so markup in it shows as text; the clipboard is
   written only from the person's own click, never by itself. */
export function GuideCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  };
  return (
    <div className="agx-bubble-copy">
      <pre className="agx-bubble-copy-text">{text}</pre>
      <button type="button" className={"agx-bubble-chip" + (copied ? " is-done" : "")} style={{ height: HIT }} onClick={copy} aria-live="polite">
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {copied ? <path d="M3.5 8.5 6.5 11.5 12.5 4.5" /> : <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>}
        </svg>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export type SuggestResult = { ok: true; inserted: true } | { ok: true; filled: true } | { ok: false; error: string };
export const SUGGEST_INSERT = "Use suggestion";
export const SUGGEST_REPLACE = "Replace with suggestion";
export const SUGGEST_ASK = "Replace the text in the field?";
export const SUGGEST_MINE = "Write my own";
export const SUGGEST_ANOTHER = "Suggest another";
export const SUGGEST_WRITING = "Writing a new one\u2026";
export const SUGGEST_NOTE_HINT = "What to change, e.g. shorter (optional)";

/** A click the person made with their own hand: the browser marks a script's synthetic click untrusted. */
export function personClicked(e: { nativeEvent?: { isTrusted?: boolean } }): boolean {
  return e.nativeEvent?.isTrusted === true;
}

/* A draft for the field the card points at, under the say line: a 4-line
   preview and three choices. "Use suggestion" puts it in the field: only the
   person's own click (onInsert), and a field with text in it asks once, here in
   the card, before it is replaced. It never submits. "Write my own" closes the
   draft and leaves the field to them. "Suggest another" asks the agent for a new
   one with an optional one-line note (onRegenerate), and the card says it is
   writing until the new draft replaces this one in place. Text, never markup. */
export function GuideSuggest({ text, filled, onInsert, onRegenerate, asking: askingAtFirst = false, noting: notingAtFirst = false }: {
  text: string; filled: boolean; onInsert?: (replace: boolean) => Promise<SuggestResult>;
  onRegenerate?: (note: string) => boolean;
  /** Tests: draw the card as it asks, or with the note row open. */
  asking?: boolean; noting?: boolean;
}) {
  const [hasText, setHasText] = useState(filled);
  const [asking, setAsking] = useState(askingAtFirst);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [noting, setNoting] = useState(notingAtFirst);
  const [note, setNote] = useState("");
  const [writing, setWriting] = useState(false);
  /* A new draft from the agent: the card is fresh again. */
  useEffect(() => { setWriting(false); setMine(false); setNoting(notingAtFirst); setNote(""); setAsking(askingAtFirst); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  if (mine) return null;
  const put = (replace: boolean) => {
    if (!onInsert) return;
    void onInsert(replace).then((r) => {
      if (!r.ok) { setErr(r.error); setAsking(false); return; }
      setErr(null);
      if ("filled" in r) { setHasText(true); setAsking(true); return; }
      setAsking(false); setHasText(true); setDone(true);
    }, () => undefined);
  };
  const press = (e: ReactMouseEvent) => {
    if (!personClicked(e)) return;
    if (hasText) { setAsking(true); return; }
    put(false);
  };
  const replace = (e: ReactMouseEvent) => { if (personClicked(e)) put(true); };
  const send = (e: { nativeEvent?: { isTrusted?: boolean } }) => {
    if (!personClicked(e) || !onRegenerate) return;
    if (!onRegenerate(note)) { setErr("This step is over"); setNoting(false); return; }
    setErr(null); setNoting(false); setWriting(true);
  };
  const chip = "agx-bubble-chip";
  return (
    <div className="agx-bubble-copy is-draft">
      <pre className={"agx-bubble-copy-text is-draft" + (writing ? " is-stale" : "")}>{text}</pre>
      {err && <p className="agx-bubble-note">{err}</p>}
      {writing ? (
        <span className="agx-bubble-wait" aria-live="polite"><i />{SUGGEST_WRITING}</span>
      ) : asking ? (
        <div className="agx-bubble-draft-ask">
          <span className="agx-bubble-wait">{SUGGEST_ASK}</span>
          <button type="button" className={chip} style={{ height: HIT }} onClick={() => setAsking(false)}>Keep mine</button>
          <button type="button" className={chip} style={{ height: HIT }} onClick={replace}>Replace</button>
        </div>
      ) : noting ? (
        <form className="agx-bubble-draft-note" onSubmit={(e) => { e.preventDefault(); send(e); }}>
          <input type="text" className={"agx-bubble-draft-input " + INPUT} style={{ ...INPUT_STYLE, height: HIT }} value={note} maxLength={200} autoFocus
            placeholder={SUGGEST_NOTE_HINT} aria-label={SUGGEST_NOTE_HINT} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNoting(false); } }} />
          <button type="button" className={chip} style={{ height: HIT }} onClick={() => setNoting(false)}>Cancel</button>
          <button type="submit" className={chip + " is-primary"} style={{ height: HIT }}>Send</button>
        </form>
      ) : (
        <div className="agx-bubble-draft-row">
          <button type="button" className={chip} style={{ height: HIT }} onClick={(e) => { if (personClicked(e)) setMine(true); }}>{SUGGEST_MINE}</button>
          {onRegenerate && <button type="button" className={chip} style={{ height: HIT }} onClick={(e) => { if (personClicked(e)) setNoting(true); }}>{SUGGEST_ANOTHER}</button>}
          <button type="button" className={chip + " is-primary" + (done ? " is-done" : "")} style={{ height: HIT }} onClick={press} aria-live="polite">
            <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {done ? <path d="M3.5 8.5 6.5 11.5 12.5 4.5" /> : <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />}
            </svg>
            {done ? "Inserted" : hasText ? SUGGEST_REPLACE : SUGGEST_INSERT}
          </button>
        </div>
      )}
    </div>
  );
}

/* The speech bubble: the agent's words for this step, under (or over) the target, and the person's buttons. */
function GuideBubble({ step, off, ring, first, root, dock, frozen, leaving, folded, onPeek, onAnswer, onSuggest, onRegenerate }: {
  step: GuideStepUi; off: "up" | "down" | null; ring: GuideRect | null; first: boolean;
  root: { current: HTMLDivElement | null }; dock: { current: HTMLDivElement | null };
  /** Stop reading the rect: the card stays where it is (clicked, navigated, or leaving). */
  frozen: boolean;
  leaving: boolean;
  /** The person is typing in the target: a dot stands in for the card. */
  folded: boolean;
  onPeek: (on: boolean) => void;
  onAnswer: (a: GuideAnswer) => void;
  onSuggest?: (replace: boolean) => Promise<SuggestResult>;
  onRegenerate?: (note: string) => boolean;
}) {
  const b = bubbleOf(step, first, off);
  const [n, finish] = useTyped(b.text);
  const box = useRef<HTMLDivElement | null>(null);
  const text = useRef<HTMLParagraphElement | null>(null);
  /* Placed from the target's rect every time it or the pane changes: never from stored pixels.
     Frozen once placed: a card the person answered, or one leaving, stays where they saw it. */
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = box.current, t = text.current, r = root.current;
    if (!el || !t || !r) return;
    if (frozen && placed.current) return;
    const place = () => {
      const pw = r.clientWidth, ph = r.clientHeight;
      /* Out of view: the bubble waits at the edge the element went past, so its arrow points the way to scroll. */
      const rect = !step.rect ? { x: pw / 2, y: 24, w: 0, h: 0 }
        : off === "down" ? { x: step.rect.x, y: ph, w: step.rect.w, h: 0 }
        : off === "up" ? { x: step.rect.x, y: 0, w: step.rect.w, h: 0 }
        : step.rect;
      const width = bubblePlace(rect, { w: pw, h: ph }, { h: 0 }).width;
      el.style.width = `${width}px`;
      t.style.maxHeight = "none";
      const textH = t.scrollHeight, chrome = el.offsetHeight - t.offsetHeight;
      const d = dock.current;
      /* The dock as it is placed for this ring (dockPlace), or at its CSS place; with no dock (a guide has
         none), the top pill (data-agx-overlay), so the card never runs under the island either. */
      const db = d ? dockBoxFor(ring, r, d) ?? { x: d.offsetLeft, y: d.offsetTop, w: d.offsetWidth, h: d.offsetHeight } : overlaysOver(r)[0];
      const p = bubblePlace(rect, { w: pw, h: ph, ...(db ? { dock: db } : {}) }, { h: textH }, chrome);
      t.style.maxHeight = `${p.maxText}px`;
      t.classList.toggle("is-clipped", p.scroll);
      for (const k of ["above", "left", "right"] as const) el.classList.toggle("is-" + k, p.side === k);
      el.classList.toggle("is-through", p.through);
      el.style.setProperty("--tail", `${p.tailY ?? p.tailX}px`);
      /* `translate`, not `transform`: the arrive and leave scale about the tail and add their own transform. */
      el.style.translate = `${p.left}px ${p.top}px`;
    };
    place();
    if (!placed.current) {
      placed.current = true;
      /* The first place is the anchor: no transition from anywhere. Only after it may the same step follow a scroll. */
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (!frozen) el.classList.add("is-settled"); });
      const m = cardMotion("arrive", calmNow());
      if (typeof el.animate === "function") el.animate(m.keyframes, m.options);
    }
    if (frozen) { el.classList.remove("is-settled"); return; }
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(r);
    return () => ro.disconnect();
  }, [step.rect?.x, step.rect?.y, step.rect?.w, step.rect?.h, off, !!ring, b.note, b.buttons.length, b.copy, b.suggest, b.summary, frozen]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The leave: in place, from where it is, pointer events off at once (CSS is-leaving). */
  useLayoutEffect(() => {
    const el = box.current;
    if (!leaving || !el || typeof el.animate !== "function") return;
    const m = cardMotion("leave", calmNow());
    el.animate(m.keyframes, m.options);
  }, [leaving]);
  const typing = n < b.text.length;
  /* Back on a wait-click step asks first (bubbleOf's confirmBack). Keyed per step, so it resets with the step. */
  const [asking, setAsking] = useState(false);
  const answer = (a: GuideAnswer) => {
    if (a === "back" && b.confirmBack && !asking) { setAsking(true); return; }
    setAsking(false); finish(); onAnswer(a);
  };
  return (
    <div ref={box} className={"agx-presence-bubble" + (leaving ? " is-leaving" : "") + (folded ? " is-folded" : "")} role="status" aria-live={leaving ? "off" : "polite"} aria-hidden={leaving || folded || undefined}
      onPointerEnter={() => onPeek(true)} onPointerLeave={() => onPeek(false)}>
      {b.label && <div className="agx-bubble-head">{b.label}</div>}
      {/* The untyped rest is laid out but unseen, so the bubble never grows under the reader. */}
      <p ref={text} className="agx-bubble-text" aria-label={b.text}>
        <span aria-hidden>{b.text.slice(0, n)}</span>{typing && <span className="agx-bubble-caret" aria-hidden />}<span aria-hidden style={{ opacity: 0 }}>{b.text.slice(n)}</span>
      </p>
      {b.note && !b.waiting && <p className="agx-bubble-note">{b.note}</p>}
      {b.summary && <GuideSummary text={b.summary} />}
      {b.copy && <GuideCopy text={b.copy} />}
      {b.suggest && <GuideSuggest text={b.suggest} filled={b.suggestFilled === true} {...(onSuggest ? { onInsert: onSuggest } : {})} {...(onRegenerate ? { onRegenerate } : {})} />}
      {asking ? (
        <div className="agx-bubble-foot">
          <span className="agx-bubble-wait">{GUIDE_LEAVE_ASK}</span>
          <button type="button" onClick={() => setAsking(false)}>Stay</button>
          <button type="button" className="is-ok" onClick={() => answer("back")}>{GUIDE_LEAVE_YES}</button>
        </div>
      ) : (
        <div className="agx-bubble-foot">
          {b.waiting ? <span className="agx-bubble-wait"><i />{b.note}</span> : <span className="agx-bubble-sp" />}
          {b.buttons.map((k) => (
            <button key={k} type="button" className={k === "ok" || k === "done" ? "is-ok" : ""} onClick={() => answer(k)}>{k === "ok" && b.okWord ? b.okWord : ANSWER_WORD[k]}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* The person's record of the guide: only their own steps, what they did and when. */
function GuideAudit({ guide, onResume, onGone }: { guide: TabGuide; onResume: () => void; onGone: () => void }) {
  const c = guideCard(guide);
  /* It fades on its own (GUIDE_AUDIT_MS), at once with reduced motion. The pointer on its foot holds it,
     so a Resume being reached for does not slide away. */
  const [fading, setFading] = useState(false);
  const [held, setHeld] = useState(false);
  /* The pointer left the card: it gets a fresh grace, not whatever was left of the 6 s (often 0). */
  const graced = useRef(false);
  /* Only the step list fades while Resume can still be used: a small card keeps Resume until it runs out. */
  const [small, setSmall] = useState(false);
  /* A run the person stopped can pick up where it ended, for 10 minutes, and only from their own click. */
  const [resumable, setResumable] = useState(() => guideResumable(guide, Date.now()));
  const fold = () => { if (auditAfterFade(guide, Date.now()) === "small") { setSmall(true); setFading(false); } else onGone(); };
  useEffect(() => {
    if (held || small) return;
    const left = auditLeft(guide, Date.now());
    if (left === undefined) return;
    const t = setTimeout(() => { if (calmNow()) fold(); else setFading(true); }, auditWait(left, graced.current));
    return () => clearTimeout(t);
  }, [guide.endedAt, held, small]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(fold, 300);
    return () => clearTimeout(t);
  }, [fading]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The small card goes when Resume runs out. */
  useEffect(() => { if (small && !resumable) onGone(); }, [small, resumable]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!guideResumable(guide, Date.now())) { setResumable(false); return; }
    const left = guide.resumeUntil! - Date.now();
    setResumable(left > 0);
    if (left <= 0) return;
    const t = setTimeout(() => setResumable(false), left);
    return () => clearTimeout(t);
  }, [guide.resumeUntil, guide.steps]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={"agx-presence-audit" + (fading ? (resumable ? " is-fading-list" : " is-fading") : "") + (small ? " is-small" : "") + (c.done ? " is-done" : "")} role="region" aria-label={c.title}>
      {/* The end reached: one green line for GUIDE_DONE_MS, then it fades by itself. No list, no Resume. */}
      <h3>{c.done && <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m3.5 8.5 3 3 6-7" /></svg>}{c.title}</h3>
      {!small && !c.done && (c.why ? <p className="agx-audit-why">{c.why}</p> : <p className="agx-audit-why">{c.rows.length} {c.rows.length === 1 ? "step" : "steps"}</p>)}
      {!small && !c.done && (
        <ol>
          {c.rows.map((r, i) => (
            <li key={i}><span className="agx-audit-k">{r.n}</span><span>{r.say}<span className="agx-audit-s">{r.did}</span></span><span className="agx-audit-t">{r.at}</span></li>
          ))}
        </ol>
      )}
      {resumable && <div className="agx-bubble-foot" onPointerEnter={() => { setHeld(true); setFading(false); }} onPointerLeave={() => { graced.current = true; setHeld(false); }}><span className="agx-bubble-sp" /><button type="button" className="is-ok" onClick={onResume}>Resume</button>{small && <button type="button" className="agx-audit-x" aria-label="Close" style={{ width: HIT, height: HIT }} onClick={onGone}><svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden><path d="m4 4 8 8M12 4l-8 8" /></svg></button>}</div>}
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
  const p = { width: ICON.sm, height: ICON.sm, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
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
    case "handoff": return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.6" /><circle cx="8" cy="11" r=".6" fill="currentColor" /></svg>;
    case "yours": return <svg {...p}><path d="M5.5 8V3.8a1.2 1.2 0 0 1 2.4 0V7m0-1.2a1.2 1.2 0 0 1 2.4 0V7.5m0-.7a1.2 1.2 0 0 1 2.4 0v2.7a4.5 4.5 0 0 1-4.5 4.5h-.4a4 4 0 0 1-3.2-1.6L2.8 10a1.2 1.2 0 0 1 1.9-1.4L5.5 9.6" /></svg>;
  }
}
