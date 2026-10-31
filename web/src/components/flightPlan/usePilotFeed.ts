import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { budgetOf, pilotSnapshot, seatName, type BudgetWire, type PilotSnapshot } from "../../lib/flightPilot.ts";
import { PILOT_KEYS } from "../../lib/pilotSettings.ts";

/*
 * WHAT THE ENGINE SAYS ABOUT FLYING, for one project: its mode and hold (settings
 * at the project), who sits in the chair, and the spend against the caps (read
 * with the plans list, so the view passes it in). Questions and the facts of each
 * flight ride on the plans themselves (lib/flightPilot.ts flightItems).
 * Without the budget `engine` is false and the strip says "not read" instead of $0.00.
 */
export interface PilotFeed {
  snap: PilotSnapshot;
  /** False until the spend was read: the snapshot then holds the defaults. */
  engine: boolean;
  /** Read again now. */
  read: () => void;
}

/** Before anything was read: Co-pilot (the engine default), no hold, a seat assumed, no spend. */
export const BLANK = pilotSnapshot({ pilot: "copilot", held: false, budget: null, seat: "" });

/** One project's mode, hold and seat with the app's spend: three reads, none of which can fail the other two. */
/** What one project's reading holds. */
export interface Feed { snap: PilotSnapshot; engine: boolean; on: boolean }
export const PROJECT_ON = "flightPlan.project.enabled";

export async function readFeed(root: string, budget: BudgetWire | null): Promise<Feed> {
  const [p, h, c, o] = await Promise.all([
    api.settingAt(PILOT_KEYS.pilot.id, root).catch(() => null), api.settingAt("flightPlan.held", root).catch(() => null), api.seat(root).catch(() => null),
    api.settingAt(PROJECT_ON, root).catch(() => null),
  ]);
  /* A project is in Flight plan unless the person left it out; a read that failed does not leave it out. */
  return { snap: pilotSnapshot({ pilot: p?.ok ? p.value : undefined, held: h?.ok ? h.value : undefined, budget, seat: seatName(c) }), engine: budgetOf(budget) !== null, on: !(o?.ok && o.value === false) };
}

/**
 * The same reading for every project in scope at once, keyed by root. The
 * budget is the app's (its caps are app settings), so every project's meters
 * show the same spend; only the mode, the hold and the seat differ.
 */
export function usePilotRoster(active: boolean, roots: string[], on: boolean, budget: BudgetWire | null): { feeds: Record<string, Feed>; read: () => void } {
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const live = useRef(true);
  const reads = useRef(0);
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const key = roots.join("\n");
  const read = useCallback(() => {
    const list = key ? key.split("\n") : [];
    const n = ++reads.current;
    void Promise.all(list.map(async (r) => [r, await readFeed(r, budgetRef.current)] as const)).then((rows) => {
      if (live.current && n === reads.current) setFeeds(Object.fromEntries(rows));
    });
  }, [key]);
  const spendKey = budget ? `${budget.dayUsd}/${budget.weekUsd}/${budget.dailyCap}/${budget.weeklyCap}/${budget.reached}` : "";
  useEffect(() => { if (active && on) read(); }, [active, on, read, spendKey]);
  return { feeds, read };
}

export function usePilotFeed(active: boolean, root: string, on: boolean, budget: BudgetWire | null): PilotFeed {
  const [snap, setSnap] = useState<PilotSnapshot>(BLANK);
  const [engine, setEngine] = useState(false);
  const live = useRef(true);
  const reads = useRef(0);
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const read = useCallback(() => {
    if (!root) return;
    const n = ++reads.current;
    void readFeed(root, budgetRef.current).then((f) => {
      if (!live.current || n !== reads.current) return;
      setSnap(f.snap); setEngine(f.engine);
    });
  }, [root]);

  /* The spend arrives with the plans list: a new reading of it is a new snapshot. */
  const spendKey = budget ? `${budget.dayUsd}/${budget.weekUsd}/${budget.dailyCap}/${budget.weeklyCap}/${budget.reached}` : "";
  useEffect(() => { if (active && on) read(); }, [active, on, read, spendKey]);
  return { snap, engine, read };
}
