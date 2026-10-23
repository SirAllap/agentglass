import { SettingsCard } from "../SettingsKit.tsx";
import { Button, EDGE, tintEdge } from "../workspace/Chrome.tsx";
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
  onChange: (field: Field) => void;
}

/** Before the probe answers there is nothing to resolve: show the chains the policy holds, unjudged. */
function plainNodes(policy: Policy): FlowNode[] {
  return (["orchestrator", ...ROLE_IDS] as Field[]).map((f) => ({
    field: f, word: roleWord(f), ok: true, because: "", sentence: "", ruleId: null,
    chain: f === "orchestrator" ? policy.base.orchestrator.value : policy.base.workers[f].value,
  }));
}

function ChainTiles({ node, readiness, liveModel }: { node: FlowNode; readiness: readonly EngineReadiness[] | null; liveModel: string | null }) {
  const role = node.field === "orchestrator" ? "orchestrator" as const : "worker" as const;
  const chain: Chain = node.chain;
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      {chain.map((c, i) => (
        <span key={`${i}-${c.engine}-${c.model}`} className="contents">
          {i > 0 && <span aria-hidden className="agx-flow-arrow text-[12px]" style={{ color: "var(--text3)" }}>then</span>}
          <EngineTile engine={c.engine} model={i === 0 && node.field === "orchestrator" && liveModel ? liveModel : c.model} role={role}
            readiness={readiness} position={chain.length > 1 ? i + 1 : undefined} />
        </span>
      ))}
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
  return (
    <SettingsCard title="Right now" desc={`What would run for ${scopeWords(p.root)} if a job started this moment.`}>
      <div className="agx-settings-x pt-2 pb-4 grid gap-3" data-flow="right-now">
        <div className="agx-flow">
          <div className="agx-flow-main rounded-lg p-3 grid content-start gap-3" style={{ border: EDGE, background: "var(--surface-inset)" }}>
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Main agent</div>
              <div className="text-[13px] font-medium pt-1" style={{ color: "var(--text)" }}>{roleBlurb("orchestrator")}</div>
            </div>
            <ChainTiles node={main} readiness={p.readiness} liveModel={p.liveModel} />
            <div>{change(main)}</div>
          </div>
          <div className="agx-flow-roles">
            {jobs.map((n) => (
              <div key={n.field} className="agx-flow-job rounded-lg p-3 flex flex-wrap items-center gap-x-4 gap-y-2"
                style={{ border: n.ruleId ? tintEdge("var(--success)", 60) : EDGE }}>
                <div className="w-[150px] shrink-0">
                  <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{n.word.charAt(0).toUpperCase() + n.word.slice(1)}</div>
                  <div className="text-[11px]" style={{ color: "var(--text3)" }}>{roleBlurb(n.field)}</div>
                </div>
                <div className="flex-1 min-w-0"><ChainTiles node={n} readiness={p.readiness} liveModel={null} /></div>
                {change(n)}
                {!n.ok && <p role="alert" className="m-0 basis-full text-[12px]" style={{ color: "var(--error-ink)" }}>{n.sentence}</p>}
              </div>
            ))}
          </div>
        </div>
        {!main.ok && <p role="alert" className="m-0 text-[12px]" style={{ color: "var(--error-ink)" }}>{main.sentence}</p>}
        <p className="m-0 text-[12px]" style={{ color: "var(--text2)" }}>
          {p.readiness ? flowBecause(nodes, p.policy) : "Checking this machine."}
        </p>
      </div>
    </SettingsCard>
  );
}
