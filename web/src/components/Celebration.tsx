import { useEffect, useId, useRef } from "react";
import { Portal } from "./Portal.tsx";
import { FlightPlanIcon } from "./workspace/icons.tsx";
import { FlowIcon } from "./settingsNavIcons.tsx";
import { StarIcon } from "../lib/glyphIcons.tsx";
import "./celebration.css";

/**
 * The 1.0 moment: the first run of 1.0.0 shows this instead of the notes modal.
 *
 * Built from the approved mockup (variant A, the mark is the stage). The mark's
 * geometry is the one in Logo.tsx, copied rather than imported because the
 * choreography needs its parts (arcs, bands, terminator, contact) as separate
 * elements, and it wears the app icon's fixed paints, not the theme's. The only
 * addition is a ground ellipse built from the mark's own 12.5 : 4.5 proportion.
 *
 * One timeline of Web Animations, all created together from `playMoment`, so
 * Replay cancels and re-creates that one set and nothing else moves. No library.
 *
 * Reduced motion: no animation is created at all. Every element's resting
 * style is its final frame, so the page is already the finished composition.
 * Esc, the corner control and "Not now" close at any moment; closing cancels
 * the timeline.
 */

const EXPO = "cubic-bezier(.16,1,.3,1)";
const DRAW = "cubic-bezier(.22,.8,.24,1)";
const SPRING = "cubic-bezier(.2,1.25,.35,1)";
const SWEEP = "cubic-bezier(.4,0,.2,1)";

function playMoment(root: HTMLElement): Animation[] {
  const anims: Animation[] = [];
  const all = (sel: string) => [...root.querySelectorAll<HTMLElement | SVGElement>(sel)];
  const add = (sel: string, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
    for (const el of all(sel)) anims.push(el.animate(frames, { fill: "both", ...opts }));
  };
  const rise = (el: Element, delay: number, ease: string, dur: number) => {
    anims.push(el.animate([{ clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(-14% 0 0 0)" }], { fill: "both", duration: dur, delay, easing: EXPO }));
    const inner = el.querySelector("i");
    if (inner) anims.push(inner.animate([{ transform: "translateY(110%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], { fill: "both", duration: dur, delay, easing: ease }));
  };

  add(".ground", [{ opacity: 0, transform: "scaleX(.02)" }, { opacity: 1, transform: "scaleX(1)" }], { duration: 900, easing: EXPO });
  add(".arc.back", [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], { duration: 800, delay: 300, easing: DRAW });
  add(".world", [{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "scale(1)" }], { duration: 600, delay: 550, easing: EXPO });
  add(".terminator", [{ opacity: 0 }, { opacity: 0.42 }], { duration: 600, delay: 700, easing: "ease-out" });
  add(".band.eq", [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], { duration: 650, delay: 850, easing: DRAW });
  add(".band.mer", [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], { duration: 750, delay: 1050, easing: DRAW });
  add(".arc.front", [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], { duration: 650, delay: 1150, easing: DRAW });
  add(".halo", [{ opacity: 0, transform: "scale(.55)" }, { opacity: 1, transform: "scale(1)" }], { duration: 400, delay: 1500, easing: SPRING });
  add(".contact", [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1)" }], { duration: 400, delay: 1550, easing: SPRING });
  // A dashed stroke at offset 1 still paints its round cap: keep each line
  // hidden until its own draw begins, so the cap is the start of the stroke.
  for (const [sel, delay] of [[".arc.back", 300], [".band.eq", 850], [".band.mer", 1050], [".arc.front", 1150]] as const) {
    add(sel, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay, easing: "linear" });
  }
  add(".spec", [
    { transform: "translateX(-26px)", opacity: 0 },
    { transform: "translateX(10px)", opacity: 0.55, offset: 0.5 },
    { transform: "translateX(72px)", opacity: 0 },
  ], { duration: 800, delay: 1600, easing: SWEEP });
  // 2.0 s: it lifts, the shadow breathes the other way. The only loop.
  add(".float", [{ transform: "translateY(0)" }, { transform: "translateY(-6px)" }],
    { duration: 3200, delay: 2000, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });
  add(".ground-g", [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(.94)", opacity: 0.55 }],
    { duration: 3200, delay: 2000, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });

  all(".cel-numeral .ch").forEach((ch, i) => rise(ch, 2200 + i * 40, SPRING, 550));
  all(".cel-h1 .line").forEach((line, i) => rise(line, 2350 + i * 70, EXPO, 600));

  add(".cel-eyebrow", [{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 2100, easing: "ease-out" });
  add(".cel-lede", [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 500, delay: 2500, easing: EXPO });
  add(".cel-row3", [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: 2600, easing: "linear" });
  all(".cel-row3 li").forEach((li, i) => {
    anims.push(li.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }],
      { fill: "both", duration: 450, delay: 2600 + i * 60, easing: EXPO }));
  });
  add(".cel-caption", [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 3400, easing: "ease-out" });
  add(".cel-foot", [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 3500, easing: "ease-out" });
  add(".cel-go", [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "scale(1)" }], { duration: 400, delay: 3250, easing: SPRING });
  add(".cel-later", [{ opacity: 0 }, { opacity: 1 }], { duration: 350, delay: 3320, easing: "ease-out" });
  // 4.5 s: one slow sheen across the world, every 8 s, once it has settled.
  add(".sheen", [
    { transform: "translateX(-26px)", opacity: 0, offset: 0 },
    { transform: "translateX(-26px)", opacity: 0, offset: 0.01 },
    { transform: "translateX(16px)", opacity: 0.42, offset: 0.09 },
    { transform: "translateX(72px)", opacity: 0, offset: 0.18 },
    { transform: "translateX(72px)", opacity: 0, offset: 1 },
  ], { duration: 8000, delay: 4500, iterations: Infinity, easing: "linear" });
  return anims;
}

function reducedMotion(): boolean {
  return document.documentElement.hasAttribute("data-reduce-motion")
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Celebration({ onClose, onOpen }: { onClose: () => void; onOpen: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const anims = useRef<Animation[]>([]);
  const uid = useId().replace(/:/g, "");
  const goRef = useRef<HTMLButtonElement>(null);

  const play = () => {
    for (const a of anims.current) a.cancel();
    anims.current = [];
    if (root.current && !reducedMotion()) anims.current = playMoment(root.current);
  };

  useEffect(() => {
    play();
    goRef.current?.focus();
    // Captured, so Escape closes the moment and not whatever is under it.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      for (const a of anims.current) a.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Portal z={10011}>
      <div ref={root} className="cel" role="dialog" aria-modal="true" aria-label="Welcome to agentglass 1.0">
        <div className="cel-controls">
          <button className="cel-replay" onClick={play} title="Play the moment again">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.6V5h-2.4" /></svg>
            Replay
          </button>
          <button className="cel-close" onClick={onClose} aria-label="Close this welcome">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </button>
        </div>

        <div className="cel-sheet">
          <div className="cel-copy">
            <p className="cel-eyebrow"><b>agentglass</b> 1.0</p>
            <div className="cel-numeral" role="img" aria-label="Version 1.0">
              <span className="ch" aria-hidden="true"><i>1</i></span><span className="ch dot" aria-hidden="true"><i><span className="dotmark" /></i></span><span className="ch" aria-hidden="true"><i>0</i></span>
            </div>
            <h1 className="cel-h1">
              <span className="line"><i>Built to fix a problem of mine.</i></span>
              <span className="line"><i>Shared in case it fixes yours too.</i></span>
            </h1>
            <p className="cel-lede">agentglass began as a tool I needed for my own work with coding agents. I am sharing it in case it is useful to you.</p>

            <ul className="cel-row3">
              <li>
                <span className="tile" aria-hidden="true"><FlowIcon size={17} /></span>
                <span><b>Orchestrator</b><span>One agent in the chair runs the team: it plans, builds and checks by your rules, and asks you only when it must.</span></span>
              </li>
              <li>
                <span className="tile" aria-hidden="true"><FlightPlanIcon size={17} /></span>
                <span><b>Flight plan</b><span>A request becomes a plan. You read it cold, answer every finding, and say Go once.</span></span>
              </li>
              <li>
                <span className="tile" aria-hidden="true"><StarIcon size={17} /></span>
                <span><b>Polaris</b><span>Your open pull requests in plain words, with one next step. It never merges.</span></span>
              </li>
            </ul>

            <div className="cel-acts">
              <button ref={goRef} className="cel-go" onClick={onOpen}>Open the terminal
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" /></svg>
              </button>
              <button className="cel-later" onClick={onClose}>Not now</button>
            </div>
          </div>

          <figure className="cel-art">
            <div className="cel-stage">
              <svg className="mark" viewBox="0 0 64 64" role="img" aria-label="agentglass: a shaded world, its orbit and one live contact">
                <defs>
                  <radialGradient id={`${uid}-sheen`} cx=".34" cy=".28" r=".82">
                    <stop offset="0" stopColor="#fff" stopOpacity=".72" />
                    <stop offset=".5" stopColor="#fff" stopOpacity=".15" />
                    <stop offset="1" stopColor="#fff" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id={`${uid}-ground`} cx=".5" cy=".5" r=".5">
                    <stop offset="0" stopColor="var(--cel-shadow-ink)" stopOpacity=".3" />
                    <stop offset=".55" stopColor="var(--cel-shadow-ink)" stopOpacity=".12" />
                    <stop offset="1" stopColor="var(--cel-shadow-ink)" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id={`${uid}-sweep`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#fff" stopOpacity="0" />
                    <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
                    <stop offset="1" stopColor="#fff" stopOpacity="0" />
                  </linearGradient>
                  <clipPath id={`${uid}-disc`}><circle cx="30" cy="34" r="12.5" /></clipPath>
                </defs>
                <g className="ground-g"><ellipse className="ground" cx="30" cy="56.6" rx="18.5" ry="4.1" fill={`url(#${uid}-ground)`} /></g>
                <g className="float">
                  <path className="arc back" pathLength="1" d="M14.1 54.9 A29 8 -52 0 1 49.9 9.1" />
                  <g className="world">
                    <circle className="disc" cx="30" cy="34" r="12.5" fill="var(--cel-mark)" />
                    <circle cx="30" cy="34" r="12.5" fill={`url(#${uid}-sheen)`} />
                    <ellipse className="band eq" pathLength="1" cx="30" cy="34" rx="12.5" ry="4.5" />
                    <ellipse className="band mer" pathLength="1" cx="30" cy="34" rx="6" ry="12.1" />
                    <path className="terminator" d="M30 21.5 A12.5 12.5 0 0 1 30 46.5 A17.0 17.0 0 0 0 30 21.5 Z" />
                  </g>
                  <g clipPath={`url(#${uid}-disc)`}>
                    <g transform="rotate(-18 30 34)">
                      <rect className="sweep spec" x="-26" y="8" width="19" height="52" fill={`url(#${uid}-sweep)`} />
                      <rect className="sweep sheen" x="-30" y="8" width="26" height="52" fill={`url(#${uid}-sweep)`} />
                    </g>
                  </g>
                  <path className="arc front" pathLength="1" d="M49.9 9.1 A29 8 -52 0 1 14.1 54.9" />
                  <circle className="halo" cx="50.8" cy="10.7" r="6.8" />
                  <circle className="contact" cx="50.8" cy="10.7" r="3.6" />
                </g>
              </svg>
            </div>
            <figcaption className="cel-caption"><span>18 July 2026</span><span>5,285 commits</span><span>1 November 2026</span></figcaption>
          </figure>
        </div>

        <p className="cel-foot">5,285 commits <i /> one window <i /> on your machine</p>
      </div>
    </Portal>
  );
}
