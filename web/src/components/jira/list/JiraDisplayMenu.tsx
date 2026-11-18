/*
 * The Display button and its popover: Layout (Board / List), Density, Swimlanes. In List, where Swimlanes has no rows to
 * split, the grouping the list always had takes that place.
 */
import { useRef, useState, type ReactNode } from "react";
import { AnchoredMenu } from "../../AnchoredMenu.tsx";
import { LINE, Segmented } from "../../workspace/Chrome.tsx";
import { Caret, Ctl, DisplayIcon } from "./ListControls.tsx";
import { GroupControl } from "./GroupControl.tsx";
import type { BoardDensity, BoardLanes, BoardMode } from "./boardModel.ts";
import type { JiraListFilters } from "./model.ts";

export const MODES = [{ id: "board", label: "Board" }, { id: "list", label: "List" }] as const;
export const DENSITIES = [{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }] as const;
export const LANES = [{ id: "none", label: "None" }, { id: "epic", label: "Epic" }, { id: "assignee", label: "Assignee" }, { id: "priority", label: "Priority" }, { id: "agent", label: "Agent" }] as const;

function Part({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div style={{ padding: "8px 16px 10px", borderTop: LINE }} className="first:border-t-0">
      {/* The same heading as a Filters section (sentence case, 12 semibold): the two popovers sit side by side and read as one family. */}
      <div style={{ height: 22, lineHeight: "22px", marginBottom: 4, fontSize: 12, fontWeight: 600, color: "var(--text2)" }}>{name}</div>
      {children}
    </div>
  );
}

export function JiraDisplayMenu({ mode, onMode, density, onDensity, lanes, onLanes, filters, onFilters, hasAreas, assigned, scope }: {
  mode: BoardMode; onMode: (m: BoardMode) => void; density: BoardDensity; onDensity: (d: BoardDensity) => void; lanes: BoardLanes; onLanes: (l: BoardLanes) => void;
  filters: JiraListFilters; onFilters: (patch: Partial<JiraListFilters>) => void; hasAreas: boolean; assigned: boolean;
  /** An open epic on a board with a sprint: "Sprint only / All n". */
  scope?: { sprint: string; total: number } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Ctl btnRef={btn} pressed={open} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        tip={{ name: "Display", text: "Layout, density and swimlanes.", hint: { text: "b layout · d density" } }}>
        <DisplayIcon /> Display <Caret />
      </Ctl>
      {open && (
        <AnchoredMenu anchor={btn} align="left" minWidth={290} plain keepTab onClose={() => setOpen(false)}>
          <div data-testid="jira-display-popover" className="agx-jmock">
            <Part name="Layout"><Segmented label="Layout (b)" value={mode} options={MODES} onChange={onMode} /></Part>
            {scope && (
              <Part name="Scope">
                <Segmented label="Scope" value={filters.sprintOnly ?? "all"} onChange={(v) => onFilters({ sprintOnly: v === "all" ? null : scope.sprint })}
                  options={[{ id: scope.sprint, label: `${scope.sprint} only` }, { id: "all", label: `All ${scope.total}` }]} />
              </Part>
            )}
            <Part name="Density"><Segmented label="Card density (d)" value={density} options={DENSITIES} onChange={onDensity} /></Part>
            {mode === "board"
              ? <Part name="Swimlanes"><Segmented label="Swimlanes" value={lanes} options={LANES} onChange={onLanes} /></Part>
              : <Part name="Group"><GroupControl filters={filters} onFilters={onFilters} hasAreas={hasAreas} assigned={assigned} board={false} /></Part>}
          </div>
        </AnchoredMenu>
      )}
    </>
  );
}
