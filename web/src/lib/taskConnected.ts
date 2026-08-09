/*
 * Which task sources are actually set up on this machine.
 *
 * The Tasks view used to offer all three whatever you had, and the reason was
 * written down and was a good one: an unconnected tab says what to do and links
 * to the pane that does it, and a tab you only find after finding Settings is a
 * feature nobody discovers.
 *
 * It is a good argument that stops being true at a specific moment — the moment
 * you have connected something. Before that, the bar is the only advertisement
 * there is, and a fresh install should carry all of it. After that, you have
 * demonstrably found the Integrations pane, and a permanent tab for a tracker
 * you have never used is somebody else's product in the middle of yours.
 *
 * So the rule is not "hide what is not connected". It is:
 *
 *   nothing set up at all   show everything — this is a fresh install and the
 *                           bar is where the features live
 *   something set up        show what is set up, and let Integrations do the
 *                           advertising it is already there to do
 *
 * The precedent is in the repo. GitLab has a row in Integrations and no tab
 * anywhere, and nobody has ever called it hidden.
 *
 * A source that is set up and BROKEN stays on the bar. "ClickUp refused this
 * token" is not the same as "you do not use ClickUp", and hiding the tab would
 * take away the one surface that was going to tell you.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { TASK_SOURCES, type TaskSourceId } from "./taskSources.ts";
import type { ProviderId, ProviderState } from "../../../shared/providers.ts";

/** The Tasks view's names for things, and `/providers`' names for the same
 *  things. Kept as data because the two vocabularies genuinely differ: the tab
 *  says "Local" because that is what it is to you, the provider is called
 *  Taskwarrior because that is what it is. */
const PROVIDER_OF: Record<TaskSourceId, ProviderId> = {
  github: "github",
  local: "taskwarrior",
  clickup: "clickup",
};

/**
 * Whether a provider counts as "this person uses this".
 *
 * `connected` is the plain yes. `error` counts too, and deliberately: a token
 * that has been refused, or a workspace that timed out, is a thing you set up
 * and that is failing — the tab has to survive so it can carry the bad news.
 *
 * The two that mean no are the two that mean nobody ever did anything:
 * `missing-tool` (the CLI is not installed) and `needs-auth` (installed, never
 * signed in).
 */
const setUp = (state: ProviderState): boolean => state === "connected" || state === "error";

export type TaskConnected = Record<TaskSourceId, boolean>;

const ALL_ON = (): TaskConnected =>
  Object.fromEntries(TASK_SOURCES.map((s) => [s.id, true])) as TaskConnected;

const TTL = 60_000;
let held: { at: number; value: TaskConnected } | null = null;
let inflight: Promise<TaskConnected> | null = null;

const fresh = (): TaskConnected | null => (held && Date.now() - held.at < TTL ? held.value : null);

export function taskConnected(): Promise<TaskConnected> {
  const now = fresh();
  if (now) return Promise.resolve(now);
  // One read for however many callers arrive while it is in the air, and a
  // failure is not cached: the server being down for a moment must not take
  // somebody's tabs away for the next minute.
  inflight ??= api.providers()
    .then((r) => {
      const by = new Map(r.providers.map((p) => [p.id, p.state]));
      const value = Object.fromEntries(
        TASK_SOURCES.map((s) => {
          const state = by.get(PROVIDER_OF[s.id]);
          // A provider the server did not mention is unknown, not absent —
          // shown, because taking a tab away on a missing answer is the one
          // failure mode with no way back for the person looking at it.
          return [s.id, state === undefined || setUp(state)];
        }),
      ) as TaskConnected;
      held = { at: Date.now(), value };
      return value;
    })
    .catch(() => ALL_ON())
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * The bar's own question: given what is set up, which of these may be shown.
 *
 * This is where the fresh-install rule lives, and it is applied here rather
 * than in the fetch so that the fetch keeps meaning exactly one thing. Nothing
 * set up means the answer is everything — see the header.
 *
 * `shown` is the preference, already ordered and filtered. Its ORDER is
 * preserved: this only ever removes.
 */
export function visibleTaskSources(shown: TaskSourceId[], connected: TaskConnected | null): TaskSourceId[] {
  // Not known yet. Showing the preference unchanged is what stops the bar
  // rearranging itself a beat after it is drawn.
  if (!connected) return shown;
  const live = shown.filter((id) => connected[id]);
  return live.length ? live : shown;
}

/** Null until the answer is in, which is what keeps the bar from flickering on
 *  a machine that has only one of these. */
export function useTaskConnected(): TaskConnected | null {
  const [value, setValue] = useState<TaskConnected | null>(fresh);
  useEffect(() => {
    let live = true;
    void taskConnected().then((v) => { if (live) setValue(v); });
    return () => { live = false; };
  }, []);
  return value;
}

/** For a test's own teardown, and for the moment a provider is connected. */
export function __forgetTaskConnected(): void { held = null; }
