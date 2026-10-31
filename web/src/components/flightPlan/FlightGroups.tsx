import type { FlightItem, PilotSnapshot, Strip, StripButtonId } from "../../lib/flightPilot.ts";
import { plural } from "../../lib/flightPilot.ts";
import { projectName } from "../../lib/flightPlan.ts";
import { ICON } from "../../lib/iconSize.ts";
import { FolderIcon } from "./fpIcons.tsx";
import { FlightList, type RowDo } from "./FlightList.tsx";
import { PilotStrip } from "./PilotStrip.tsx";

export interface FlightGroup { root: string; items: FlightItem[]; snap: PilotSnapshot; strip: Strip; engine: boolean }

/**
 * The Flying tab when plans of more than one project are in the air: one block per
 * project, each with its own name, mode badge, meters and button (the strip) and
 * its own rows. What a project's strip says is about that project only.
 */
export function FlightGroups({ groups, loading, now, busy, error, actRoot, onButton, onSecondary, onOpen, onCard, onDo, onHistory, onCompose }: {
  groups: FlightGroup[]; loading: boolean; now: number; busy: boolean; error: string; actRoot: string;
  onButton: (id: StripButtonId, root: string) => void; onSecondary: (root: string) => void;
  onOpen: (id: string) => void; onCard: (id: string) => void; onDo: RowDo; onHistory: () => void; onCompose: () => void;
}) {
  return (
    <div className="pv-groups">
      {groups.map((g, i) => (
        <section key={g.root} className="pv-proj" aria-labelledby={`pv-p-${i}`}>
          <h3 className="pv-proj-h" id={`pv-p-${i}`} title={g.root}><FolderIcon size={ICON.sm} />{projectName(g.root)}<span className="n">{plural(g.items.length, "plan")}</span></h3>
          <PilotStrip strip={g.strip} engine={g.engine} busy={busy && g.root === actRoot} error={g.root === actRoot ? error : ""} onButton={(id) => onButton(id, g.root)} onSecondary={() => onSecondary(g.root)} />
          <FlightList items={g.items} loading={loading} snap={g.snap} now={now} scope={`${i}-`} onOpen={onOpen} onCard={onCard} onDo={onDo} onHistory={onHistory} onCompose={onCompose} />
        </section>
      ))}
    </div>
  );
}
