import { useEffect, useMemo, useState } from "react";
import type { LaneRow, LaneTab } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { laneTabs } from "./desktop.ts";

/**
 * Agents' lanes as the person's Browser pane shows them.
 *
 * A lane is an agent's own offscreen window (server/src/lanes.ts, electron
 * main's lane hosts), so its tab is not one of the pane's tabs. The server
 * pushes the lane rows on the live socket whenever one opens, closes or starts
 * working (`lanes` frame); Electron main says what page each lane is on. The
 * overview draws one box per lane next to the containers, and a card in it
 * opens the live view (LaneWatch.tsx).
 */

/** The same window as the server's LANE_BUSY_MS: a lane asked of within it is "working". */
export const LANE_BUSY_MS = 10_000;

/** One lane's box in the overview. */
export interface IslandLane {
  id: string;
  /** "Vault lane · Zen — Ubuntu", or "Lane · <container>", or "Lane". */
  name: string;
  /** Who opened it, as the agent named itself. */
  agent: string;
  busy: boolean;
  title: string;
  url: string;
}

/** The box's name. A vault lane says which box it was signed in from, by the name Settings shows. */
export function laneBoxName(r: Pick<LaneRow, "vault" | "name" | "container">): string {
  if (r.vault) return `Vault lane · ${r.vault}`;
  if (r.container === "named" && r.name) return `Lane · ${r.name}`;
  return "Lane";
}

export const laneAgent = (r: Pick<LaneRow, "as">): string => r.as?.trim() || "An agent";
export const laneBusy = (r: Pick<LaneRow, "lastAsk">, now: number): boolean => now - r.lastAsk < LANE_BUSY_MS;

export function islandLanes(rows: readonly LaneRow[], tabs: readonly LaneTab[], now: number): IslandLane[] {
  const page = new Map(tabs.map((t) => [t.id, t]));
  return rows.map((r) => ({
    id: r.id, name: laneBoxName(r), agent: laneAgent(r), busy: laneBusy(r, now),
    title: page.get(r.id)?.title ?? "", url: page.get(r.id)?.url ?? "",
  }));
}

/**
 * The overview's one sentence, with lanes counted like containers: a lane is
 * one container, one tab and one agent, and a working lane is a working agent.
 */
export function overviewCounts(
  c: { agents: readonly string[]; busy: readonly string[]; containers: number; tabs: number },
  lanes: readonly IslandLane[],
): { agents: number; busy: number; containers: number; tabs: number } {
  const agents = new Set(c.agents);
  const busy = new Set(c.busy);
  for (const l of lanes) {
    /* A lane with no --as is "An agent" by name only: each such lane is its own. */
    const who = l.agent === laneAgent({}) ? `lane:${l.id}` : l.agent;
    agents.add(who); if (l.busy) busy.add(who);
  }
  return { agents: agents.size, busy: busy.size, containers: c.containers + lanes.length, tabs: c.tabs + lanes.length };
}

/** When the soonest working lane stops counting as working, in ms from now; null if none is. */
export function nextQuiet(rows: readonly LaneRow[], now: number): number | null {
  const left = rows.filter((r) => laneBusy(r, now)).map((r) => r.lastAsk + LANE_BUSY_MS - now);
  return left.length ? Math.max(0, Math.min(...left)) : null;
}

type Sub = (rows: LaneRow[], show?: string) => void;
let current: LaneRow[] = [];
const subs = new Set<Sub>();

/** The server's `lanes` frame (useLive). */
export function publishLanes(d: { lanes: LaneRow[]; show?: string }): void {
  current = Array.isArray(d.lanes) ? d.lanes : [];
  for (const fn of subs) fn(current, d.show);
}
export function subscribeLanes(fn: Sub): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/**
 * The lanes for the overview, and the lane an agent last asked to bring
 * forward (`onShow`). Pushed, never polled: one read on mount, then frames;
 * one timer to the moment the soonest working lane goes quiet.
 */
export function useIslandLanes(onShow: (id: string) => void): IslandLane[] {
  const [rows, setRows] = useState<LaneRow[]>(current);
  const [tabs, setTabs] = useState<LaneTab[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const off = subscribeLanes((r, show) => { setRows(r); setNow(Date.now()); if (show) onShow(show); });
    void api.browserLanes().then((r) => { if (Array.isArray(r.lanes)) { current = r.lanes; setRows(r.lanes); setNow(Date.now()); } }, () => { /* the server is restarting */ });
    return off;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!rows.length) { setTabs([]); return; }
    let live = true;
    void laneTabs().then((t) => { if (live) setTabs(t); });
    return () => { live = false; };
  }, [rows, now]);
  useEffect(() => {
    const wait = nextQuiet(rows, now);
    if (wait === null) return;
    const t = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(t);
  }, [rows, now]);
  return useMemo(() => islandLanes(rows, tabs, now), [rows, tabs, now]);
}
