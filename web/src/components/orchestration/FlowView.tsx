import { useId, type KeyboardEvent, type ReactNode } from "react";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PanesIcon } from "../settingsNavIcons.tsx";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import { ROLE_IDS, type Policy, type PolicyRule } from "../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { JOB_ORDER, engineTileState, flowBecause, flowNodes, roleWord, scopeWords, tileModel, type Field, type FlowNode } from "./orchestrationCopy.ts";

/**
 * "Right now": who does each job at this moment, as a drawn diagram. You, the
 * main agent, the three jobs, a dashed fallback and the gate that holds what
 * leaves the machine, joined by the lines a task takes.
 *
 * It is drawn from what the page holds (the policy, the rules' reading, the
 * engines' probe and whether the gate is on) and makes no request. Every colour
 * is a theme token, so the picture follows the theme. Each job is a button: it
 * opens that job's details on the left. "Drawn, not a capture": nothing here is
 * read from a running agent, so it says what the policy decides, not what a pane
 * is doing this second.
 *
 * Its ceilings, stated: one fallback is drawn (the first usage rule), and the
 * gate node is on or off, not a log of what it held.
 */
export interface FlowViewProps {
  policy: Policy;
  facts: { on(ruleId: string): boolean };
  readiness: readonly EngineReadiness[] | null;
  /** The scope the picture is for: a project's folder, or "" for every project. */
  root: string;
  /** The model the open main agent really runs, when one is open. */
  liveModel: string | null;
  disabled: boolean;
  /** Engines whose plan has nothing left. */
  limited?: ReadonlySet<string>;
  /** The gate's real switch; null before it has answered. */
  gate?: { on: boolean; bundled: boolean } | null;
  onChange: (field: Field) => void;
  /** Scrolls to the ready-made setups; offered while nothing has been set up. */
  onPickSetup?: () => void;
}

/** Before the probe answers there is nothing to resolve: show the chains the policy holds, unjudged. */
function plainNodes(policy: Policy): FlowNode[] {
  return (["orchestrator", ...ROLE_IDS] as Field[]).map((f) => ({
    field: f, word: roleWord(f), ok: true, because: "", sentence: "", ruleId: null,
    chain: f === "orchestrator" ? policy.base.orchestrator.value : policy.base.workers[f].value,
  }));
}

const HUE: Record<Field, string> = {
  orchestrator: "var(--g-agents)", scout: "var(--g-connections)", builder: "var(--g-workspace)", verifier: "var(--g-general)", reviewer: "var(--g-library)",
};
const NAME: Record<Field, string> = { orchestrator: "Orchestrator", scout: "Scout", builder: "Builder", verifier: "Verifier", reviewer: "Reviewer" };
const TONE: Record<"ok" | "warn" | "err" | "checking", string> = { ok: "var(--success)", warn: "var(--warning)", err: "var(--error)", checking: "var(--text4)" };
const MONO = "var(--font-mono, ui-monospace, monospace)";

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const engineName = (id: string): string => agentProvider(id)?.title ?? id;

/** The first rule that watches a plan: the one the fallback node stands for. */
export const fallbackRule = (policy: Policy): PolicyRule | undefined =>
  policy.rules.find((r) => r.when.some((t) => t.kind === "usage"));

interface Box { x: number; y: number; w: number; h: number }

function Node({ box, hue, name, sub, state, dashed, muted, fill, label, onPress, clipId }: {
  box: Box; hue: string; name: string; sub: string; state?: { word: string; tone: keyof typeof TONE } | null;
  dashed?: boolean; muted?: boolean; fill?: string; label?: string; onPress?: () => void; clipId: string;
}) {
  const press = onPress ? {
    role: "button" as const, tabIndex: 0, "aria-label": label, onClick: onPress, style: { cursor: "pointer" },
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPress(); } },
  } : {};
  return (
    <g {...press} className={onPress ? "agx-orch-node agx-orch-node-btn" : "agx-orch-node"} opacity={muted ? 0.62 : 1}>
      <clipPath id={clipId}><rect x={box.x} y={box.y} width={box.w} height={box.h} rx={9} /></clipPath>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={9} style={{ fill: fill ?? "var(--surface-card)", stroke: "var(--border2)" }}
        strokeWidth={1} strokeDasharray={dashed ? "5 4" : undefined} />
      <rect x={box.x} y={box.y} width={5} height={box.h} clipPath={`url(#${clipId})`} style={{ fill: hue }} />
      <text x={box.x + 18} y={box.y + 24} fontSize={14.5} fontWeight={700} style={{ fill: "var(--text)" }}>{name}</text>
      <text x={box.x + 18} y={box.y + 42} fontSize={12} style={{ fill: "var(--text3)", fontFamily: MONO }}>{clip(sub, Math.floor((box.w - 32) / 7.2))}</text>
      {state?.word && <text x={box.x + 18} y={box.y + 58} fontSize={11.5} fontWeight={600} style={{ fill: TONE[state.tone] === "var(--success)" ? "var(--success-ink)" : TONE[state.tone] }}>{state.word}</text>}
      {state && <circle cx={box.x + box.w - 14} cy={box.y + 14} r={4} style={{ fill: TONE[state.tone] }} />}
    </g>
  );
}

/** A line with an arrowhead at its end. */
function Wire({ d, dashed, hot, head }: { d: string; dashed?: boolean; hot?: boolean; head: string }) {
  return <path d={d} fill="none" strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} markerEnd={`url(#${head})`}
    style={{ stroke: hot ? "var(--warning)" : "var(--text3)" }} />;
}

export function FlowView(p: FlowViewProps) {
  const uid = useId().replace(/\W/g, "");
  const nodes = p.readiness ? flowNodes(p.policy, p.facts, p.readiness) : plainNodes(p.policy);
  const main = nodes[0]!;
  const jobs = nodes.slice(1);
  const plain = !nodes.some((n) => n.ruleId);
  const head = `${uid}h`;

  const sub = (n: FlowNode): string => {
    const first = n.chain[0];
    if (!first) return "No engine";
    const role = n.field === "orchestrator" ? "orchestrator" as const : "worker" as const;
    if (n.chain.length > 1) return n.chain.map((c) => engineName(c.engine)).join(" → ");
    const model = n.field === "orchestrator" && p.liveModel ? p.liveModel : tileModel(first.engine, role, first.model).replace("default model", "default");
    return `${engineName(first.engine)} · ${model}`;
  };
  const state = (n: FlowNode) => {
    const first = n.chain[0];
    if (!first || !p.readiness) return null;
    const role = n.field === "orchestrator" ? "orchestrator" as const : "worker" as const;
    const s = engineTileState(first.engine, role, p.readiness, !!p.limited?.has(first.engine), first.model);
    return s.tone === "ok" ? { word: "", tone: "ok" as const } : { word: s.word, tone: s.tone };
  };
  // A ready engine draws its dot and no word: the legend is the colour, and a word is only said when something is wrong.
  const stateOf = (n: FlowNode) => {
    const s = state(n);
    return s && (s.tone === "ok" && !n.ok ? { word: "Not ready", tone: "err" as const } : s);
  };

  const rule = fallbackRule(p.policy);
  const usage = rule?.when.find((t) => t.kind === "usage");
  const holds = !!rule && rule.enabled && p.facts.on(rule.id);
  const moved = rule ? (ROLE_IDS.filter((r) => rule.workers?.[r]).map((r) => roleWord(r)).join(", ") || (rule.orchestrator ? "main agent" : "")) : "";
  const fbChain = rule ? (rule.workers?.builder ?? ROLE_IDS.map((r) => rule.workers?.[r]).find(Boolean) ?? rule.orchestrator) : undefined;
  const fbEngine = fbChain?.[0]?.engine;
  const trig = usage && usage.kind === "usage" ? `≤ ${usage.remainingAtMost} % left` : "";

  const gate = p.gate ?? null;
  const gateOn = !!gate && gate.bundled && gate.on;
  const gateWord = !gate ? "Checking" : !gate.bundled ? "Not in this build" : gate.on ? "push · PR · comment · merge → asks you" : "Off · nothing outward is held";

  const B: Record<string, Box> = {
    you: { x: 305, y: 6, w: 190, h: 54 },
    orch: { x: 265, y: 96, w: 270, h: 68 },
    builder: { x: 10, y: 224, w: 186, h: 68 },
    reviewer: { x: 208, y: 224, w: 186, h: 68 },
    verifier: { x: 406, y: 224, w: 186, h: 68 },
    scout: { x: 604, y: 224, w: 186, h: 68 },
    fb: { x: 560, y: 332, w: 200, h: 68 },
    gate: { x: 340, y: 428, w: 400, h: 58 },
  };
  const cx = (b: Box) => b.x + b.w / 2;
  const job = (f: Exclude<Field, "orchestrator">) => jobs.find((n) => n.field === f)!;
  const press = (f: Field) => () => { if (!p.disabled) p.onChange(f); };

  const notOk = nodes.filter((n) => !n.ok);
  const line = (children: ReactNode, key: string) => <p key={key} className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>{children}</p>;
  return (
    <section data-flow="right-now" aria-label="Who does what right now">
      <SettingsCard title="Flow" icon={<PanesIcon size={ICON.sm} />}
        status={<StatusBadge tone="info">Drawn, not a capture</StatusBadge>}
        desc={`Right now for ${scopeWords(p.root)}. A job opens its details on the left.`}>
        <div className="agx-orch-flow">
          <svg viewBox="0 0 800 500" role="img" aria-label="You, the main agent, its jobs, the fallback and the gate" className="agx-orch-flow-svg">
            <defs>
              <marker id={head} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0 1 L9 5 L0 9 z" style={{ fill: "var(--text3)" }} />
              </marker>
            </defs>
            {/* wires first, so a node sits on top of the end of every line */}
            <Wire d={`M${cx(B.you!)} ${B.you!.y + B.you!.h} V${B.orch!.y - 2}`} head={head} />
            <path d={`M${cx(B.orch!)} ${B.orch!.y + B.orch!.h} V196 M${cx(B.builder!)} 196 H${cx(B.scout!)}`} fill="none" strokeWidth={1.5} style={{ stroke: "var(--text3)" }} />
            {JOB_ORDER.map((f) => <Wire key={f} d={`M${cx(B[f]!)} 196 V${B[f]!.y - 2}`} head={head} />)}
            <Wire dashed={!holds} hot={holds} head={head} d={`M${cx(B.builder!)} ${B.builder!.y + B.builder!.h} V${B.fb!.y + 34} H${B.fb!.x - 2}`} />
            {trig && <text x={cx(B.builder!) + 10} y={B.fb!.y + 25} fontSize={11.5} style={{ fill: holds ? "var(--warning-ink)" : "var(--text3)", fontFamily: MONO }}>{trig}</text>}
            <Wire d={`M${cx(B.fb!)} ${B.fb!.y + B.fb!.h} V${B.gate!.y - 2}`} head={head} />
            <Wire d={`M${B.gate!.x + B.gate!.w} ${B.gate!.y + 29} H780 V${B.you!.y + 27} H${B.you!.x + B.you!.w + 2}`} head={head} dashed={!gateOn} />

            <Node clipId={`${uid}a`} box={B.you!} hue="var(--text3)" name="You" sub="decide what is held" />
            <Node clipId={`${uid}b`} box={B.orch!} hue={HUE.orchestrator} name={NAME.orchestrator} sub={sub(main)} state={stateOf(main)}
              label={`Change the ${main.word}`} onPress={press("orchestrator")} />
            {JOB_ORDER.map((f, i) => (
              <Node key={f} clipId={`${uid}c${i}`} box={B[f]!} hue={HUE[f]} name={NAME[f]} sub={sub(job(f))} state={stateOf(job(f))}
                fill={job(f).ruleId ? "color-mix(in srgb, var(--success) 8%, var(--surface-card))" : undefined}
                label={`Change the ${job(f).word}`} onPress={press(f)} />
            ))}
            <Node clipId={`${uid}d`} box={B.fb!} hue="var(--warning)" name="Fallback" dashed={!holds} muted={!rule || !rule.enabled}
              fill={holds ? "color-mix(in srgb, var(--warning) 12%, var(--surface-card))" : undefined}
              sub={!rule ? "none set" : `${fbEngine ? engineName(fbEngine) : "Another engine"} · ${moved || "task"}`}
              state={rule ? { word: !rule.enabled ? "Rule is off" : holds ? "In use now" : "Waiting", tone: holds ? "warn" : "checking" } : null} />
            <Node clipId={`${uid}e`} box={B.gate!} hue="var(--warning)" name={gate && !gateOn ? "Gate · off" : "Gate"} sub={gateWord} dashed={!gateOn} muted={!!gate && !gateOn}
              fill={gateOn ? "color-mix(in srgb, var(--warning) 16%, var(--surface-card))" : undefined} />
          </svg>
          {notOk.map((n) => <p key={n.field} role="alert" className="m-0 text-[12px]" style={{ color: "var(--error-ink)" }}>{n.sentence}</p>)}
          <div className="agx-orch-caption" aria-live="polite">
            {line("Local work (code, tests, worktrees) never waits at the gate.", "a")}
            {line(<>Dashed line: the switch you set under “Switch things automatically”.</>, "b")}
            {line(<>{p.readiness ? flowBecause(nodes, p.policy) : "Checking this machine."}{" "}
              {p.readiness && plain && p.onPickSetup && <button type="button" className="agx-field-link" onClick={p.onPickSetup}>Pick a setup</button>}</>, "c")}
          </div>
        </div>
      </SettingsCard>
    </section>
  );
}
