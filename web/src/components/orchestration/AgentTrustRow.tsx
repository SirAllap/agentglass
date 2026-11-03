/*
 * The person's own switch: let agents change settings without asking.
 *
 * Off by default, and held PER PROJECT (server/src/agentTrust.ts): the page is
 * editing one project, so turning it on there says nothing about any other
 * project. On, an agent's change to a setting of the escalation class
 * (shared/settingClass.ts) applies without a request card; a secret and this
 * switch itself still never move for an agent. The save carries the desk key
 * (deskGate.ts), and the server takes it only from the person: an agent asking
 * on any route, the request path included, is refused.
 */
import { useEffect, useState } from "react";
import { Toggle } from "../SettingRow.tsx";
import { api } from "../../lib/api.ts";

export function AgentTrustRow({ root }: { root: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOn(null);
    const read = root ? api.settingAt("agents.changeWithoutAsking", root) : api.settingAtGlobal("agents.changeWithoutAsking");
    void read.then((r) => setOn(r.ok ? r.value === true : false)).catch(() => setOn(false));
  }, [root]);
  const flip = async () => {
    if (on === null) return;
    const r = await api.settingAtSet("agents.changeWithoutAsking", !on, root).catch(() => null);
    if (r?.ok) { setOn(!on); setError(null); } else setError(r?.error ?? "the server did not answer");
  };
  return (
    <Toggle label="Let my agents change settings without asking"
      agentNever="decides whether an agent's risky change waits for the owner at all: an agent never turns it on"
      hint={error ?? (root
        ? "Applies to this project only: off here, its agents still ask even where another project is on. Secrets are never theirs either way."
        : "No project chosen, so this is the machine-wide value a request that names no project reads. A project with no value of its own is off: open the project to turn it on there. Secrets are never theirs either way.")}
      on={on === true} disabled={on === null} onClick={() => void flip()} />
  );
}
