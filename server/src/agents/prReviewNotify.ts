/*
 * Setting `flow.notifyPrReviews` (off by default, per project): a bot review
 * change on an open pull request is told to the project's orchestrator seat —
 * the same `promptSeat` channel a worker's own ending takes (workerend.ts).
 *
 * Event-driven, off the triggers that already fire on real news
 * (`subscribeBotReview` for the default GitHub-bot case; `subscribeTalk` as a
 * catch-all recheck, since a login this project only ADDED to the extra list
 * shows up as a person's review, not a bot's, and so raises no bot event of
 * its own). Both read the list from cache — no request of their own.
 */
import { workspaceRoots } from "../config.ts";
import { getSetting } from "../preflightStore.ts";
import { listPrs } from "../prs.ts";
import { repoIdFor, noteBotReview, type PrBotReview } from "../prs.ts";
import { sessionFor } from "../polaris.ts";
import { promptSeat } from "../seatwake.ts";

/** Settings ▸ Orchestration ▸ Notify worker of PR reviews, for this project. */
export function prReviewNotifySetting(root: string): { on: boolean; extraBots: string[] } {
  const raw = String(getSetting(root, "flow.notifyPrReviews.bots") ?? "");
  return {
    on: getSetting(root, "flow.notifyPrReviews") === true,
    extraBots: raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
  };
}

/** One line: who reviewed, which pull request, and the worker on its branch when there is one. */
function line(n: PrBotReview, who: string | null): string {
  const say = `#${n.number} ${n.title} was reviewed by ${n.who}: ${n.url}`;
  return who ? `${say} (${who} is on its branch)` : say;
}

export interface NotifyDeps {
  repoOf?: typeof repoIdFor;
  list?: typeof listPrs;
  session?: typeof sessionFor;
  send?: (root: string, text: string) => Promise<unknown>;
}

/**
 * Re-check one project's open pull requests for a bot review change, and tell
 * its seat. Does nothing when the setting is off, or the project has no
 * GitHub remote.
 */
export async function checkPrReviewNotify(root: string, deps: NotifyDeps = {}): Promise<void> {
  const { on, extraBots } = prReviewNotifySetting(root);
  if (!on) return;
  const repo = await (deps.repoOf ?? repoIdFor)(root);
  if (!repo) return;
  const list = await (deps.list ?? listPrs)(root, "all", "open");
  if (!list.repo) return;
  for (const pr of list.prs) {
    const found = noteBotReview(root, pr, extraBots);
    if (!found) continue;
    const pane = await (deps.session ?? sessionFor)(root, pr.number).catch(() => null);
    await (deps.send ?? promptSeat)(root, line(found, pane ? "a worker" : null));
  }
}

/** Every open project whose GitHub remote matches, re-checked once. Same
 *  shape as `polaris.ts` `wakeForRepo`, injectable for the same reason. */
export async function checkPrReviewNotifyForRepo(
  nameWithOwner: string,
  d: { roots: () => string[]; repoOf: (root: string) => Promise<{ nameWithOwner: string } | null>; check: (root: string) => Promise<void> } =
    { roots: workspaceRoots, repoOf: repoIdFor, check: checkPrReviewNotify },
): Promise<void> {
  for (const root of d.roots()) {
    const repo = await d.repoOf(root).catch(() => null);
    if (repo?.nameWithOwner === nameWithOwner) await d.check(root).catch(() => {});
  }
}
