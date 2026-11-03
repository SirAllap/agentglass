/*
 * The right panel of the Flow editor, read-only: what the selected role runs
 * on, what it may do, where the work goes and why it is set so, with one small
 * Configure that opens the single worker editor. It is a summary and nothing
 * else — every setting has one home, and it is the editor.
 */
import { roleById, type Flow } from "../../../../../shared/flow.ts";
import { workerCardModel, type LiveCounts } from "../../../lib/workerCardView.ts";
import { roleWhy } from "./blockRules.ts";
import { ruleHolds, scopeWords } from "../orchestrationCopy.ts";
import { SideGrip } from "./SideGrip.tsx";
import { FlowIcon } from "./flowIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { TOOL_WORD, engineName, stageLabel } from "./flowScreenCopy.ts";
import type { Around } from "./AroundFlow.tsx";

export function WorkerPanel(p: { flow: Flow; id: string; around: Around; counts?: LiveCounts | null; onClose: () => void; onConfigure: () => void }) {
  const role = roleById(p.flow, p.id);
  if (!role) return null;
  const m = workerCardModel(p.flow, role, p.counts);
  const scoped = p.around.own && p.around.root;
  const scopeKey = scoped ? p.around.root! : "global";
  const why = role.policyRole && p.around.policy
    ? roleWhy(p.around.policy, role.policyRole, p.around.readiness, ruleHolds(p.around.states, scopeKey), scopeWords(scoped ? p.around.root : ""))
    : "A role of your own: it runs the chain you gave it, and no policy rule changes it.";
  return (
    <aside className="fe-side" aria-label="Selected worker">
      <SideGrip />
      <div className="fe-sidehead" style={{ "--hue": `var(--${role.hue})` } as React.CSSProperties}>
        <span className="fe-ico" aria-hidden="true"><FlowIcon name={role.ico} size={13} /></span>
        <div><h2>{role.name}</h2><p>{stageLabel(p.flow, role.stage)} · {m.step ? `step ${m.step} of ${p.flow.path.length}` : "in the team"}</p></div>
        <span className="fe-sp" />
        <button className="fe-sq" type="button" title="Close" aria-label="Close" onClick={p.onClose}><FlowIcon name="x" size={12} /></button>
      </div>
      <div className="fe-sidescroll">
        <p className="fe-sidenote" style={{ marginTop: 0 }}>{role.does}</p>
        <section className="fe-bs-card">
          <h3 className="fe-bs-h">The step<small>What this role is for, and whether the orchestrator may skip it.</small></h3>
          <div className="fe-row"><span className="fe-k">Runs on</span><span className="fe-v fe-wide">{m.chain.length ? m.chainWord : "You · this session"}</span></div>
          {m.chain.length > 1 && <div className="fe-row"><span className="fe-k">If it cannot start</span><span className="fe-v fe-wide">{m.chain.slice(1).map((c) => `${engineName(c.engine)} · ${c.model}`).join(" → ")}</span></div>}
          <div className="fe-row"><span className="fe-k">May do</span><span className="fe-v fe-wide">{role.tools.length ? role.tools.map((t) => TOOL_WORD[t] ?? t).join(" · ") : "Nothing"} · {role.readsOnly ? "reads only" : "writes in its own copy"}</span></div>
          <div className="fe-row"><span className="fe-k">Passes to</span><span className="fe-v fe-wide">{m.pass}</span></div>
          <div className="fe-row"><span className="fe-k">Fails to</span><span className="fe-v fe-wide">{m.fail}{m.attempts ? ` · ${m.attempts.word}` : ""}</span></div>
          <div className="fe-row"><span className="fe-k">Required</span><span className="fe-v fe-wide">{m.required ? "Yes · enforced by the server" : "No · the orchestrator may skip it"}</span></div>
          {role.policyRole === "reviewer" && <div className="fe-row"><span className="fe-k">Who checks</span><span className="fe-v fe-wide">Set here, in Who checks this.</span></div>}
        </section>
        <section className="fe-bs-card">
          <h3 className="fe-bs-h">Why it is set so<small>{role.policyRole ? "From the policy, and the rules in force." : "No rule changes a role of your own."}</small></h3>
          <p className="fe-sidenote" style={{ margin: 0 }}>{why}</p>
        </section>
        <div className="fe-reqnote"><FlowIcon name="info" size={ICON.xs} /><span><b>Summary only.</b> Every setting is edited in one place: Configure.</span></div>
      </div>
      <div className="fe-sidefoot">
        <button className="fe-btn" data-size="sm" type="button" onClick={p.onConfigure}><FlowIcon name="hammer" size={ICON.xs} />Configure {role.name}</button>
      </div>
    </aside>
  );
}
