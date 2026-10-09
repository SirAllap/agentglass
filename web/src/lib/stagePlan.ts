/**
 * What the pull request panel does with a staged request, decided from the
 * request and the loaded pull request and nothing else.
 *
 * Pure on purpose: no network, no store, no dialog. The panel runs the answer
 * through the dialogs it already has, so the answer here is only "open this
 * one, filled in like so" or the sentence for why not. A staged dialog opens
 * on a pull request only where the button for the same act would be live (an
 * open pull request GitHub will merge, a review of somebody else's), because
 * a door that skipped the screen's own conditions would be a way round them.
 */
import { allowedMethods } from "../../../shared/mergeMethod.ts";
import { githubWillMerge } from "../../../shared/mergeReason.ts";
import { mergeBlockers, mergeRefusal } from "../../../shared/mergeBlockers.ts";
import type { PrDetail } from "../../../shared/types.ts";
import type { StageRequest } from "./stageIntent.ts";

export type StagePlan =
  | { ok: true; request: StageRequest }
  | { ok: false; why: string };

const no = (why: string): StagePlan => ({ ok: false, why });

export function planStage(req: StageRequest, d: PrDetail): StagePlan {
  const n = req.a.number;
  if (d.state !== "OPEN") return no(`#${n} is not open, so there is nothing to ${verbOf(req)}`);
  switch (req.id) {
    case "pr.merge.stage":
      if (!githubWillMerge(d.mergeState)) return no(`#${n} is not mergeable right now (${d.mergeState.toLowerCase().replace(/_/g, " ")}), so the merge dialog is not offered`);
      {
        // What greys the merge button on the screen (a lock, a missing permission, a
        // draft, a conflict), asked the way the Overview asks it. A branch that is
        // only behind is left to the button's own confirmation, so it is not staged.
        const why = mergeRefusal(mergeBlockers({
          ...d, openThreads: (d.threads ?? []).filter((t) => !t.isResolved).length, conflicted: d.mergeable === "CONFLICTING",
        }), d.mergeState);
        if (why) return no(`#${n} cannot be merged from here: ${why.title}`);
      }
      if (!allowedMethods(d.mergePolicy).includes(req.a.method)) return no(`this repository does not allow "${req.a.method}" merges`);
      return { ok: true, request: req };
    case "pr.review.stage":
      if (d.viewerDidAuthor) return no("you cannot review your own pull request");
      return { ok: true, request: req };
    default:
      return { ok: true, request: req };
  }
}

function verbOf(req: StageRequest): string {
  return req.id === "pr.merge.stage" ? "merge" : req.id === "pr.review.stage" ? "review" : req.id === "pr.comment.stage" ? "comment on" : "move";
}
