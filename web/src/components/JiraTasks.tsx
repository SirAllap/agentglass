/*
 * The card pane of the Jira tab.
 *
 * The list, the rail and the table are the Tasks board's own (TasksPanel.tsx
 * mounts it with `JIRA_BOARD`, lib/jiraBoard.ts); what is Jira's is the card:
 * its facts, and the thread and composer beneath them. Nothing here names a
 * status, a workflow or a project: the words come from the card and the site.
 */
import { useEffect, useState } from "react";
import { fmtAgo } from "../lib/format.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import type { CardPaneProps } from "../lib/boardSource.ts";
import { EDGE, LINE } from "./workspace/Chrome.tsx";
import { TrackerStatusPick } from "./TrackerStatusPick.tsx";
import { TrackerPeoplePick } from "./TrackerPeoplePick.tsx";
import { TrackerHandOffButton } from "./TrackerHandOffButton.tsx";
import { TRACKERS } from "../lib/trackerApi.ts";
import { JiraCard } from "./jira/JiraCard.tsx";
import { JiraCardPrs } from "./jira/JiraCardPrs.tsx";
import { CloseButton } from "./CloseButton.tsx";

/** The card's facts, and the three things that change it here: its status, its person, the hand-off. */
function Facts({ t, writable, onTask }: { t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void }) {
  const url = externalUrl(t.url);
  const [said, setSaid] = useState("");
  const query = t.customId ?? t.id;
  // A said line belongs to the card it was said about.
  useEffect(() => { setSaid(""); }, [t.id]);
  const rows: [string, string | null][] = [
    ["Priority", t.priority],
    ["Project", t.list],
    ["Due", t.due],
    ["Updated", t.updated ? `${fmtAgo(t.updated)} ago` : null],
    ["Labels", t.tags.length ? t.tags.join(", ") : null],
  ];
  return (
    <div className="p-5 flex flex-col gap-3 min-w-0">
      <div className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{t.customId ?? t.id}</div>
      <div className="text-[13px]" style={{ color: "var(--text)" }}>{t.title}</div>
      <dl className="grid gap-x-4 gap-y-1.5 text-[11px] items-center" style={{ gridTemplateColumns: "max-content 1fr" }}>
        <dt style={{ color: "var(--text3)" }}>Status</dt>
        <dd className="min-w-0"><TrackerStatusPick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} /></dd>
        <dt style={{ color: "var(--text3)" }}>Assignee</dt>
        <dd className="min-w-0"><TrackerPeoplePick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} /></dd>
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt style={{ color: "var(--text3)" }}>{k}</dt>
            <dd className="min-w-0 truncate" style={{ color: "var(--text)" }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2 flex-wrap">
        <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />
        {url && (
          <button onClick={() => openExternal(url)} className="self-start text-[10.5px] px-2.5 py-1 rounded-lg" style={{ border: EDGE, color: "var(--text2)" }}>
            Open in Jira ↗
          </button>
        )}
      </div>
      <JiraCardPrs query={query} writable={writable} />
      {said && <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>}
    </div>
  );
}

/** The pane the board opens for a Jira card: facts on top, thread and composer beneath. */
export function JiraCardPane({ t, writable, onTask, nav, onClose }: CardPaneProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {(nav || onClose) && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: LINE }}>
          {nav}
          <span className="flex-1" />
          {onClose && <CloseButton onClick={onClose} title="Close · Esc" />}
        </div>
      )}
      <JiraCard key={t.id} t={t} header={<Facts t={t} writable={writable} onTask={onTask} />} writes={writable} onTask={onTask} />
    </div>
  );
}
