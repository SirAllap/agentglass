/*
 * The Flow screens' one reader of the board's rows, through D4's selectors.
 *
 * Subscribed `fast` (5 s rather than 20 s) for as long as one of these screens
 * is mounted, which is exactly the moment "right now" is the question. No
 * request of its own: the Lantern's store is the app's single poller of
 * `/agents/board`.
 *
 * `counts` is null until the board has answered once, because "0 running" and
 * "not read yet" are different answers, and a card that printed the first for
 * the second would be calm about nothing happening — except after a first read
 * that failed, where the store keeps an empty board and counts read zero, not
 * null (`lanternKnown()` separates the two and this hook does not read it). It
 * is null with no project chosen too: a flow belongs to one project, so there
 * is no one count to print.
 */
import { useSyncExternalStore } from "react";
import type { Flow } from "../../../shared/flow.ts";
import { inFlight, lastDecision, liveByRole, type LastDecision, type RoleCounts } from "./flowLive.ts";
import { lanternRows, subscribeLantern } from "./lanternStore.ts";

const subscribe = (l: () => void) => subscribeLantern(l, true);

export interface FlowLive {
  /** One entry per role of the flow's roster; null before the first read. */
  counts: Record<string, RoleCounts> | null;
  inFlight: { n: number; of: number } | null;
  last: LastDecision | null;
}

export function useRoleCounts(flow: Flow, project: string, limits: { maxWorkers: number }): FlowLive {
  const rows = useSyncExternalStore(subscribe, lanternRows, lanternRows);
  if (!rows || !project) return { counts: null, inFlight: null, last: null };
  const counts = liveByRole(rows, flow, project);
  return { counts, inFlight: inFlight(counts, limits), last: lastDecision(rows, flow, project) };
}
