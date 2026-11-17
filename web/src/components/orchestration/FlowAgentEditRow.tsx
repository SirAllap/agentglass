/*
 * The person's own switch: let the project's orchestrator edit its own flow and
 * roster.
 *
 * Off by default, and held PER PROJECT. On, `PUT /flow` and `DELETE /flow`
 * accept the seat of THIS project, and every write keeps one step back so the
 * person can undo it from the flow page. An agent never turns it on, not even
 * by asking: the class is personOnly (shared/settingClass.ts).
 */
import { useEffect, useState } from "react";
import { Toggle } from "../SettingRow.tsx";
import { api } from "../../lib/api.ts";

export function FlowAgentEditRow({ root }: { root: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOn(null);
    const read = root ? api.settingAt("flow.agentEdit", root) : api.settingAtGlobal("flow.agentEdit");
    void read.then((r) => setOn(r.ok ? r.value === true : false)).catch(() => setOn(false));
  }, [root]);
  const flip = async () => {
    if (on === null) return;
    const r = await api.settingAtSet("flow.agentEdit", !on, root).catch(() => null);
    if (r?.ok) { setOn(!on); setError(null); } else setError(r?.error ?? "the server did not answer");
  };
  return (
    <Toggle settingId="flow.agentEdit" label="Let this project's orchestrator edit its own flow and roster"
      agentNever="lets the project's seat steer the flow it is told to follow: only the person turns it on, from Settings"
      hint={error ?? (root
        ? "Applies to this project only. The seat may then add, rename and place roles; every write keeps one step back, and Undo on the flow page is yours."
        : "A flow belongs to one project: open a project in the app to turn this on there.")}
      on={on === true} disabled={on === null} onClick={() => void flip()} />
  );
}
