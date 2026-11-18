/*
 * "Add a step": a sheet from the right with the four things a step needs: a
 * name, who does it (a role of the team, which brings its engine and rules),
 * whether it is required, and where it goes. `checkDraft` says what is wrong
 * per field and `addStep` makes the flow; the sheet keeps no rule of its own.
 */
import { useState } from "react";
import { FLOW_NAME_MAX, roleById, type Flow } from "../../../../../shared/flow.ts";
import { addStep, checkDraft, freshDraft, gateId, type StepDraft } from "../../../lib/flowMove.ts";
import { useModalDialog } from "../../../lib/focusTrap.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { Switch } from "./Switch.tsx";

export function AddStepSheet(p: { flow: Flow; initial?: StepDraft | null; onAdd: (next: Flow, id: string) => void; onNewRole: (draft: StepDraft) => void; onClose: () => void }) {
  const gate = gateId(p.flow);
  // The house dialog contract: Tab stays inside, focus goes back to the "Add a step" button on close.
  const modal = useModalDialog(true, "Add a step");
  const [d, setD] = useState<StepDraft>(p.initial ?? freshDraft(p.flow));
  const [touched, setTouched] = useState(!!p.initial?.name);
  const c = checkDraft(p.flow, d);
  const nameWhy = d.name.length > FLOW_NAME_MAX || touched ? c.name : undefined;
  const picks = p.flow.roster.filter((r) => r.actor !== "person");
  const submit = () => {
    setTouched(true);
    const r = addStep(p.flow, d);
    if (r.ok) p.onAdd(r.flow, r.flow.roster[r.flow.roster.length - 1]!.id);
  };
  return (
    <div className="fe-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="fl-sheet" {...modal} aria-labelledby="fl-add-title" aria-label={undefined} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); p.onClose(); } }}>
        <div className="fe-sheethead">
          <span className="fe-ico" aria-hidden="true"><FlowIcon name="plus" size={ICON.sm} /></span>
          <div><h2 id="fl-add-title">Add a step</h2><p>A step is one role doing one job at one place in the flow.</p></div>
          <span className="fe-sp" />
          <button className="fe-sq" type="button" aria-label="Close" onClick={p.onClose}><FlowIcon name="x" size={ICON.xs} /></button>
        </div>
        <div className="fe-sheetbody">
          <label className="fl-lab" htmlFor="fl-name">Name</label>
          <div className="fl-field" data-bad={nameWhy ? "" : undefined}>
            <input id="fl-name" autoFocus value={d.name} aria-invalid={!!nameWhy} aria-describedby="fl-name-why" onChange={(e) => setD({ ...d, name: e.target.value })} onBlur={() => setTouched(true)} />
            <span className="fl-count">{d.name.trim().length}/{FLOW_NAME_MAX}</span>
          </div>
          <p className="fl-err" id="fl-name-why" role="alert">{nameWhy ?? ""}</p>

          <span className="fl-lab" id="fl-role">Role</span>
          <p className="fl-help">Who does this step. The role brings its engine and rules.</p>
          <div className="fl-seg" role="radiogroup" aria-labelledby="fl-role">
            {picks.map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={d.roleId === r.id} onClick={() => setD({ ...d, roleId: r.id })}>{r.name}</button>
            ))}
            <button type="button" onClick={() => p.onNewRole(d)}>New role…</button>
          </div>

          <div className="fl-req">
            <Switch on={d.required} label="Required" onChange={(required) => setD({ ...d, required })} />
            <div><b>Required</b><p>The flow cannot finish without it, and nobody can delete or skip it. Off = a step you can skip.</p></div>
          </div>

          <span className="fl-lab" id="fl-where">Where it goes</span>
          <p className="fl-help">Pick the step it comes after. You and the Gate are fixed, so the choices stop there.</p>
          <div className="fl-where" role="radiogroup" aria-labelledby="fl-where">
            <button type="button" role="radio" aria-checked={d.after === null} onClick={() => setD({ ...d, after: null })}>First step, right after You</button>
            {p.flow.path.filter((id) => id !== gate).map((id, i) => (
              <button key={id} type="button" role="radio" aria-checked={d.after === id} onClick={() => setD({ ...d, after: id })}>
                <span>After step {i + 2}</span><b>{roleById(p.flow, id)?.name}</b>
              </button>
            ))}
          </div>
          {c.after && <p className="fl-err" role="alert">{c.after}</p>}
          {c.full && <p className="fl-err" role="alert">{c.full}</p>}
        </div>
        <div className="fe-sheetfoot">
          <span className="fe-sp" />
          <button className="fe-btn" type="button" onClick={p.onClose}>Cancel</button>
          <button className="fe-btn" data-tone="primary" type="button" disabled={!c.ok} onClick={submit}>Add step</button>
        </div>
      </div>
    </div>
  );
}
