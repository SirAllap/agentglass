/*
 * The plan quota, on its own clock.
 *
 * Deliberately NOT part of the fleet load in host-context. That load is the
 * queue, it runs off the live socket's doorbell and it fires every twenty
 * seconds while the app is in front of somebody; the quota is a five-hour
 * window and a weekly one, and asking about those on the queue's cadence would
 * be a request every twenty seconds to learn a number that moves in percents
 * per hour.
 *
 * The cadence is also not ours alone to choose. The server caches its Anthropic
 * reading for fifteen minutes because that endpoint rate-limits per account and
 * limits hard, and it is shared with every Claude Code session on the machine.
 * Five minutes here means the phone is never the reason the desk gets a 429: it
 * mostly reads a cached answer, and it costs one small request.
 *
 * A failure keeps the last good rows. A phone loses the network constantly, and
 * a card that blanked on the walk to the kitchen would say "no quota" when what
 * happened is "no wifi", which the age line under the number already tells the
 * truth about.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { ProviderUsage } from "../../../shared/types.ts";
import { ask, REVOKED } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { useAgentglass } from "./host-context.tsx";

/** Slower than the queue and faster than the server's own TTL, so a reading is
 *  at worst a poll behind rather than a cache behind. */
const POLL_MS = 5 * 60_000;

export interface PlanUsage {
  /** Null until an answer has landed. Never blanked by a later failure. */
  rows: ProviderUsage[] | null;
  /** True once one attempt has finished, succeeded or not. It is what tells
   *  "still asking" apart from "asked, and could not reach the computer". */
  loaded: boolean;
  /** Why the last attempt failed, when it did, for a line under the card. */
  error: string | null;
  /** When the last successful answer landed here, epoch ms. Distinct from a
   *  row's own `observedAt`, which is when the PROVIDER was asked. */
  at: number;
  reload: () => void;
}

export function useUsage(): PlanUsage {
  const { host } = useAgentglass();
  const [rows, setRows] = useState<ProviderUsage[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  // The same guard the fleet load uses: an answer that was already overtaken
  // must not land on top of a newer one.
  const generation = useRef(0);

  const load = useCallback(async (which: Host): Promise<void> => {
    const mine = ++generation.current;
    const answer = await ask<ProviderUsage[]>(which, "/usage/providers");
    if (mine !== generation.current) return;
    setLoaded(true);
    if (!answer.ok) {
      // A revoked credential is not this card's business to report. The fleet
      // load sees the same 401, drops the host and lands on the pairing screen,
      // and "revoked" written under a quota bar on the way out is noise.
      setError(answer.error === REVOKED ? null : answer.error);
      return;
    }
    // Checked for being a list even though the type says it is: this runs
    // against whatever answered, and an older build on the other end predates
    // this route entirely.
    setRows(Array.isArray(answer.value) ? answer.value : []);
    setError(null);
    setAt(Date.now());
  }, []);

  const reload = useCallback((): void => {
    if (host) void load(host);
  }, [host, load]);

  useEffect(() => {
    if (!host) {
      // Pairing to a different computer means a different plan. Anything held
      // from the old one is now a claim about a machine this phone is no longer
      // talking to.
      setRows(null);
      setLoaded(false);
      setError(null);
      setAt(0);
      return;
    }

    void load(host);
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer) return;
      timer = setInterval(() => { void load(host); }, POLL_MS);
    };
    const stop = (): void => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    // Asked again on the way in, because the interval does not run in the
    // background and a phone that has been in a pocket for an hour is holding a
    // number from before lunch.
    const onChange = (state: AppStateStatus): void => {
      if (state === "active") { void load(host); start(); } else stop();
    };

    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", onChange);
    return () => { stop(); sub.remove(); };
  }, [host, load]);

  return { rows, loaded, error, at, reload };
}
