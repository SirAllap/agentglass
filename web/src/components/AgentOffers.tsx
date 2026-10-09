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
import { useSyncExternalStore, type CSSProperties } from "react";
import { offers, type Offer } from "../lib/agentOffers.ts";
import { offerText } from "../lib/quietPresent.ts";
import { CloseButton } from "./CloseButton.tsx";
import { HIT } from "../lib/iconSize.ts";
import { tintEdge } from "./workspace/Chrome.tsx";

/**
 * The card every agent chip is drawn on, so the three (a held open, a changed
 * setting, the way back) read as one family and none is the small grey box that
 * went unseen: the primary tint the update card's button already uses on the
 * border, a heavier lift, and a short entrance (index.css, still under reduced
 * motion).
 */
export const AGENT_CARD: CSSProperties = {
  background: "var(--surface-card)",
  border: tintEdge("var(--primary)", 48),
  boxShadow: "0 0 0 3px color-mix(in srgb, var(--primary) 14%, transparent), 0 12px 34px #000a",
  padding: "12px 36px 12px 14px",
  animation: "agx-chip-in 180ms ease-out both",
};

/** The one action on a chip: the update card's call-to-action tint, so it reads as the thing to press. */
export const AGENT_BTN: CSSProperties = {
  background: "color-mix(in srgb, var(--primary) 18%, transparent)",
  border: tintEdge("var(--primary)", 48),
  color: "var(--text)", minHeight: HIT,
};

export function AgentOffer({ o, onShow, onDismiss }: { o: Offer; onShow: () => void; onDismiss: () => void }) {
  return (
    <div className="relative rounded-xl text-left" data-agent-offer={o.key}
      style={AGENT_CARD}
      role="status" aria-live="polite">
      <CloseButton onClick={onDismiss} title="Dismiss" hit={22} style={{ top: 6, right: 7, color: "var(--text4)" }} className="absolute rounded" />
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{offerText(o.as, o.label)}</div>
      <button onClick={onShow} className="agx-btn text-[12px] mt-2 px-2.5 rounded-lg font-medium" style={AGENT_BTN}>
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
