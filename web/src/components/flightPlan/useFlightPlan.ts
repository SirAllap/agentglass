import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { toPlan, type Plan, type PlanDetail, type Run } from "../../lib/flightPlan.ts";
import type { BudgetWire } from "../../lib/flightPilot.ts";
import { usePoll } from "../../lib/usePoll.ts";

/*
 * EVERYTHING THE FLIGHT PLAN VIEW READS: the plans, their Preflight runs, the
 * master switch and the project the person is in. Two reads for the lists (the
 * runs carry their certificates, so a plan's findings are not one request each)
 * and nothing on a clock unless something is in flight: while an author is
 * writing a plan or a Preflight is reading, it asks every 5 s and only while the
 * window is looked at (usePoll). Idle, it asks nothing.
 */
export const IN_FLIGHT_MS = 5_000;

export interface FlightData {
  /** null until the first read; false when Flight plan is off. */
  enabled: boolean | null;
  details: PlanDetail[] | null;
  runs: Run[];
  /** The app's Flight plan spend against its caps, as the plans list carries it; null until read. */
  budget: BudgetWire | null;
  root: string;
  projects: string[];
  error: string;
  /** Preflight settings per project, for every project that has a plan and the one the person is in. */
  cfg: Record<string, Cfg>;
  reload: () => void;
  setEnabled: (v: boolean) => void;
  refreshCfg: () => void;
}

/** Whether a project's Preflight reviews the plan before Launch (the engine runs it as soon as the plan has text), and its cost cap. */
export interface Cfg { before: "off" | "auto"; cap: number }
export const DEFAULT_CFG: Cfg = { before: "off", cap: 0.5 };

export function useFlightPlan(active: boolean, selected: string | null): FlightData {
  const [full, setFull] = useState<{ plan: Plan; run: Run | null } | null>(null);
  const [cfg, setCfg] = useState<Record<string, Cfg>>({});
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [budget, setBudget] = useState<BudgetWire | null>(null);
  const [root, setRoot] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [cfgTick, setCfgTick] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    api.projects().then((r) => {
      if (!live.current) return;
      const open = r.workspaces?.length ? r.workspaces : r.workspace ? [r.workspace] : [];
      setProjects(open); setRoot(r.workspace || open[0] || "");
    }).catch(() => {});
  }, []);

  const reload = useCallback(() => {
    Promise.all([api.flightPlans(), api.flightRuns()]).then(([p, r]) => {
      if (!live.current) return;
      if (!p.ok) { setError(p.error ?? "could not read the plans"); return; }
      setError(""); setEnabledState(p.enabled !== false);
      const next = (p.plans ?? []).map(toPlan);
      setPlans(next); setRuns(r.runs ?? []); setBudget(p.budget ?? null);
    }).catch(() => { if (live.current) setError("could not reach the server"); });
  }, []);

  /* The list is read without the plans' text; the open one is read whole. */
  const readFull = useCallback(() => {
    if (!selected) { setFull(null); return; }
    api.flightPlan(selected).then((r) => { if (live.current && r.ok && r.plan) setFull({ plan: { ...toPlan(r.plan), version: r.version }, run: r.run ?? null }); }).catch(() => {});
  }, [selected]);
  const reloadAll = useCallback(() => { reload(); readFull(); }, [reload, readFull]);
  useEffect(() => { if (active) reloadAll(); }, [active, reloadAll]);
  /* Nothing polls while idle, so a server that went away is found when the person comes back to the window. */
  useEffect(() => {
    if (!active) return;
    const back = () => { if (!document.hidden) reloadAll(); };
    window.addEventListener("focus", back); document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [active, reloadAll]);

  const details = useMemo<PlanDetail[] | null>(() => {
    if (!plans) return null;
    const byId = new Map(runs.map((r) => [r.id, r]));
    return plans.map((plan) => {
      const run = plan.preflightRunId ? byId.get(plan.preflightRunId) ?? null : null;
      /* The open plan is read whole, but what the list adds (the builder tab, when it closed, the slots) comes only from the list. */
      const { builder, goneAt, stateSince, slotHolders, stopReason, pilot, held, heldBy, heldAt } = plan;
      return full && full.plan.id === plan.id ? { plan: { ...full.plan, builder, goneAt, stateSince, slotHolders, stopReason, pilot, held, heldBy, heldAt }, run: full.run ?? run } : { plan, run };
    });
  }, [plans, runs, full]);

  const rootsKey = useMemo(() => [...new Set([root, ...(plans ?? []).map((p) => p.root)].filter(Boolean))].sort().join("\n"), [root, plans]);
  useEffect(() => {
    if (!active || !rootsKey) return;
    let dead = false;
    void Promise.all(rootsKey.split("\n").map(async (r) => {
      const [b, c] = await Promise.all([api.settingAt("flightPlan.preflight.reviews", r).catch(() => null), api.settingAt("flightPlan.preflight.costCapUsd", r).catch(() => null)]);
      const before = Array.isArray(b?.value) && b.value.includes("plan") ? "auto" : "off";
      return [r, { before, cap: typeof c?.value === "number" ? c.value : 0.5 } as Cfg] as const;
    })).then((rows) => { if (!dead && live.current) setCfg(Object.fromEntries(rows)); });
    return () => { dead = true; };
  }, [active, rootsKey, cfgTick]);

  /* Something in flight: an author writing, a Preflight reading. */
  const busy = !!details?.some(({ plan, run }) => plan.state === "draft" || run?.state === "running");
  usePoll(active && enabled !== false && busy, reloadAll, IN_FLIGHT_MS);

  const setEnabled = useCallback((v: boolean) => setEnabledState(v), []);
  return { enabled, details, runs, budget, root, projects, error, cfg, reload: reloadAll, setEnabled, refreshCfg: () => setCfgTick((n) => n + 1) };
}
