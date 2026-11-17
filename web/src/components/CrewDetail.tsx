// The Crew card's detail view: a small popover with what the board knows about
// one session. Opened by a click or a right-click; only the right-click adds
// the reminder, which writes a task to Taskwarrior.
import { useState } from "react";
import type { LanternRow } from "./LanternView.tsx";
import { ContextMenu } from "./ContextMenu.tsx";
import { Button } from "./workspace/Chrome.tsx";
import { api } from "../lib/api.ts";
import { crewDetailRows, crewReminderInput, remindDisabled, type RemindPhase } from "../lib/crewDetail.ts";
import type { CrewState } from "../lib/starboardCrew.ts";

export function CrewDetail({ row, state, since, now, at, remind, onClose }: {
  row: LanternRow; state: CrewState; since: number; now: number;
  at: { x: number; y: number }; remind: boolean; onClose: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [phase, setPhase] = useState<RemindPhase>("idle");
  const add = async () => {
    setPhase("busy");
    try {
      const r = await api.taskAdd(crewReminderInput(row));
      setPhase(r.ok ? "done" : "idle");
      setNote(r.ok ? "Task added to Taskwarrior." : r.error ?? "Taskwarrior did not take it.");
    } catch { setPhase("idle"); setNote("Taskwarrior did not answer."); }
  };
  return (
    <ContextMenu pop x={at.x} y={at.y} onClose={onClose} width={280} label={row.name}>
      <div style={{ padding: "10px 12px", display: "grid", gap: 6 }}>
        <div style={{ fontWeight: 600 }}>{row.name}</div>
        {crewDetailRows(row, state, since, now).map((d) => (
          <div key={d.label} style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 8, fontSize: 12 }}>
            <span style={{ color: "var(--text3)" }}>{d.label}</span><span style={{ overflowWrap: "anywhere" }}>{d.value}</span>
          </div>
        ))}
        {remind && <Button size="compact" tone="primary" disabled={remindDisabled(phase)} onClick={() => void add()}>Remind me to check</Button>}
        {note && <div role="status" style={{ fontSize: 12 }}>{note}</div>}
      </div>
    </ContextMenu>
  );
}
