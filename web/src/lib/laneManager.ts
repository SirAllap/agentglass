import { useEffect } from "react";
import type { BrowserAskFrame } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { clientId, setLaneAskHandler } from "./browserBus.ts";
import { loadProfiles } from "./browserProfiles.ts";
import { CAN_MAKE_LANES, closeLaneWindow, keepLaneWindows, openLaneWindow } from "./desktop.ts";

/**
 * The container slug a new lane's window is given: what `&p=` in its hash
 * says, and so which cookie jar its webview attaches on.
 *
 *   private  the lane's own id, so the jar is its alone (the app wipes it on close)
 *   shared   "", the person's own container
 *   named    the id of a container `profiles` lists, found by name
 *
 * A name nobody made is an error and is not made here: minting a container is
 * the Browser panel's, and one written from behind its back would be
 * overwritten by the panel's next save.
 */
export function laneSlug(
  id: string, container: unknown, name: unknown, profiles: ReadonlyArray<{ id: string; name: string }>,
): { slug: string } | { error: string } {
  if (container === "shared") return { slug: "" };
  if (container === "named") {
    const hit = typeof name === "string" ? profiles.find((p) => p.name === name || p.id === name) : undefined;
    return hit && hit.id ? { slug: hit.id } : { error: `no container called ${String(name)} — \`profiles\` lists them` };
  }
  return { slug: id };
}

async function serveLaneAsk(ask: BrowserAskFrame): Promise<void> {
  let reply: { ok: boolean; error?: string };
  if (typeof ask.args.make === "string") {
    let store: Storage | null = null;
    try { store = window.localStorage; } catch { /* blocked */ }
    const chosen = laneSlug(ask.args.make, ask.args.container, ask.args.name, loadProfiles(store));
    reply = "error" in chosen ? { ok: false, error: chosen.error } : await openLaneWindow(ask.args.make, chosen.slug);
  } else if (typeof ask.args.drop === "string") {
    reply = await closeLaneWindow(ask.args.drop);
  } else {
    reply = { ok: false, error: "a lane ask names a lane to make or to drop" };
  }
  try { await api.browserResult({ client: clientId(), id: ask.id, ...reply }); } catch { /* the ask has already timed out */ }
}

/**
 * This window offers to make lane hosts, for as long as it is up. A heartbeat
 * with a TTL on the server, like a panel's: a window that dies without saying
 * goodbye stops being asked.
 */
export function useLaneManager(): void {
  useEffect(() => {
    if (!CAN_MAKE_LANES) return;
    setLaneAskHandler((ask) => { void serveLaneAsk(ask); });
    const me = clientId();
    const beat = () => {
      void api.browserManager(me, true).then((r) => { if (Array.isArray(r.lanes)) void keepLaneWindows(r.lanes); })
        .catch(() => { /* the server is restarting */ });
    };
    beat();
    const timer = setInterval(beat, 30_000);
    return () => {
      clearInterval(timer);
      setLaneAskHandler(null);
      void api.browserManager(me, false).catch(() => { /* leaving anyway */ });
    };
  }, []);
}
