import { agentProvider } from "../../../../shared/agentKinds.ts";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";
import { engineLetter, type DiagramRow } from "./orchestrationCopy.ts";

/**
 * What a ready-made setup would change, drawn: for each job it names, the
 * engines tried now beside the engines it would try. Neutral letters, in the
 * order they are tried; the title carries the engine's name.
 */
function Letters({ ids }: { ids: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {ids.map((id, i) => (
        <span key={`${i}-${id}`} title={agentProvider(id)?.title ?? id}
          className="inline-flex items-center justify-center rounded-md text-[10px] font-semibold"
          style={{ width: CTRL_H.compact, height: CTRL_H.compact, background: "var(--surface-card)", border: EDGE, color: "var(--text2)" }}>
          {engineLetter(id)}
        </span>
      ))}
    </span>
  );
}

export function PresetDiagram({ rows }: { rows: DiagramRow[] }) {
  if (!rows.length) return null;
  const head = "text-[10px] uppercase tracking-wider";
  return (
    <div className="rounded-lg p-2 grid items-center gap-x-2 gap-y-1.5 text-[11px]" role="group" aria-label="Before and after"
      style={{ background: "var(--surface-inset)", border: EDGE, gridTemplateColumns: "auto minmax(0, 1fr) auto minmax(0, 1fr)", color: "var(--text2)" }}>
      <span />
      <span className={head} style={{ color: "var(--text3)" }}>Before</span>
      <span />
      <span className={head} style={{ color: "var(--text3)" }}>After</span>
      {rows.map((r) => (
        <div key={r.role} className="contents">
          <span>{r.word}</span>
          <Letters ids={r.before} />
          <span aria-hidden style={{ color: "var(--text3)" }}>to</span>
          <Letters ids={r.after} />
        </div>
      ))}
    </div>
  );
}
