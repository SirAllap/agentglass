import { ICON } from "../../lib/iconSize.ts";
import { openFlightPlan } from "../../lib/flightPlanNav.ts";
import { LINE } from "../workspace/Chrome.tsx";
import { PlaneIcon } from "./fpIcons.tsx";

/** On an open card, beside Copy id: the Flight plan composer opens with this card's text and link copied in. It links to the view, never duplicates it. */
export function StartFlightPlan({ id, title, url }: { id: string; title: string; url: string }) {
  return (
    <button type="button" title="Write a plan for this card and have it read before anything is built"
      onClick={() => openFlightPlan({ compose: { request: `${title}${url ? `\n\n${url}` : ""}`, ...(/^[\w.-]{1,80}$/.test(id) ? { taskId: id } : {}), from: `${id} · card text and links copied in` } })}
      className="text-[10.5px] px-2.5 min-h-[28px] inline-flex items-center gap-1.5 rounded-lg" style={{ border: LINE, color: "var(--text2)" }}>
      <PlaneIcon size={ICON.xs} />Start a flight plan
    </button>
  );
}
