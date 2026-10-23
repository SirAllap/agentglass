/*
 * The facts at the top of a Jira card's pane, and what changes them.
 *
 * Status, assignee and the hand-off change the card, so they are drawn only
 * when this app may write to Jira; without that switch they are plain text and
 * one sentence says why, here, once. The thread's composer and the pull request
 * box stay silent then, or the same sentence would be on screen three times.
 * Sprint, points, priority, due, labels, parent and project are read from the
 * site and shown as read; editing them is not offered (the board's `caps` say
 * so for the table, and the pane follows).
 */
import { useEffect, useState } from "react";
import { fmtAgo } from "../../lib/format.ts";
import { externalUrl, openExternal } from "../../lib/externalUrl.ts";
import { openCard } from "../../lib/openCard.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import type { ProviderTask } from "../../../../shared/providers.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import { TrackerStatusPick } from "../TrackerStatusPick.tsx";
import { TrackerPeoplePick } from "../TrackerPeoplePick.tsx";
import { TrackerHandOffButton } from "../TrackerHandOffButton.tsx";

export const WRITES_OFF = "Changes to Jira are switched off, so this card is read-only here. Turn on “Changes in Jira” in the Jira settings.";

/** What the card says about itself beyond its status and person, in the order it is read; a fact the card does not have is not a row. */
export function factsOf(t: ProviderTask): [string, string][] {
  const rows: [string, string | null][] = [
    ["Sprint", t.sprint || null],
    // Zero is an answer; an unset field is not.
    ["Points", typeof t.points === "number" ? String(t.points) : null],
    ["Priority", t.priority],
    ["Due", t.due],
    ["Labels", t.tags.length ? t.tags.join(", ") : null],
    ["Project", t.list],
    ["Updated", t.updated ? `${fmtAgo(t.updated)} ago` : null],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}

/** The card's facts, and the three things that change it here: its status, its person, the hand-off. */
export function JiraFacts({ t, writable, onTask }: { t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void }) {
  const url = externalUrl(t.url);
  const [said, setSaid] = useState("");
  const query = t.customId ?? t.id;
  // A said line belongs to the card it was said about.
  useEffect(() => { setSaid(""); }, [t.id]);
  return (
    <div className="p-5 flex flex-col gap-3 min-w-0">
      <div className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{t.customId ?? t.id}</div>
      <div className="text-[13px]" style={{ color: "var(--text)" }}>{t.title}</div>
      <dl className="grid gap-x-4 gap-y-1.5 text-[11px] items-center" style={{ gridTemplateColumns: "max-content 1fr" }}>
        <dt style={{ color: "var(--text3)" }}>Status</dt>
        <dd className="min-w-0">
          {writable
            ? <TrackerStatusPick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />
            : <span style={{ color: "var(--text)" }}>{t.status}</span>}
        </dd>
        <dt style={{ color: "var(--text3)" }}>Assignee</dt>
        <dd className="min-w-0">
          {writable
            ? <TrackerPeoplePick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />
            : <span style={{ color: "var(--text)" }}>{t.assignees.join(", ") || "Unassigned"}</span>}
        </dd>
        {factsOf(t).map(([k, v]) => (
          <div key={k} className="contents">
            <dt style={{ color: "var(--text3)" }}>{k}</dt>
            <dd className="min-w-0 truncate" style={{ color: "var(--text)" }}>{v}</dd>
          </div>
        ))}
        {t.parent && (
          <>
            <dt style={{ color: "var(--text3)" }}>Parent</dt>
            <dd className="min-w-0 truncate">
              <button onClick={() => openCard(t.parent!.key, t.parent!.key, "jira")} title={`Open ${t.parent.key}`}
                className="agx-btn text-left max-w-full truncate" style={{ color: "var(--text)" }}>
                <span className="tabular-nums" style={{ color: "var(--text3)" }}>{t.parent.key}</span>{t.parent.title ? ` ${t.parent.title}` : ""}
              </button>
            </dd>
          </>
        )}
      </dl>
      <div className="flex items-center gap-2 flex-wrap">
        {writable && <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />}
        {url && (
          <button onClick={() => openExternal(url)} className="self-start text-[10.5px] px-2.5 py-1 rounded-lg" style={{ border: EDGE, color: "var(--text2)" }}>
            Open in Jira ↗
          </button>
        )}
      </div>
      {!writable && <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{WRITES_OFF}</div>}
      {said && <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>}
    </div>
  );
}
