import type { CSSProperties, ReactNode } from "react";
import { STATIONS, type Station } from "../../lib/flightPlan.ts";
import type { Station as PilotStation, StateBadge } from "../../lib/flightPilot.ts";
import { ICON } from "../../lib/iconSize.ts";
import { LivingMark } from "../Logo.tsx";
import { BellIcon, ClockIcon, LockIcon, PauseIcon, StopIcon, TickIcon } from "./fpIcons.tsx";

/**
 * The trajectory as an orrery: the eleven stations of a plan's whole life (Request to Launch, then Building to
 * Landed) are planets on one tilted orbit, and the orbit turns so the station the plan is at is always at the front,
 * largest and lit. What is done recedes to the left and behind; what is ahead waits on the right. One empty step at
 * the back is the seam between Landed and Request.
 *
 * Nothing is an SVG stretched to the box. Every body is placed by its angle in CSS: `translate` from `cos()` and
 * `sin()` of `--ang` (a registered `<angle>`), the orbit's width in `cqw` and its tilt in px, so a wide window spreads
 * the stations and the type stays 12 px. A change of station only changes `--ang`, and the transition on it swings the
 * orbit round with transforms alone; a second change mid-swing simply retargets it.
 *
 * Paused, Stopped, Held, Queued, Quiet and Refused are not planets: they are a variant of the current one.
 */
const FLY = ["Building", "Checking", "Ready to land", "Landed"] as const;
const ALL = [...STATIONS, ...FLY];
const N = ALL.length;
const STEP = 360 / (N + 1);
type Halt = "paused" | "stopped" | "held" | "queued" | "quiet";
/** Where the flight is, from the pilot's state badge and the build's k of n steps. */
export type FlightInfo = { state: StateBadge; steps: { k: number; n: number } | null };

function flightOf(f: FlightInfo | undefined): { fly: Station[]; halt?: Halt } {
  const built = !!f?.steps && f.steps.k >= f.steps.n;
  switch (f?.state.id) {
    case "landed": return { fly: ["done", "done", "done", "done"] };
    case "ready": return { fly: ["done", "done", "cur", "todo"] };
    case "checking": return { fly: ["done", "cur", "todo", "todo"] };
    case "building": return { fly: ["cur", "todo", "todo", "todo"] };
    case "quiet": case "paused": case "stopped": return { fly: ["cur", "todo", "todo", "todo"], halt: f.state.id };
    case "refused": return { fly: built ? ["done", "done", "cur", "todo"] : ["cur", "todo", "todo", "todo"], halt: "stopped" };
    case "queued": case "held": return { fly: ["todo", "todo", "todo", "todo"], halt: f.state.id };
    default: return { fly: ["todo", "todo", "todo", "todo"] };
  }
}

const GLYPH: Record<Halt, (p: { size?: number }) => ReactNode> = { paused: PauseIcon, stopped: StopIcon, held: LockIcon, queued: ClockIcon, quiet: BellIcon };
const on = (a: number, extra?: Record<string, string>): CSSProperties => ({ ["--ang" as string]: `${a.toFixed(2)}deg`, ...extra });
/** Front, edge or back of the orbit: where the label goes, and whether there is room for it on a narrow strip. */
const side = (a: number) => { const s = Math.sin((a * Math.PI) / 180); return s > 0.35 ? "front" : s < -0.2 ? "back" : "edge"; };

export function Trajectory({ states, subs, flight, bare = false }: {
  states: Station[]; subs?: string[];
  /** Where the flight is once Go is given; without it the flight stations wait ahead. */
  flight?: FlightInfo;
  /** No labels: the empty state's faint orbit. */ bare?: boolean;
}) {
  const { fly, halt } = flightOf(flight);
  const all = [...states, ...fly];
  const steps = flight?.steps ?? null;
  const word = flight?.state.word;
  const allSubs = ALL.map((_, i) => {
    const s = all[i]!;
    if (s === "skip") return "not needed";
    if (i < STATIONS.length) return s === "cur" && halt ? word ?? "" : subs?.[i] ?? "";
    const k = i === STATIONS.length && steps ? `${s === "done" ? steps.n : steps.k} of ${steps.n} steps` : "";
    if (s === "cur") return halt ? [word, k].filter(Boolean).join(" · ") : k || flight?.state.sub || "";
    if (s === "done") return k || (i === N - 1 ? flight?.state.sub ?? "" : "");
    return "";
  });
  const cur = all.indexOf("cur");
  const landed = all[N - 1] === "done";
  const focus = bare ? 0 : cur >= 0 ? cur : landed ? N - 1 : Math.max(all.lastIndexOf("done"), 0);
  const ang = (i: number) => 90 + (focus - i) * STEP;
  const endA = ang(focus) + STEP * 0.3;
  /* The flown path: a dot every quarter step from Request to the mark; the last stretch is its trail. */
  const dots: number[] = [];
  if (!bare && (cur >= 0 || landed)) for (let a = ang(0); a >= (landed ? ang(N - 1) : endA); a -= STEP / 4) dots.push(a);
  /* One sweep of signals along the flown path when the station changes (keyed on focus, so they remount); animating --ang is main-thread work, so it never loops. */
  const from = ang(0) + STEP * 0.1, to = ang(focus) + STEP * 0.12;
  const sig = !bare && cur >= 0 && !halt ? { from, to } : null;
  const label = `Trajectory: ${ALL.map((s, i) => `${s} ${all[i]}`).join(", ")}${halt && word ? `; ${word}` : ""}`;
  return (
    <div className="fp-traj" data-bare={bare || undefined} role="img" aria-label={label}>
      <div className="sky">
        <span className="orbit halo" />
        <span className="orbit" />
        <span className="orbit front" />
        <span className="sun" />
        {dots.map((a) => <span key={a} className="on" style={on(a)}><span className="dot" data-tail={!landed && !halt && a - endA < STEP * 0.9 ? "" : undefined} /></span>)}
        {sig && [0, 1, 2].map((k) => <span key={`${focus}-${k}`} className="on sig" aria-hidden="true" style={on(sig.from, { "--from": `${sig.from.toFixed(2)}deg`, "--to": `${sig.to.toFixed(2)}deg`, "--i": `${k}` })}><b /></span>)}
        {ALL.map((name, i) => {
          const st = all[i]!;
          const h = st === "cur" ? halt : undefined;
          const Glyph = h ? GLYPH[h] : st === "done" ? TickIcon : null;
          /* The current station, and Landed once landed, is the agentglass mark itself. */
          const mark = st === "cur" || (landed && i === N - 1);
          const ring = name === "Building" && steps && steps.n <= 24 && (st === "cur" || st === "done") ? steps : null;
          const sub = allSubs[i];
          return (
            <div key={name} className={`on stn${i === N - 1 ? " dest" : ""}${mark ? " mark" : ""}`} data-st={st} data-halt={h} data-side={side(ang(i))}
              style={on(ang(i), { "--s0": `${(mark ? 64 : st === "skip" ? 16 : 22) + (ring ? 6 : 0)}px` })}>
              {ring && (
                <span className="moons">
                  {Array.from({ length: ring.n }, (_, j) => <i key={j} style={{ ["--m" as string]: `${-90 + (j * 360) / ring.n}deg` }} data-on={j < ring.k || st === "done" || undefined} data-next={st === "cur" && j === ring.k ? "" : undefined} />)}
                </span>
              )}
              <span className="pl">
                {mark ? <><LivingMark size={94} className="mk" style={{ color: "inherit" }} title="" />{h && Glyph && <span className="hg"><Glyph size={ICON.xs} /></span>}</> : Glyph && <Glyph size={ICON.xs} />}
              </span>
              {!bare && (
                <span className="cap">
                  <span className="lbl">{name}</span>
                  {sub && <span className="sub">{sub}</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What each station is, for a reader who cannot see the colours. */
export function trackLabel(stations: PilotStation[]): string {
  const who = (a: PilotStation["actor"]) => (a === "person" ? "you" : a === "coordinator" ? "orchestrator" : a);
  return stations.map((s) => {
    const name = s.ask ? "Question" : s.id[0]!.toUpperCase() + s.id.slice(1);
    return s.state === "done" ? `${name} done by ${who(s.actor)}`
      : s.state === "skipped" ? `${name} skipped`
      : s.state === "waiting" ? `${name} waiting on you`
      : s.state === "current" ? `${name} in progress, ${who(s.actor)}`
      : `${name} not yet`;
  }).join(", ");
}

/**
 * The six stations of a flight in a row: one bar each, coloured by who did it
 * (the Settings tab's four hues), and what the bar says is also in its shape:
 * solid is done, striped is in progress, dashed is waiting on the person, a dotted
 * dash is skipped. The labels say the rest, and the list has a text alternative.
 */
export function Track({ stations }: { stations: PilotStation[] }) {
  return (
    <ol className="pv-track" role="img" aria-label={trackLabel(stations)}>
      {stations.map((s) => (
        <li key={s.id} className="pv-st" data-state={s.state} data-actor={s.actor ?? undefined} data-ask={s.ask ? "" : undefined} aria-hidden="true">
          <i /><span>{s.state === "skipped" ? "—" : s.ask ? "ask" : s.id}</span>
        </li>
      ))}
    </ol>
  );
}
