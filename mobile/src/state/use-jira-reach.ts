/*
 * The connected Jira site's project keys and host, on the phone.
 *
 * `shared/taskref.ts` can only take `ORBIT-1042` out of a branch when it is
 * told which projects the site has: without that list the same string is a
 * ClickUp custom id, and the chip would send a Jira shop to a ClickUp board
 * that has never heard of it. The desk reads this from `/jira/status`, so the
 * phone asks the same route rather than keeping a second idea of what a key is.
 *
 * Held for a minute and keyed by origin, like `useProviders`: the answer
 * changes when somebody connects a site at their computer, which is about
 * twice, and a failure is not cached because an unreachable machine must not
 * take a card away for the next minute.
 */
import { useEffect, useState } from "react";
import type { JiraStatus } from "../../../shared/providers.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import type { JiraReach } from "../../../shared/taskref.ts";

const TTL = 60_000;
let held: { at: number; origin: string; value: JiraReach | null } | null = null;
let inflight: Promise<JiraReach | null> | null = null;

const fresh = (origin: string): JiraReach | null | undefined =>
  (held && held.origin === origin && Date.now() - held.at < TTL ? held.value : undefined);

/** For a test, and for the moment a site is connected. */
export function forgetJiraReach(): void { held = null; inflight = null; }

/** Null when the machine answered that no site is connected, or could not be asked. */
export function useJiraReach(host: Host | null): JiraReach | null {
  const origin = host?.origin ?? "";
  const [value, setValue] = useState<JiraReach | null>(() => fresh(origin) ?? null);

  useEffect(() => {
    if (!host) return;
    const now = fresh(host.origin);
    if (now !== undefined) { setValue(now); return; }
    let live = true;
    inflight ??= ask<JiraStatus>(host, "/jira/status")
      .then((answer) => {
        const s = answer.ok ? answer.value : null;
        const got = s && s.connected && s.site ? { keys: s.prefixes ?? [], site: s.site } : null;
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
