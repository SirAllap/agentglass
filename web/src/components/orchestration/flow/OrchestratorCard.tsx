/*
 * The orchestrator's card, above the path, drawn as the approved mockup's `.ob`:
 * the strip naming who is seated and the pilot, the chair's engine and model, the
 * three numbers read now, the last settled line, the roles waiting in the team
 * and two ways in — Configure opens the sheet, Open its tab goes to the session
 * in the chair.
 *
 * Presentational only: the words are `orchestratorCardView.ts`'s and the data is
 * the editor's (`Around` and D4's counts). It edits nothing.
 */
import type { Flow } from "../../../../../shared/flow.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { orchestratorCardModel, type OrchestratorCardData } from "../../../lib/orchestratorCardView.ts";
import type { BlockMark } from "./canvasRules.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { engineName } from "./flowScreenCopy.ts";

export function OrchestratorCard(p: {
  flow: Flow;
  data: OrchestratorCardData;
  mark?: BlockMark;
  x: number;
  y: number;
  selected?: boolean;
  /** The project the chair is seated in, as the strip says it. */
  project?: string;
  /** Pressed while a rule is edited: the main agent joins the rule. */
  onPress?: () => void;
  onConfigure?: () => void;
  /** Goes to the seat's own session; absent when nobody is seated. */
  onOpenTab?: () => void;
}) {
  const m = orchestratorCardModel(p.flow, p.data);
  const press = p.onPress;
  const seated = !!p.data.seat?.name;
  const letter = (id: string | null | undefined): string => id === "claude" ? "C" : id === "opencode" ? "O" : id === "codex" ? "X" : (id ? engineName(id)[0] ?? "?" : "?");
  return (
    <div className="fe-blk fe-oc fe-ob" data-fe-hit data-fe-orch data-mark={p.mark?.kind} data-focus={p.mark?.focus ? "" : undefined} data-warn={p.mark?.warn ? "" : undefined}
      aria-pressed={p.selected} style={{ left: p.x, top: p.y, "--hue": "var(--g-agents)" } as React.CSSProperties}
      role={press ? "button" : "group"} tabIndex={press ? 0 : undefined} aria-label={`Orchestrator. ${seated ? `Seated in ${p.project ?? "this project"}.` : m.stateTip}. ${m.chairWord}.`}
      onPointerDown={press ? (e) => e.stopPropagation() : undefined}
      onClick={press}
      onKeyDown={press ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); press(); } } : undefined}>
      <div className="fe-obh">
        <span className="fe-obs" data-tip={m.stateTip}><i aria-hidden="true" />{seated ? `Active · seated in ${p.project ?? "this project"}` : m.stateWord}</span>
        {m.pilotWord && <span className="fe-obm">{m.pilotWord}</span>}
      </div>
      <div className="fe-obb">
        <span className="fe-obt" aria-hidden="true"><FlowIcon name="hub" size={28} /></span>
        <div className="fe-obi">
          <div className="fe-obn">Orchestrator <small>the main agent</small></div>
          <div className="fe-obd">You decide the route. This flow is a guide: only blocks marked <b><FlowIcon name="lock" size={12} />required</b> must run.</div>
          <div className="fe-obe" data-tip="The engine and model the policy gives the chair">
            {p.data.chair
              ? <><span className="fe-eng"><i className="fe-dot">{letter(p.data.chair.engine)}</i>{engineName(p.data.chair.engine)}</span><code>{p.data.chair.model || "its default"}</code></>
              : <span className="fe-wk-rl">Reading the policy…</span>}
          </div>
        </div>
        <div className="fe-obc">
          <div data-tip={m.flightTip}><small>Workers in flight</small><b>{m.flight}</b></div>
          <div data-tip={m.planTip}><small>Plan used</small><b>{m.plan}</b></div>
          <div data-tip={m.todayTip}><small>Today</small><b>{m.today}</b></div>
        </div>
      </div>
      <div className="fe-obl" data-tip={m.lastTip}>
        <span className="fe-obx" aria-hidden="true"><FlowIcon name="loop" size={14} /></span>
        <span><b>Last decision</b> · {m.last}</span>
      </div>
      <div className="fe-obf">
        {p.onConfigure && (
          <button type="button" className="fe-btn" data-size="sm" onClick={(e) => { e.stopPropagation(); p.onConfigure!(); }}>
            <FlowIcon name="gear" size={ICON.xs} />Configure
          </button>
        )}
        {p.onOpenTab && (
          <button type="button" className="fe-btn" data-size="sm" onClick={(e) => { e.stopPropagation(); p.onOpenTab!(); }}>
            <FlowIcon name="play" size={ICON.xs} />Open its tab
          </button>
        )}
        <span className="fe-sp" />
        <span className="fe-roster" data-tip={`${m.teamWord}; the orchestrator may still pick one for a job`}>
          {m.team.slice(0, 6).map((t) => <i key={t.name} style={{ background: `var(--${t.hue})` }} title={t.name} />)}
          {m.team.length > 6 && <em>+{m.team.length - 6}</em>}
        </span>
      </div>
    </div>
  );
}
