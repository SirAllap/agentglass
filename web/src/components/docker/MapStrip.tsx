/*
 * The whole fleet as squares, a group under its name. A square outside the
 * current filter stays, dimmed: the map is what exists, not what matches.
 */
import type { DockerContainer } from "../../../../shared/types.ts";
import { displayName, KINDS } from "../../lib/dockerState.ts";
import { stackMap } from "../../lib/dockerTriage.ts";
import { Square } from "./Glyphs.tsx";

export function MapStrip({ groups, inFilter, selected, onPick }: {
  groups: { key: string; label: string; containers: DockerContainer[] }[];
  inFilter: ReadonlySet<string>;
  selected: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="dk-fmap" role="group" aria-label="One square per container">
      {groups.map((g) => (
        <div className="dk-mg" key={g.key}>
          <span className="l" title={g.label}>{g.label}</span>
          <div className="sq">
            {stackMap(g.containers, { inFilter, selected }).map((s) => {
              const c = g.containers.find((x) => x.id === s.id)!;
              return <Square key={s.id} kind={s.kind} dim={s.dim} current={s.current}
                title={`Open ${displayName(c)}, ${KINDS[s.kind].word}`} onPick={() => onPick(s.id)} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
