/*
 * The narrow list beside the detail: a group's name and its squares, then one
 * short row per container. It filters and selects; the actions live with the
 * detail, which is what this list is for being beside.
 */
import type { DockerStat } from "../../../../shared/types.ts";
import { displayName, KINDS, kindOf } from "../../lib/dockerState.ts";
import { stackMap, type Answer } from "../../lib/dockerTriage.ts";
import { HOT, type GroupView } from "../../lib/dockerView.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Glyph, Square } from "./Glyphs.tsx";

const ANSWER_WORD: Record<Answer, string> = { need: "Need you", run: "Running fine", stop: "Stopped" };

export function SplitList({ groups, stats, selected, answer, onSelect, onClearAnswer }: {
  groups: GroupView[]; stats: Record<string, DockerStat>; selected: string | null; answer: Answer | null;
  onSelect: (id: string) => void; onClearAnswer: () => void;
}) {
  return (
    <>
      {answer && (
        <div className="dk-fbar">Only “{ANSWER_WORD[answer]}”<Button size="compact" tone="quiet" onClick={onClearAnswer}>Clear</Button></div>
      )}
      <div className="agx-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {groups.length ? groups.map((g) => (
          <div key={g.key}>
            <div className="dk-lh">
              <span className="t" title={g.label}>{g.label}</span>
              <span className="dk-mini">{stackMap(g.containers).map((s) => <Square key={s.id} kind={s.kind} small />)}</span>
            </div>
            {g.containers.map((c) => {
              const k = kindOf(c);
              const s = stats[c.id];
              const running = (c.state || "").toLowerCase() === "running";
              return (
                <div key={c.id} role="row" tabIndex={0} className="dk-lr" aria-label={`${displayName(c)}, ${KINDS[k].word}`}
                  data-sel={c.id === selected || undefined} data-off={k === "stop" || k === "made" || undefined} data-cid={c.id === selected ? "active" : undefined}
                  title={`${c.name}\n${c.image}`} onClick={() => onSelect(c.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSelect(c.id); } }}>
                  <Glyph kind={k} />
                  <span className="nm">{displayName(c)}</span>
                  <span className="rt" data-hot={(running && !!s && s.cpu >= HOT.cpu) || undefined}>
                    {running && s ? `${s.cpu.toFixed(1)}%` : k === "restarting" ? "loop" : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )) : <div className="dk-empty-s">Nothing matches.</div>}
      </div>
    </>
  );
}
