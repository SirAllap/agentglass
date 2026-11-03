import "./flightPlanView.css";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { openFlightPlan } from "../../lib/flightPlanNav.ts";

/**
 * Settings ▸ Agents: a link, no settings. Flight plan's own are inside its view.
 *
 * A quiet line in the scope row, not a card: it is one link, and a full-width
 * card over the page pushed the drawing and the pane below it off a 720px
 * window. Its state is a word in the line.
 */
export function FlightPlanLink({ onGo }: { onGo: () => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { api.settingAtGlobal("flightPlan.enabled").then((r) => setOn(r.ok ? r.value === true : null)).catch(() => {}); }, []);
  const word = on === null ? "" : on ? "On" : "Off";
  return (
    <span className="agx-flow-fp" data-tip={`Flight plan: a fresh reviewer reads plans before Launch.${word ? ` ${word}.` : ""}`}>
      <span className="agx-flow-fp-k">Flight plan</span>
      {word && <><span className="agx-flow-fp-s" aria-hidden>·</span><span className="agx-flow-fp-s">{word}</span></>}
      <span className="agx-flow-fp-s" aria-hidden>·</span>
      <button type="button" className="agx-flow-fp-go" onClick={() => { onGo(); openFlightPlan(); }}>Open</button>
    </span>
  );
}
