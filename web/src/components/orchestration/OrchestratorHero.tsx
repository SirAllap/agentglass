import type { CSSProperties, ReactNode } from "react";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { PAGE_BTN, PAGE_BTN_SM } from "./OrchKit.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { FlowIcon } from "./flow/flowIcons.tsx";
import { engineName } from "./flow/flowScreenCopy.ts";
import { engineLetter } from "./orchestrationCopy.ts";

/**
 * The top of the page, as the approved mockup draws it: who the orchestrator
 * is, the path as one row of discs, and three numbers about now.
 *
 * Every number is a prop. A reading the page does not have is a sentence
 * ("Not read yet", "Not connected"), never a dash that reads as a measurement
 * of zero; and the line under Today names the block that settled and when,
 * never the words a worker wrote (that is its own message, not a setting).
 */
export interface HeroPathStep {
  id: string;
  name: string;
  /** A token name; a step with no colour of its own reads `var(--<hue>)`. */
  hue: string;
  /** A name from `flowIcons`. */
  ico: string;
  /** The engine the policy gives this step; "" when it has none. */
  engine: string;
  run: number;
  wait: number;
  /** A person answers here: nothing runs. */
  you?: boolean;
}

/** What the three cards say, or null for a number nothing has read. */
export interface HeroReadout {
  plan: { label: string; used: number | null; /** Where a rule moves work: percent used. */ mark: number | null };
  /** Workers flying now, and the most the policy allows at once. */
  flight: { n: number; of: number } | null;
  /** What today has cost, in the budget views' words. */
  today: string | null;
  /** The block that settled last, by its flow name, and when. Never its message. */
  last: { name: string; at: number } | null;
}

/**
 * The five blocks of the path keep the mockup's own colours, by role id. The
 * flow's hues name a stage family (all of development one colour); the mockup
 * gives each block on the path a colour of its own, so a disc reads as that
 * block at a glance. A role the mockup does not draw keeps its stage's hue.
 */
/**
 * The approved mockup's own constants, in one place: the app's themes are
 * monochrome and none of these has a token. The accent and the peach wash go on
 * the page as custom properties; a chip carries its colour inline.
 */
export const MOCKUP_INK = {
  accent: "#c4552d",
  /** The hero's peach, mixed with the surface so a dark theme gets a deep one. */
  heroTint: "#f6dccf",
  /** The engine chips: Claude clay, OpenCode green, Codex navy, you purple. */
  engine: { C: "#cc785c", O: "#2f7d4f", X: "#3b4a6b", Y: "#6b6fd6" } as Record<string, string>,
};

const ROLE_COLOUR: Record<string, string> = {
  planner: "#c98a7a",
  builder: "#4aa08f",
  inspector: "#d4a73a",
  verifier: "#4cb06f",
  landing: "#6b6fd6",
};

export const stepColour = (id: string, hue: string): string => ROLE_COLOUR[id] ?? `var(--${hue})`;

const DASH = "\u2014";

/** The mockup's `.btn`: the page's own ground with an edge, never the kit's grey fill. */
const HERO_BTN: CSSProperties = { ...PAGE_BTN, background: "var(--surface-page)", border: EDGE };
/** The mockup's `.btn.sm`: Configure is the hero's small action, Conditions the full one. */
const HERO_BTN_SM: CSSProperties = { ...PAGE_BTN_SM, background: "var(--surface-page)", border: EDGE };

/** "12 m ago", or "" for a stamp the clock cannot place. */
export function agoWords(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (!at) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} m ago`;
  if (s < 24 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / (24 * 3600))} d ago`;
}

/** The one line under a step's name: running, waiting on a person, or idle. */
export function stepLine(s: Pick<HeroPathStep, "run" | "wait" | "you">): string {
  if (s.you) return s.wait > 0 ? `${s.wait} waiting for you` : "Idle";
  if (s.run > 0) return `${s.run} running${s.wait > 0 ? ` \u00b7 ${s.wait} waiting for you` : ""}`;
  if (s.wait > 0) return `${s.wait} waiting for you`;
  return "Idle";
}

/** The engine's letter in its own colour: the mockup's chip (C clay, O green, X navy). */
export function EngineChip({ engine }: { engine: string }) {
  const letter = engineLetter(engine);
  const ink = MOCKUP_INK.engine[letter];
  return <span aria-hidden className="agx-flow-eg" data-engine={letter} style={ink ? ({ "--eg": ink } as CSSProperties) : undefined}>{letter}</span>;
}

/** What a card says when the page has no reading of it: a sentence, never a dash. */
const NOT_READ = "Not read yet";
const NOT_CONNECTED = "Not connected";

export function OrchestratorHero(p: {
  /** The engine and model the policy gives the orchestrator; null while it names nobody. */
  chair: { engine: string; model: string } | null;
  /** "Co-pilot", or "" before the pilot setting has answered. */
  mode: string;
  path: readonly HeroPathStep[];
  live: HeroReadout;
  /** How many rules are switched on, or null before the policy is read. */
  conditionsOn: number | null;
  now?: number;
  /** Whether the presets sheet under the hero is open. */
  presetsOpen?: boolean;
  onOpenPresets?: () => void;
  onConfigure: () => void;
  onOpenConditions: () => void;
  onOpenFlow: () => void;
  /** Drawn under the readouts: the page's own lead row, when it has one. */
  children?: ReactNode;
}) {
  const { live } = p;
  const flight = live.flight;
  const used = live.plan.used;
  const ago = live.last ? agoWords(live.last.at, p.now ?? Date.now()) : "";
  const fill = flight && flight.of > 0 ? Math.min(100, Math.round((flight.n / flight.of) * 100)) : 0;
  return (
    <section className="agx-flow-hero" aria-label="The orchestrator" data-hero style={{ "--hero-tint": MOCKUP_INK.heroTint } as CSSProperties}>
      <div className="agx-flow-hero-top">
        <span aria-hidden className="agx-flow-hero-hub"><FlowIcon name="hub" size={ICON.rail} /></span>
        <div className="agx-flow-hero-who">
          <b>Orchestrator</b>
          <span className="agx-flow-hero-engine">
            {p.chair?.engine ? (
              <>
                <EngineChip engine={p.chair.engine} />
                {engineName(p.chair.engine)}{" \u00b7 "}<code>{p.chair.model || "its default"}</code>
              </>
            ) : DASH}
          </span>
        </div>
        {p.mode ? <span className="agx-flow-hero-mode">{p.mode}</span> : null}
        <span className="agx-flow-inf" tabIndex={0} role="note"
          data-tip="The orchestrator sends each task through these blocks and skips the ones it does not need. It follows the flow as a guide: only blocks marked required must run.">i</span>
        {p.onOpenPresets && (
          <button type="button" className="agx-flow-hero-chip" aria-expanded={!!p.presetsOpen} data-presets-chip onClick={p.onOpenPresets}>Presets</button>
        )}
        <Button style={HERO_BTN_SM} onClick={p.onConfigure}>
          <FlowIcon name="gear" size={ICON.sm} />Configure
        </Button>
      </div>

      {p.path.length > 0 ? (
        <ol className="agx-flow-hero-orbit" aria-label="The path" style={{ "--n": String(p.path.length) } as CSSProperties}>
          {p.path.map((step) => {
            const n = step.run + step.wait;
            return (
              <li key={step.id} className="agx-flow-hero-node" data-step={step.id} data-run={step.run > 0 ? "" : undefined}
                style={{ "--c": stepColour(step.id, step.hue) } as CSSProperties}>
                <span aria-hidden className="agx-flow-hero-disc">
                  <FlowIcon name={step.ico} size={ICON.rail} />
                  {n > 0 ? <em className="agx-flow-hero-n" data-n={String(n)}>{`\u00d7${n}`}</em> : null}
                </span>
                <b>{step.name}</b>
                <span className="agx-flow-hero-eng">
                  {step.you
                    ? <><FlowIcon name="hand" size={ICON.xs} />You</>
                    : step.engine ? <><EngineChip engine={step.engine} />{engineName(step.engine)}</>
                    : DASH}
                </span>
                <span className="agx-flow-hero-st" data-run={step.run > 0 ? "" : undefined}>{stepLine(step)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="agx-flow-hero-empty">No flow yet: the path appears here once this project has one.</p>
      )}

      <div className="agx-flow-hero-foot">
        <dl className="agx-flow-hero-readouts">
          <div data-readout="plan-used">
            <dt>{live.plan.label}</dt>
            {used === null
              ? <dd className="agx-flow-hero-off">{NOT_CONNECTED}</dd>
              : <dd>{`${used}%`}</dd>}
            {used !== null && (
              <span aria-hidden className="agx-flow-hero-meter">
                <i style={{ width: `${used}%` }} />
                {live.plan.mark !== null && <u style={{ left: `${live.plan.mark}%` }} />}
              </span>
            )}
          </div>
          <div data-readout="workers">
            <dt>Workers in flight</dt>
            {flight
              ? <dd>{flight.n} <span className="agx-flow-hero-sub">of {flight.of} at once</span></dd>
              : <dd className="agx-flow-hero-off">{NOT_READ}</dd>}
            {flight && <span aria-hidden className="agx-flow-hero-meter"><i style={{ width: `${fill}%` }} /></span>}
          </div>
          <div data-readout="today">
            <dt>Today</dt>
            <dd>{live.today ?? NOT_READ}</dd>
            <span className="agx-flow-hero-note">
              {live.last
                ? <><FlowIcon name="loop" size={ICON.xs} />{live.last.name}{ago ? ` \u00b7 ${ago}` : ""}</>
                : "No block has settled yet"}
            </span>
          </div>
        </dl>
        <div className="agx-flow-hero-actions">
          <Button style={HERO_BTN} onClick={p.onOpenConditions}>{`Conditions \u00b7 ${p.conditionsOn ?? DASH} on`}</Button>
          <button type="button" className="agx-flow-hero-cta" onClick={p.onOpenFlow}>
            <FlowIcon name="hub" size={ICON.lg} />
            <span>Open the Flow editor</span>
            <em aria-hidden>{"\u2192"}</em>
          </button>
        </div>
      </div>
      {p.children}
    </section>
  );
}
