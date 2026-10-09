/*
 * "An agent wants to show you X", for an open that was held because you were
 * typing (lib/agentOffers.ts says when).
 *
 * A column of small cards, one per held open, drawn inside the corner the
 * change chip already owns (AgentChangeChip.tsx) so the two never stack on
 * top of each other: this file has no Portal of its own. Nothing here takes
 * focus or moves; the button is the only thing that opens anything, and the
 * cross drops the offer without running it.
 */
import { useSyncExternalStore } from "react";
import { offers, type Offer } from "../lib/agentOffers.ts";
import { offerText } from "../lib/quietPresent.ts";
import { CloseButton } from "./CloseButton.tsx";
import { HIT } from "../lib/iconSize.ts";
import { EDGE } from "./workspace/Chrome.tsx";

export function AgentOffer({ o, onShow, onDismiss }: { o: Offer; onShow: () => void; onDismiss: () => void }) {
  return (
    <div className="relative rounded-xl text-left" data-agent-offer={o.key}
      style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "0 12px 34px #000a", padding: "10px 36px 10px 14px" }}
      role="status" aria-live="polite">
      <CloseButton onClick={onDismiss} title="Dismiss" hit={22} style={{ top: 6, right: 7, color: "var(--text4)" }} className="absolute rounded" />
      <div className="text-[12.5px] font-semibold" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{offerText(o.as, o.label)}</div>
      <button onClick={onShow} className="agx-btn text-[12px] mt-2 px-2.5 rounded-lg"
        style={{ border: EDGE, color: "var(--text2)", minHeight: HIT }}>
        Show me
      </button>
    </div>
  );
}

/** Oldest first, so the newest sits nearest the corner. Renders nothing when empty. */
export function AgentOffersList() {
  const list = useSyncExternalStore(offers.subscribe, offers.list, () => []);
  return (
    <>
      {list.map((o) => <AgentOffer key={o.key} o={o} onShow={() => offers.accept(o.key)} onDismiss={() => offers.dismiss(o.key)} />)}
    </>
  );
}
