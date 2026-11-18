/*
 * The Flow editor's second view: the flow the canvas edits, as stage columns.
 * It holds no flow of its own. It reads the one the editor hands it, lays it
 * out with `flowBoard.ts` and calls back with the same edits the canvas makes
 * (reorder, take off the path, configure, select), so the two views can never
 * disagree. Its ceiling is the layout's, stated in `flowBoard.ts`.
 */
import type { Flow } from "../../../../../shared/flow.ts";
import { boardColumns, stepTarget } from "../../../lib/flowBoard.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { railModel, runsOn } from "./flowScreenCopy.ts";

export function FlowBoard(p: {
  flow: Flow;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onConfigure: (id: string) => void;
  onReorder: (id: string, toIndex: number) => void;
  onRemove: (id: string) => void;
}) {
  const cols = boardColumns(p.flow);
  const of = p.flow.path.length;
  if (!cols.length) return <div className="fe-board fe-board-empty" role="status">Nothing on the path yet. Add a worker to start the flow.</div>;
  return (
    <div className="fe-board" role="list" aria-label="Flow board, one column per stage">
      {cols.map((c) => (
        <section key={c.stage.id} className="fe-bcol" role="listitem" aria-label={`${c.stage.label}, ${c.cards.length} on the path`}>
          <h4 className="fe-bcolh">{c.stage.label}<span>{c.cards.length}</span></h4>
          {c.cards.map(({ role, step }) => {
            const on = runsOn(role);
            const earlier = stepTarget(p.flow, role.id, -1);
            const later = stepTarget(p.flow, role.id, 1);
            return (
              <div key={role.id} className="fe-bcard" role="button" tabIndex={0} aria-pressed={p.selected === role.id}
                style={{ "--hue": `var(--${role.hue})` } as React.CSSProperties}
                aria-label={`${role.name}, step ${step} of ${of}. Enter configures it.`}
                onClick={() => p.onSelect(p.selected === role.id ? null : role.id)} onDoubleClick={() => p.onConfigure(role.id)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") p.onConfigure(role.id); }}>
                <div className="fe-bcardtop">
                  <span className="fe-rt" aria-hidden="true"><FlowIcon name={role.ico} size={13} /></span>
                  <b>{role.name}</b>
                  <span className="fe-bstep">#{step}</span>
                </div>
                {role.does && <p className="fe-bdoes">{role.does}</p>}
                <div className="fe-bfoot">
                  <small>{on ? `${on.engine} · ${railModel(on.model)}` : "You · this session"}</small>
                  {role.required && <span className="fe-chip"><FlowIcon name="lock" size={ICON.xs} />Required</span>}
                  <span className="fe-sp" />
                  <button className="fe-sq" type="button" disabled={earlier === null} aria-label={`Move ${role.name} one step earlier`} data-tip="One step earlier"
                    onClick={(e) => { e.stopPropagation(); if (earlier !== null) p.onReorder(role.id, earlier); }}><FlowIcon name="back" size={ICON.xs} /></button>
                  <button className="fe-sq fe-bnext" type="button" disabled={later === null} aria-label={`Move ${role.name} one step later`} data-tip="One step later"
                    onClick={(e) => { e.stopPropagation(); if (later !== null) p.onReorder(role.id, later); }}><FlowIcon name="back" size={ICON.xs} /></button>
                  <button className="fe-sq" type="button" aria-label={`Configure ${role.name}`} data-tip="Configure"
                    onClick={(e) => { e.stopPropagation(); p.onConfigure(role.id); }}><FlowIcon name="gear" size={ICON.xs} /></button>
                  <button className="fe-sq" type="button" disabled={of < 2} aria-label={`Take ${role.name} off the path`} data-tip={of < 2 ? "The last step cannot go" : "Take off the path; it stays in the team"}
                    onClick={(e) => { e.stopPropagation(); p.onRemove(role.id); }}><FlowIcon name="x" size={ICON.xs} /></button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
