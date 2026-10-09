/*
 * "Back to Terminal · orchestrator-agx", the way back from a view an agent put
 * the person in (lib/agentBack.ts says when it appears).
 *
 * One click returns to the view the person was on and the chip goes; the cross
 * drops it without moving anything. It lives in the agent column of
 * AgentChangeChip.tsx, so it has no portal of its own and cannot overlap the
 * change chip or a held open.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ViewId } from "../../../shared/types.ts";
import { back, backText, live, BACK_MS } from "../lib/agentBack.ts";
import { CloseButton } from "./CloseButton.tsx";
import { HIT } from "../lib/iconSize.ts";
import { VIEWS } from "./workspace/views.ts";
import { AGENT_BTN, AGENT_CARD } from "./AgentOffers.tsx";

const labelOfView = (v: ViewId) => VIEWS.find((x) => x.id === v)?.label ?? v;

/** Whether there is an offer to draw: the column stays mounted for it. */
export function useBackOffer() {
  return useSyncExternalStore(back.subscribe, back.offer, () => null);
}

export function AgentBackChip({ onBack }: { onBack: (v: ViewId) => void }) {
  const o = useBackOffer();
  const at = o?.at;
  useEffect(() => {
    if (at === undefined) return;
    const t = setTimeout(() => back.dismiss(), Math.max(0, BACK_MS - (Date.now() - at)));
    return () => clearTimeout(t);
  }, [at]);
  const shown = live(o, Date.now());
  if (!o || !shown) return null;
  return (
    <div className="relative rounded-xl text-left" data-agent-back={o.from} style={AGENT_CARD} role="status" aria-live="polite">
      <CloseButton onClick={() => back.dismiss()} title="Dismiss" hit={22} style={{ top: 6, right: 7, color: "var(--text4)" }} className="absolute rounded" />
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>
        {o.as || "An agent"} switched the view
      </div>
      <button onClick={() => { back.dismiss(); onBack(o.from); }} className="agx-btn text-[12px] mt-2 px-2.5 rounded-lg font-medium" style={{ ...AGENT_BTN, minHeight: HIT }}>
        {backText(labelOfView(o.from), o.as)}
      </button>
    </div>
  );
}
