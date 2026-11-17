/*
 * What "Open live worker" does. The plan that launched the worker knows its tmux window, so that tab is brought to the front. A
 * worker started by hand has no such record: its tab is looked for by the session's title in the session's folder (a tab is
 * named after its title), and only when none answers does the Terminal come forward for the person to find it by name.
 */
import { openLiveWindow } from "../../../lib/liveWindow.ts";
import { api } from "../../../lib/api.ts";
import { requestWorktreeJump } from "../../../lib/worktreeJump.ts";
import type { Plan } from "../../../lib/flightPlan.ts";
import { openFlightPlan } from "../../../lib/flightPlanNav.ts";
import { openPr, openPrs, prRefFromUrl } from "../../../lib/openPrs.ts";
import type { CardWork } from "./useCardLifecycle.ts";

export function openLive(plan: Pick<Plan, "launched"> | null, tab?: { title: string; cwd?: string | null | undefined } | null): void {
  const l = plan?.launched;
  if (l?.session && l.window) { void openLiveWindow({ session: l.session, windowId: l.window, paneId: "", name: l.branch ?? "", path: l.worktree ?? "" }); return; }
  const cwd = tab?.cwd;
  if (!tab?.title || !cwd) { requestWorktreeJump({ view: "term" }); return; }
  void api.tmuxLiveWindow(cwd, tab.title, cwd)
    .then((r) => { if (r.ok && r.window) void openLiveWindow(r.window); else requestWorktreeJump({ view: "term" }); })
    .catch(() => requestWorktreeJump({ view: "term" }));
}

/** Bring the card's pull request forward in the PR panel. */
export function openCardPr(pr: { url: string; number: number; state: string }): void {
  const ref = prRefFromUrl(pr.url);
  if (ref) openPr(ref.repo, pr.number); else openPrs(String(pr.number), pr.state === "OPEN" ? "open" : "all");
}

/** The lifecycle's next step, run: the worker's tab, the plan, the pull request, or (with nothing running) the send the caller owns. */
export function runNext(work: Pick<CardWork, "life" | "plans" | "pr"> & { worker?: CardWork["worker"] }, send: () => void): void {
  const { life, plans, pr } = work;
  const k = life.next.kind;
  if (k === "open-worker") openLive(plans[0] ?? null, work.worker);
  else if (k === "open-plan") openFlightPlan(plans[0] ? { plan: plans[0].id } : {});
  else if (k === "open-pr" && pr) openCardPr(pr);
  else if (k === "send") send();
}
