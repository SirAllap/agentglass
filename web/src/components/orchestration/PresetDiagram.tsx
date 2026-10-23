import { agentProvider } from "../../../../shared/agentKinds.ts";
import { CTRL_H } from "../workspace/Chrome.tsx";
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
          style={{ width: CTRL_H.compact, height: CTRL_H.compact, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)" }}>
          {engineLetter(id)}
        </span>
      ))}
    </span>
  );
}

export function PresetDiagram({ rows }: { rows: DiagramRow[] }) {
  if (!rows.length) return null;
  const col = (side: "before" | "after") => (
    <div data-col={side} className="rounded-lg p-2 grid content-start gap-1 min-w-0"
      style={{ background: side === "after" ? "color-mix(in srgb, var(--success) 9%, var(--bg2))" : "var(--bg2)" }}>
      <span className="t-mono text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text3)" }}>{side === "after" ? "After" : "Before"}</span>
      {rows.map((r) => (
        <div key={r.role} className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px]" style={{ color: "var(--text2)", minHeight: 22 }}>
          <i className="not-italic shrink-0" style={{ minWidth: 48, color: "var(--text3)" }}>{r.word}</i>
          <Letters ids={r[side]} />
        </div>
      ))}
    </div>
  );
  return (
    <div className="grid items-center gap-2 agx-preset-mini" role="group" aria-label="Before and after" style={{ gridTemplateColumns: "minmax(0, 1fr) 18px minmax(0, 1fr)" }}>
      {col("before")}
      <span aria-hidden className="text-center text-[16px]" style={{ color: "var(--text3)" }}>→</span>
      {col("after")}
    </div>
  );
}
