/*
 * The card pane of the Jira tab.
 *
 * The list, the rail and the table are the Tasks board's own (TasksPanel.tsx
 * mounts it with `JIRA_BOARD`, lib/jiraBoard.ts); what is Jira's is the card:
 * its facts, its tabs, and the thread and composer beneath them. Nothing here names a
 * status, a workflow or a project: the words come from the card and the site.
 */
import type { CardPaneProps } from "../lib/boardSource.ts";
import { JiraCard } from "./jira/JiraCard.tsx";
import { JiraHead } from "./jira/JiraFacts.tsx";

/** The pane the board opens for a Jira card: facts on top, thread and composer beneath. */
export function JiraCardPane({ t, writable, onTask, nav, onClose, onAllow }: CardPaneProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <JiraCard key={t.id} t={t} header={(r) => <JiraHead t={t} writable={writable} onTask={onTask} onRefresh={r.onRefresh} refreshing={r.refreshing} ed={r.ed} follow={r.follow} nav={nav} onClose={onClose} />} writes={writable} onTask={onTask} onAllow={onAllow} />
    </div>
  );
}
