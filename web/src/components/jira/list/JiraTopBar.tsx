/*
 * The mockup's identity row: the sprint chip at the left (with no active sprint: the next planned one, or the board's
 * kind), then the view tabs, then Workflow at the right (how fresh the read is lives in the footer, once). One row, so this renders only its
 * own slice of it (`side`) - JiraListView interleaves it with JiraTabs's strip and its single flex-1 spacer, rather
 * than stacking two full-width bars. Workflow opens the Jira page of Settings.
 */
import { sprintTotals, splitSprint } from "../../../lib/jiraBoardContext.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { tipAttr } from "../../../lib/tip.ts";
import type { JiraListModel } from "./model.ts";
import { sprintTab } from "./tabsModel.ts";
import { noSprintChip, showNoSprintChip, sprintChip } from "./toolbarModel.ts";

export function JiraTopBar({ model, areaId, side }: { model: JiraListModel; areaId?: string | null; side: "left" | "right" }) {
  const sprint = model.sprint && !(areaId && !areaId.startsWith("@")) ? model.sprint : undefined;
  const tab = sprintTab(sprint, Date.now());
  const chip = sprint ? sprintChip(sprint, Date.now(), sprintTotals(splitSprint(model.cards, sprint.name).inSprint, model.statuses)) : null;
  const none = tab || !showNoSprintChip(!!model.context, !!areaId) ? null : noSprintChip(model.context?.next, model.context?.boardType);
  if (side === "right") {
    return (
      <>
        <button type="button" className="agx-jm-btn" onClick={() => openSettings("jira")} data-tip={tipAttr("The statuses and steps of the workflow, in Settings")}>Workflow</button>
      </>
    );
  }
  if (!tab && !none) return null;
  return (
    <span className="agx-jm-sprint tabular-nums shrink-0" data-testid="jira-sprint" {...(tab ? { "data-late": tab.late ? "" : undefined } : { "data-empty": "" })}
      data-tip={tipAttr(chip ? chip.tip : none!.tip)}>
      {tab ? tab.label : none!.label}
    </span>
  );
}
