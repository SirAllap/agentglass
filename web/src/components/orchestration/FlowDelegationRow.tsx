/*
 * The person's own switch for `flow.delegationGuard`: whether the project's
 * orchestrator may start a Claude subagent for work that one of its flow's
 * worker blocks (on another engine) owns.
 *
 * On by default, held PER PROJECT, and personOnly: an agent that could turn the
 * guard off would unmake the very rule that refuses it. The rule only exists
 * when a worker block runs on a different engine than the seat, so a flow of
 * Claude roles is not affected either way.
 */
import { useEffect, useState } from "react";
import { Toggle } from "../SettingRow.tsx";
import { api } from "../../lib/api.ts";

export function FlowDelegationRow({ root }: { root: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOn(null);
    const read = root ? api.settingAt("flow.delegationGuard", root) : api.settingAtGlobal("flow.delegationGuard");
    void read.then((r) => setOn(r.ok ? r.value !== false : true)).catch(() => setOn(true));
  }, [root]);
  const flip = async () => {
    if (on === null) return;
    const r = await api.settingAtSet("flow.delegationGuard", !on, root).catch(() => null);
    if (r?.ok) { setOn(!on); setError(null); } else setError(r?.error ?? "the server did not answer");
  };
  return (
    <Toggle settingId="flow.delegationGuard" label="The flow owns its jobs: the orchestrator may not spawn a Claude subagent for work a worker block takes"
      agentNever="turning it off unmakes the rule that refuses the seat: only the person changes it, from Settings"
      hint={error ?? (root
        ? "Applies to this project only. On, the orchestrator starts the flow's own worker for that job instead of a hidden Claude helper. It has no effect when every role runs on the orchestrator's own engine."
        : "A flow belongs to one project: open a project in the app to change this there.")}
      on={on === true} disabled={on === null} onClick={() => void flip()} />
  );
}
