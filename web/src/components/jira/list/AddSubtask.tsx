/*
 * Under an opened parent's sub-tasks: a box that makes one more, and the button that hands every open one to the terminal.
 * Both are changes (the first writes to Jira, the second starts agents), so both are off while this app may not change Jira.
 */
import { useState, useSyncExternalStore } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { fleetNow, onFleet } from "../../../lib/jiraCardWork.ts";
import { addSubtask, sendOpenSubtasks } from "../../../lib/jiraSubtaskActions.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { INPUT } from "../../workspace/Chrome.tsx";

export function AddSubtask({ parent, kids, writable }: { parent: ProviderTask; kids: readonly ProviderTask[]; writable: boolean }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const open = kids.filter((k) => k.statusKind !== "done").length;
  const key = parent.customId ?? parent.id;
  const add = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    const r = await addSubtask(key, title);
    setBusy(false);
    setNote(r.text);
    if (r.ok) setTitle("");
  };
  return (
    <div className="agx-jl-add" onClick={(e) => e.stopPropagation()}>
      <input className={INPUT} value={title} disabled={!writable || busy} placeholder="+ Add subtask" aria-label={`Add a sub-task to ${key}`}
        data-tip={writable ? undefined : tipAttr("Changes to Jira are off")}
        onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } e.stopPropagation(); }} />
      <button type="button" className="agx-jl-btn" disabled={!open || !writable}
        onClick={() => { void sendOpenSubtasks(parent, kids, agents).then((r) => setNote(r.text)); }}>
        Send all open subtasks to terminal ({open})
      </button>
      {note && <span role="status" style={{ fontSize: 11, color: "var(--text3)" }}>{note}</span>}
    </div>
  );
}
