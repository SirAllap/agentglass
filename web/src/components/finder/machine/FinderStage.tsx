// The Finder's confirmation for a file operation an agent prepared. It names the
// caller as a label (the caller picked it), lists every path, has nothing to
// edit, and keeps its button dead for a moment, as every prepared dialog does
// (lib/stageHold.ts). The press is the only thing that runs it.
import { HIT } from "../../../lib/iconSize.ts";
import { preparedLine, useStageHold } from "../../../lib/stageHold.ts";
import { stageConfirm, stagePaths, stageSentence, type FinderStageArgs } from "../../../lib/finderStage.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { Sheet } from "./FinderOpsUI.tsx";

export function StageDialog({ a, by, n, onConfirm, onClose }: { a: FinderStageArgs; by: string; n: number; onConfirm: () => void; onClose: () => void }) {
  const held = useStageHold(true, n);
  const title = `${by} wants to ${stageSentence(a)}`;
  return (
    <Sheet label={title} onClose={onClose} width={420}>
      <b className="block text-[13px] mb-1 break-words">{title}</b>
      <div role="status" className="mb-2 text-[10.5px]" data-prepared-by="" style={{ color: "var(--warning-ink)" }}>{preparedLine(by)}</div>
      <div className="m-0 mb-3 break-all font-mono text-[11px]" style={{ color: "var(--text3)" }}>
        {stagePaths(a).map((l) => <div key={l}>{l}</div>)}
      </div>
      <div className="flex justify-end gap-2">
        <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
        <button className="agx-btn rounded-md px-3" disabled={held} style={{ minHeight: HIT, border: EDGE, opacity: held ? 0.5 : 1 }} onClick={() => { if (!held) onConfirm(); }}>{stageConfirm(a.op)}</button>
      </div>
    </Sheet>
  );
}
