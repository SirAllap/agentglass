// The landing page's head-up display flies the same eight sessions this build
// shows, and on the landing page the demo is literally behind the glass — an
// iframe under the lens. Two pictures of one fleet, a few hundred pixels apart,
// so they had better carry the same numbers: symbology reading $17.76 over a
// card reading $4.30 is the kind of detail that costs a visitor their trust in
// everything else on the page.
//
// So the demo publishes what it knows on `window`, and the landing reads it
// through the (same-origin) frame. Demo builds only: there is nothing here to
// leak, but a real fleet is nobody's business but its owner's, and a global is
// exactly the wrong place for it.
//
// The landing tolerates the absence of this entirely — an older /demo/ build,
// a slow frame, a browser that blocked it — and falls back to flying its own
// simulation. Nothing here may become load-bearing.
import { IS_DEMO } from "./demo.ts";
import type { AgentCard } from "./derive.ts";
import { modelLabelOf } from "./format.ts";

export interface BeyondSession {
  /** `source_app:session_id`, the same key the fleet cards are titled with. */
  key: string;
  app: string;
  model: string;
  status: string;
  /** What it is doing right now, as the card says it. */
  action: string;
  tools: number;
  cost: number;
  tokens: number;
  /** Context used against this model's window, 0..1 — the radar's own law. */
  ctx: number;
}
export interface BeyondFleet {
  v: 1;
  spend: number;
  sessions: BeyondSession[];
}

export function publishFleet(agents: AgentCard[], spend: number) {
  if (!IS_DEMO) return;
  const payload: BeyondFleet = {
    v: 1,
    spend,
    sessions: agents.map((a) => ({
      key: a.key,
      app: a.source_app,
      model: modelLabelOf(a.model_name),
      status: a.status,
      action: a.lastAction,
      tools: a.tools,
      cost: a.cost,
      tokens: a.tokens,
      ctx: a.ctxLimit > 0 ? Math.min(1, a.ctxTokens / a.ctxLimit) : 0,
    })),
  };
  (window as unknown as { __agxFleet?: BeyondFleet }).__agxFleet = payload;
}
