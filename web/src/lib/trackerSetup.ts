/*
 * Which card trackers are connected here, and what their card ids look like.
 *
 * The one place a surface asks "is this machine ClickUp, Jira, both or
 * neither" before it decides whether `ORBIT-1042` means anything. ClickUp's
 * answer is `clickupSetup()` untouched; Jira's is read from `/jira/status`,
 * which the server answers from its own store and a project list it remembers
 * for ten minutes, so asking is not a call to Jira each time.
 *
 * A tracker is present in the answer only when it is connected. Unknown is not
 * "none": a read that failed is left out of the answer and is not kept, so the
 * next ask tries again instead of hiding a card link for a minute.
 *
 * `useClickupSetup` is not replaced and nothing that calls it changes.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { clickupSetup } from "./clickupSetup.ts";

export interface TrackerSetup {
  clickup?: { connected: true; prefix?: string };
  /** `prefixes` are the project keys this account can see: a site has many. */
  jira?: { connected: true; prefixes: string[]; site: string };
}

const TTL = 60_000;
let held: { at: number; value: TrackerSetup["jira"] | null } | null = null;
let inflight: Promise<TrackerSetup["jira"] | null> | null = null;

async function jiraSetup(): Promise<TrackerSetup["jira"] | null> {
  if (held && Date.now() - held.at < TTL) return held.value;
  inflight ??= api.jiraStatus()
    .then((s) => {
      const value = s.connected && s.site ? { connected: true as const, prefixes: s.prefixes ?? [], site: s.site } : null;
      held = { at: Date.now(), value };
      return value;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

export async function trackerSetup(): Promise<TrackerSetup> {
  const [cu, jira] = await Promise.all([clickupSetup(), jiraSetup()]);
  return {
    ...(cu.connected ? { clickup: { connected: true as const, prefix: cu.prefix } } : null),
    ...(jira ? { jira } : null),
  };
}

/** Null until the answer is in, so a chip does not flash on and then off. */
export function useTrackerSetup(): TrackerSetup | null {
  const [setup, setSetup] = useState<TrackerSetup | null>(null);
  useEffect(() => {
    let live = true;
    void trackerSetup().then((v) => { if (live) setSetup(v); });
    return () => { live = false; };
  }, []);
  return setup;
}

/** For a test's own teardown, and for the moment Jira is connected or dropped. */
export function __forgetTrackerSetup(): void { held = null; }
