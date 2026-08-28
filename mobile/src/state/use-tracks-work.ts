/*
 * One answer to "does this machine track work anywhere", shared by everything
 * that asks.
 *
 * The bar mounts on every screen in the app, so this cannot be a fetch inside
 * a component: that would be one request per navigation, forever, for an
 * answer that changes when somebody connects a provider at their computer —
 * which is to say, about twice.
 *
 * So it is a module-level cache with a hook over it, the shape
 * `web/src/lib/taskConnected.ts` already uses at the desk. Held for a minute
 * rather than forever, because connecting a provider should reach the phone
 * without restarting the app; a failure is deliberately NOT cached, because
 * the machine being unreachable for a moment must not take somebody's tab away
 * for the next minute.
 */
import { useEffect, useState } from "react";
import type { ProviderStatus } from "../../../shared/providers.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { tracksWork } from "../model/taskProviders.ts";

const TTL = 60_000;
let held: { at: number; origin: string; value: boolean | null } | null = null;
let inflight: Promise<boolean | null> | null = null;

/** Keyed by origin as well as time: pairing this phone to a second machine
 *  must not carry the first one's answer over, and the two genuinely differ —
 *  that is the whole point of the question. */
const fresh = (origin: string): boolean | null | undefined =>
  (held && held.origin === origin && Date.now() - held.at < TTL ? held.value : undefined);

/** For a test, and for the moment a provider is connected. */
export function forgetTracksWork(): void { held = null; inflight = null; }

export function useTracksWork(host: Host | null): boolean | null {
  const origin = host?.origin ?? "";
  const [value, setValue] = useState<boolean | null>(() => fresh(origin) ?? null);

  useEffect(() => {
    if (!host) return;
    const now = fresh(host.origin);
    if (now !== undefined) { setValue(now); return; }
    let live = true;
    inflight ??= ask<{ providers?: ProviderStatus[] }>(host, "/providers")
      .then((answer) => {
        // Not an answer is not "no". `tracksWork` treats null as unknown and
        // the bar draws everything on unknown, which is the direction with a
        // way back: a spare tab is recoverable, a missing one is not.
        const got = answer.ok ? tracksWork(answer.value.providers) : null;
        held = { at: Date.now(), origin: host.origin, value: got };
        return got;
      })
      .catch(() => null)
      .finally(() => { inflight = null; });
    void inflight.then((got) => { if (live) setValue(got); });
    return () => { live = false; };
  }, [host, origin]);

  return value;
}
