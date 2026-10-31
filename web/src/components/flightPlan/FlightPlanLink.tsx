import "./flightPlanView.css";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { openFlightPlan } from "../../lib/flightPlanNav.ts";

/** Settings ▸ Agents: a link row, no settings. Flight plan's own are inside its view. */
export function FlightPlanLink({ onGo }: { onGo: () => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { api.settingAtGlobal("flightPlan.enabled").then((r) => setOn(r.ok ? r.value === true : null)).catch(() => {}); }, []);
  return (
    <div className="fp-linkrow" style={{ marginBottom: 12, fontFamily: "inherit" }}>
      <div>
        <div style={{ fontWeight: 650 }}>Flight plan</div>
        <div style={{ color: "var(--text3)", fontSize: 11 }}>A fresh reviewer reads plans before Launch.{on === null ? "" : on ? " On." : " Off."}</div>
      </div>
      <button type="button" className="btn sm" style={{ color: "var(--primary)" }} onClick={() => { onGo(); openFlightPlan(); }}>Open Flight plan →</button>
    </div>
  );
}
