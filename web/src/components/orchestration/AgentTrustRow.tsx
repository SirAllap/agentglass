/*
 * The person's own switch: let agents change settings without asking.
 *
 * Off by default. On, an agent's change to a setting of the escalation class
 * (shared/settingClass.ts) applies without a request card; a secret and this
 * switch itself still never move for an agent. The save carries the desk key
 * (deskGate.ts), and the server takes it only from the person: an agent asking
 * on any route, the request path included, is refused.
 */
import { useEffect, useState } from "react";
import { Toggle } from "../SettingRow.tsx";
import { api } from "../../lib/api.ts";

export function AgentTrustRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.agentsChangeWithoutAsking().then((r) => setOn(r.ok ? r.trusted : false)).catch(() => setOn(false)); }, []);
  const flip = async () => {
    if (on === null) return;
    const r = await api.agentsChangeWithoutAskingSave(!on).catch(() => null);
    if (r?.ok) { setOn(!on); setError(null); } else setError(r?.error ?? "the server did not answer");
  };
  return (
    <Toggle label="Let my agents change settings without asking"
      agentNever="decides whether an agent's risky change waits for the owner at all: an agent never turns it on"
      hint={error ?? "Off: a change that gives agents more power or spends more waits for your Approve. On: it applies at once. Secrets are never theirs either way."}
      on={on === true} disabled={on === null} onClick={() => void flip()} />
  );
}
