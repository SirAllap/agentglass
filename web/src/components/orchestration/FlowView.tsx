import { Button } from "../workspace/Chrome.tsx";
import { Card, Eyebrow } from "./OrchKit.tsx";
import { ROLE_IDS, type Chain, type Policy } from "../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { EngineTile } from "./EngineTile.tsx";
import { flowBecause, flowNodes, roleBlurb, roleWord, scopeWords, type Field, type FlowNode } from "./orchestrationCopy.ts";

/**
 * "Right now": who does each job at this moment, and why, as a picture. The
 * main agent on the left, a wire to each of the three jobs, each job a chain of
 * engine tiles in the order they are tried. One line under it says what put
 * them there: the defaults, a ready-made setup or a rule.
 *
 * It is drawn from what the page holds (the policy, the rules' reading and the
 * engines' probe) and makes no request. A job a rule or a setup moved has a
 * green edge. Change takes the person to the row that sets that job.
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

function ChainTiles({ node, readiness, liveModel, limited }: { node: FlowNode; readiness: readonly EngineReadiness[] | null; liveModel: string | null; limited?: ReadonlySet<string> }) {
  const role = node.field === "orchestrator" ? "orchestrator" as const : "worker" as const;
  const chain: Chain = node.chain;
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      {chain.map((c, i) => (
        <span key={`${i}-${c.engine}-${c.model}`} className="contents">
          {i > 0 && <span aria-hidden className="agx-flow-arrow text-[12px]" style={{ color: "var(--text4)" }}>→</span>}
          <EngineTile engine={c.engine} model={i === 0 && node.field === "orchestrator" && liveModel ? liveModel : c.model} role={role}
            readiness={readiness} limitHit={limited?.has(c.engine)} position={chain.length > 1 ? i + 1 : undefined} />
        </span>
      ))}
    </div>
  );
}

const STATUS_WORDS: [string, string, string][] = [
  ["var(--success)", "Ready", "var(--success-ink)"],
  ["var(--text4)", "Not installed", "var(--warning-ink)"],
  ["var(--error)", "Not signed in", "var(--warning-ink)"],
  ["var(--warning)", "Limit hit", "var(--warning-ink)"],
];

/** The four words a tile can say about its engine, once, under the picture. */
function Legend() {
  return (
    <div data-flow="legend" className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[10px]" style={{ color: "var(--text3)" }}>
      {STATUS_WORDS.map(([hue, word, ink]) => (
        <span key={word} className="inline-flex items-center gap-1.5" style={{ color: ink }}>
          <span aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, background: hue }} />{word}
        </span>
      ))}
      <span>Every engine says its state in a word. A step that cannot run says why on the line under its role.</span>
    </div>
  );
}

export function FlowView(p: FlowViewProps) {
  const nodes = p.readiness ? flowNodes(p.policy, p.facts, p.readiness) : plainNodes(p.policy);
  const main = nodes[0]!;
  const jobs = nodes.slice(1);
  const change = (n: FlowNode) => (
    <Button disabled={p.disabled} label={`Change the ${n.word}`} onClick={() => p.onChange(n.field)}>Change</Button>
  );
  const plain = !nodes.some((n) => n.ruleId);
  return (
    <section data-flow="right-now" aria-label="Who does what right now">
      <Eyebrow>Right now for {scopeWords(p.root)}</Eyebrow>
      <Card>
        <div className="agx-flow">
          <div className="agx-flow-main rounded-xl p-3 grid content-center justify-items-start gap-2" style={{ border: "2px solid var(--primary)", background: "var(--bg2)" }}>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Main agent</div>
            <div className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>{roleBlurb("orchestrator")}</div>
            <ChainTiles node={main} readiness={p.readiness} liveModel={p.liveModel} limited={p.limited} />
            <div>{change(main)}</div>
          </div>
          <div className="agx-flow-roles">
            {jobs.map((n) => (
              <div key={n.field} className="agx-flow-job rounded-xl p-3 flex flex-wrap items-center gap-x-4 gap-y-2"
                style={{ background: "var(--bg)", border: n.ruleId ? "1px solid var(--success)" : "1px solid var(--border)", boxShadow: n.ruleId ? "0 0 0 1px var(--success)" : undefined }}>
                <div className="w-[120px] shrink-0">
                  <div className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>{n.word.charAt(0).toUpperCase() + n.word.slice(1)}</div>
                  <div className="text-[10px]" style={{ color: "var(--text3)" }}>{roleBlurb(n.field)}</div>
                </div>
                <div className="flex-1 min-w-0"><ChainTiles node={n} readiness={p.readiness} liveModel={null} limited={p.limited} /></div>
                {change(n)}
                {!n.ok && <p role="alert" className="m-0 basis-full text-[11px] rounded-md px-2 py-1"
                  style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 12%, transparent)" }}>{n.sentence}</p>}
              </div>
            ))}
          </div>
        </div>
        {!main.ok && <p role="alert" className="m-0 mt-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{main.sentence}</p>}
        <p data-flow="because" className="m-0 mt-3 text-[12px] flex flex-wrap items-center gap-x-2" style={{ color: "var(--text3)" }} aria-live="polite">
          <span>{p.readiness ? flowBecause(nodes, p.policy) : "Checking this machine."}</span>
          {p.readiness && plain && p.onPickSetup && <button type="button" className="bg-transparent border-0 p-0 cursor-pointer text-[12px] font-semibold" style={{ color: "var(--info)" }} onClick={p.onPickSetup}>Pick a setup below</button>}
        </p>
        <Legend />
      </Card>
    </section>
  );
}
