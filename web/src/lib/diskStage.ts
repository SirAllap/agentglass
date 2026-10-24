/*
 * What the machine panel does with a disk cleanup an agent staged
 * (diskclean.stage): take it off the mailbox, keep the lines the scan it is
 * showing calls safe, and say which it dropped and why.
 *
 * The door checks only the spelling of the ids (shared/uiActions.ts); whether a
 * line may go is the scan's verdict, read here from the lines the panel holds,
 * and again by the server's run route on the person's press. The agent that staged
 * the lines is shown as a name it chose itself. Nothing in this file touches the
 * network; web/test/ui-stage-guard.test.ts holds it to that.
 *
 * The mailbox forgets a request after STAGE_TTL_MS, so the panel copies the plan
 * into its own state the moment it has one and clears the mailbox then.
 */
import { useSyncExternalStore } from "react";
import { diskStageIds } from "../../../shared/uiActions.ts";
import type { DiskCleanLine } from "../../../shared/types.ts";
import { clearStage, peekStage, subscribeStage, type StageRequest } from "./stageIntent.ts";

export type DiskStageRequest = Extract<StageRequest, { id: "diskclean.stage" }>;

/** The request if it is a disk cleanup one: the mailbox is shared with the pull request panel and the Finder. */
export const diskStageOf = (r: StageRequest | null): DiskStageRequest | null => (r?.id === "diskclean.stage" ? r : null);

/** The staged request, while the mailbox holds it; null for none or another screen's. */
export function useDiskStage(): DiskStageRequest | null {
  return diskStageOf(useSyncExternalStore(subscribeStage, peekStage, () => null));
}

/** Empty the mailbox, but only of a disk request: a pull request's or the Finder's is not this screen's to clear. */
export function clearDiskStage(): void {
  if (diskStageOf(peekStage())) clearStage();
}

/**
 * Does a staged request need the cached scan fetched for it? Once per request
 * number: a scan that fails leaves `scanning` false and the report empty, and
 * without `triedFor` the panel's effect read that as "still nothing to show" and
 * asked again, back to back, until the mailbox forgot the request. The person's
 * own Scan button is the way to try again.
 */
export const needsStageScan = (req: { n: number }, triedFor: number | null, scanning: boolean): boolean => !scanning && triedFor !== req.n;

export interface DiskStagePlan {
  /** The staged lines the scan calls safe and that have something to remove, in the order they were named. */
  ids: string[];
  /** What they add up to (an unmeasured line counts for nothing). */
  bytes: number;
  /** The rest, each with the reason in plain words. */
  dropped: { id: string; why: string }[];
  /** The name the caller gave itself, and the request's number: a new request is a new plan. */
  by: string;
  n: number;
}

const REASON: Record<DiskCleanLine["verdict"], string> = {
  inuse: "it is in use",
  ask: "it needs a look from you first and is not part of the plan",
  explain: "it is shown for information and is never removed",
  safe: "it has nothing to remove",
};

/** The staged ids against the lines of the scan on screen. */
export function planDiskStage(req: DiskStageRequest, lines: readonly DiskCleanLine[]): DiskStagePlan {
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  const plan: DiskStagePlan = { ids: [], bytes: 0, dropped: [], by: req.by, n: req.n };
  for (const id of diskStageIds(req.a.ids) ?? []) {
    const line = byId.get(id);
    if (!line) plan.dropped.push({ id, why: "it is not in the scan any more" });
    else if (line.verdict !== "safe" || line.target === null) plan.dropped.push({ id, why: REASON[line.verdict] });
    else { plan.ids.push(id); plan.bytes += line.bytes ?? 0; }
  }
  return plan;
}
