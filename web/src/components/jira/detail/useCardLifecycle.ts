/*
 * The detail panel's read of one card's lifecycle: the stores the app already feeds (the fleet, the pull request search, the checks
 * readings) plus one read of the flight plans and their review runs, joined by lib/cardLifecycle.ts. Nothing here asks Jira.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CardEvent, ProviderTask } from "../../../../../shared/providers.ts";
import { api } from "../../../lib/api.ts";
import { planOf } from "../../../../../shared/stepBlocks.ts";
import { NO_ASSIGN } from "../../../lib/stepAssign.ts";
import { useJiraSteps } from "../../../lib/jiraStepUi.ts";
import { cardLifecycle, type Lifecycle, type SessionLite } from "../../../lib/cardLifecycle.ts";
import { cardPrsOf, cardPrVersion, onCardPrs } from "../../../lib/cardPrStore.ts";
import { pickCardPr, type CardPr } from "../../../lib/cardPrPick.ts";
import { toPlan, type Plan, type Run } from "../../../lib/flightPlan.ts";
import { cardChecksVersion, checksForUrl, fleetNow, onCardChecks, onFleet, sessionsFor, workerFor, rootFor, nowLine, type CardWorker } from "../../../lib/jiraCardWork.ts";
import { useMinuteNow } from "../../../lib/visibleInterval.ts";
import { useViewActive } from "../../../lib/viewActive.ts";

export interface CardWork {
  life: Lifecycle;
  /** Every session that names the card, live or ended. */
  sessions: SessionLite[];
  worker: CardWorker | null;
  /** The plan that built or builds this card, the newest first; empty when the card has none. */
  plans: Plan[];
  pr: CardPr | null;
  /** A checkout the card's work happens in, for Send to terminal; null when nothing names one. */
  root: string | null;
}

export function useCardLifecycle(key: string, task: ProviderTask, moves: readonly CardEvent[] | undefined): CardWork {
  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  useSyncExternalStore(onCardPrs, cardPrVersion, cardPrVersion);
  useSyncExternalStore(onCardChecks, cardChecksVersion, cardChecksVersion);

  const steps = useJiraSteps()?.steps;
  const qaStatuses = useMemo(() => (steps?.handoff.enabled ? planOf<string | number>("move", { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: steps.handoff.blocks }).move?.names ?? [] : []), [steps]);

  // Every mounted card ticked while its board sat behind another view.
  const now = useMinuteNow(useViewActive());

  const [plans, setPlans] = useState<Plan[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    let on = true;
    setPlans([]); setRuns([]);
    const same = (a: string | null | undefined) => !!a && a.toLowerCase() === key.toLowerCase();
    void Promise.all([api.flightPlans().catch(() => null), api.flightRuns().catch(() => null)]).then(([p, r]) => {
      if (!on) return;
      const mine = (p?.ok && p.plans ? p.plans.map((x) => toPlan(x)) : []).filter((x) => same(x.taskId) || same(x.launched?.ticket));
      setPlans(mine.sort((a, b) => b.createdAt - a.createdAt));
      setRuns((r?.ok && r.runs ? r.runs : []).filter((x) => same(x.taskId)));
    });
    return () => { on = false; };
  }, [key]);

  const prs = cardPrsOf(task.id, key, "", "", "jira")?.prs;
  const pick = pickCardPr(prs);
  const pr = pick.kind === "one" ? pick.pr : pick.kind === "many" ? pick.primary : null;
  const checks = pr ? checksForUrl(pr.url) : null;

  return useMemo(() => {
    const mine = sessionsFor(key, agents);
    const live = workerFor(key, agents);
    const sessions: SessionLite[] = mine.map((a) => ({ sessionId: a.session_id, title: a.title || a.source_app, status: a.status, cost: a.cost, model: a.model_name, lastSeen: a.lastSeen, live: live?.sessionId === a.session_id, cwd: a.cwd, tools: a.tools, errors: a.errors, doing: nowLine(a.lastAction) }));
    const life = cardLifecycle({
      now, status: task.status, statusKind: task.statusKind, qaStatuses, moves: moves ?? [], plans, runs, sessions,
      pr: pr ? { number: pr.number, state: pr.state, draft: pr.draft, url: pr.url } : null,
      checks: checks ? { ...checks.checks, at: checks.at } : null,
    });
    const root = plans[0]?.root ?? rootFor(key, mine);
    return { life, sessions, worker: live, plans, pr, root };
  }, [key, agents, now, task.status, task.statusKind, qaStatuses, moves, plans, runs, pr, checks]);
}
