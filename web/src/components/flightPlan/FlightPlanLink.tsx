import "./flightPlanView.css";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { openFlightPlan } from "../../lib/flightPlanNav.ts";
import { flightPlanLine } from "../../lib/flightProjects.ts";
import { PROJECT_ON } from "./usePilotFeed.ts";

/**
 * Settings ▸ Agents: a link, no settings. Flight plan's own are inside its view.
 *
 * A quiet line in the scope row, not a card: it is one link, and a full-width
 * card over the page pushed the drawing and the pane below it off a 720px
 * window. Its state is a word in the line.
 *
 * The word is about the scope on screen: the app's switch alone said On for a
 * project the person had left out, and a start there was refused.
 */
export function FlightPlanLink({ root, onGo }: { root: string; onGo: () => void }) {
  const [master, setMaster] = useState<boolean | null>(null);
  const [project, setProject] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setProject(null);
    void api.settingAtGlobal("flightPlan.enabled").then((r) => { if (live) setMaster(r.ok ? r.value === true : null); }).catch(() => {});
    // The project's switch is read at the project; All projects has none of its own.
    if (root) void api.settingAt(PROJECT_ON, root).then((r) => { if (live) setProject(r.ok ? r.value !== false : null); }).catch(() => {});
    return () => { live = false; };
  }, [root]);
  const { word, tip } = flightPlanLine({ master, project, root });
  return (
    <span className="agx-flow-fp" data-tip={tip}>
      <span className="agx-flow-fp-k">Flight plan</span>
      {word && <><span className="agx-flow-fp-s" aria-hidden>·</span><span className="agx-flow-fp-s">{word}</span></>}
      <span className="agx-flow-fp-s" aria-hidden>·</span>
      <button type="button" className="agx-flow-fp-go" onClick={() => { onGo(); openFlightPlan(); }}>Open</button>
    </span>
  );
}
