/*
 * The top of a Jira card's pane, and the facts under its tabs.
 *
 * `JiraHead` is what stays put above the tabs: the action bar, the chip row and
 * the title, in the pieces the ClickUp card is drawn from (CardChrome.tsx).
 * `JiraProps` is the card tab's first block: a framed band (status, priority,
 * parent) and two columns of label-above-value, as ClickUp draws them.
 *
 * Status, assignee and the hand-off change the card, so they are controls only
 * when this app may write to Jira; without that switch they are plain, and one
 * sentence says why, here, once. The thread's composer and the pull request box
 * stay silent then, or the same sentence would be on screen three times.
 * Priority, sprint, points, due, labels, parent and project are read from the
 * site and shown as read (the board's `caps` say editing them is not offered).
 * A field the card does not have is not drawn at all, never drawn empty.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fmtAgo } from "../../lib/format.ts";
import { openCard } from "../../lib/openCard.ts";
import { Flag, CardFace, prioLook } from "../../lib/priority.tsx";
import { TRACKERS } from "../../lib/trackerApi.ts";
import type { ProviderTask } from "../../../../shared/providers.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";
import { TrackerStatusPick } from "../TrackerStatusPick.tsx";
import { TrackerPeoplePick } from "../TrackerPeoplePick.tsx";
import { TrackerHandOffButton } from "../TrackerHandOffButton.tsx";
import { CardActionBar, CardBand, CardBandField, CardChips, CardField, CardTitle, EYEBROW, useCopied } from "../CardChrome.tsx";

export const WRITES_OFF = "Changes to Jira are switched off, so this card is read-only here. Turn on “Changes in Jira” in the Jira settings.";

/** The line a pick says after it ran: a leading `!` is a warning. */
function Said({ said }: { said: string }) {
  if (!said) return null;
  return <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>;
}

/** The facts under the band, in the order they are read; one the card does not have is not a row. Zero points is an answer, an unset field is not. */
export function propsOf(t: ProviderTask): [string, ReactNode][] {
  const rows: [string, ReactNode | null][] = [
    ["Sprint", t.sprint ? <span style={{ color: "var(--info-ink)" }}>{t.sprint}</span> : null],
    ["Points", typeof t.points === "number" ? <span className="tabular-nums" style={{ color: "var(--text2)" }}>{t.points}</span> : null],
    ["Due", t.due ? <span style={{ color: "var(--text2)" }}>{t.due}</span> : null],
    ["Project", t.list ? <span style={{ color: "var(--text2)" }}>{t.list}</span> : null],
    ["Last moved", t.updated ? <span style={{ color: "var(--text3)" }} title={new Date(t.updated).toLocaleString()}>{fmtAgo(t.updated)}</span> : null],
  ];
  return rows.filter((r): r is [string, ReactNode] => !!r[1]);
}

/** Project, then the epic or parent when the card has one: where the card sits, as ClickUp's breadcrumb says it. */
export function Crumbs({ t }: { t: ProviderTask }) {
  const parts = [t.list, t.parent ? `${t.parent.key}${t.parent.title ? ` ${t.parent.title}` : ""}` : null].filter((x): x is string => !!x);
  if (!parts.length) return null;
  return (
    <div className="flex items-center gap-1 min-w-0 text-[10px]" title={parts.join("  /  ")} aria-label="Where this card sits">
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span aria-hidden style={{ color: "var(--text4)", opacity: 0.7 }}>/</span>}
          <span className="truncate" style={{ color: i === parts.length - 1 ? "var(--text2)" : "var(--text4)" }}>{p}</span>
        </span>
      ))}
    </div>
  );
}

/** What stays above the tabs: the actions, the key chips and the title. */
export function JiraHead({ t, writable, onTask, onRefresh, refreshing }: {
  t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void;
  onRefresh?: () => void; refreshing?: boolean;
}) {
  const key = t.customId ?? t.id;
  const [copied, copy] = useCopied();
  const [said, setSaid] = useState("");
  // A said line belongs to the card it was said about.
  useEffect(() => { setSaid(""); }, [t.id]);
  return (
    <div className="px-4 pt-4 pb-2 flex flex-col gap-2 min-w-0">
      <CardActionBar id={key} url={t.url} copied={copied} onCopy={(v, w) => void copy(v, w)}
        onRefresh={onRefresh ?? (() => undefined)} refreshing={!!refreshing}
        handoff={writable ? <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} /> : undefined} />
      <Said said={said} />
      <CardChips id={key} copied={copied} onCopy={(v, w) => void copy(v, w)} mine={t.mine}
        extra={t.customId && t.customId !== t.id ? <span className="text-[10px] px-1.5 py-0.5 rounded-md leading-[1.35] tabular-nums" style={{ color: "var(--text4)", border: EDGE }} title="Jira's own id for this card">{t.id}</span> : undefined} />
      <CardTitle title={t.title} copied={copied} onCopy={(v, w) => void copy(v, w)} />
    </div>
  );
}

/** The card tab's properties: the framed band, then the two columns. */
export function JiraProps({ t, writable, onTask }: { t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void }) {
  const query = t.customId ?? t.id;
  const [said, setSaid] = useState("");
  useEffect(() => { setSaid(""); }, [t.id]);
  const person = t.people?.[0];
  const rest = propsOf(t);
  return (
    <div className="flex flex-col gap-3 min-w-0 mb-4">
      <Crumbs t={t} />
      <CardBand>
        <CardBandField label="status">
          {writable
            ? <TrackerStatusPick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />
            : <Select value={t.status} disabled title="Status" className="text-left rounded" onChange={() => undefined}
                options={[{ value: t.status, label: t.status, pill: true, tint: t.statusColor, dim: t.statusKind === "done" }]} />}
        </CardBandField>
        {t.priority && (
          <CardBandField label="priority">
            <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: prioLook(t.priority).c }} title="Priority is read from Jira; changing it is not offered here.">
              <Flag c={prioLook(t.priority).c} on />{prioLook(t.priority).label}
            </span>
          </CardBandField>
        )}
        {t.parent && (
          <CardBandField label="parent">
            <button onClick={() => openCard(t.parent!.key, t.parent!.key, "jira")} title={`Open ${t.parent.key}`}
              className="agx-btn text-[10.5px] px-2 py-0.5 rounded-lg block truncate text-left"
              style={{ color: "var(--primary-ink)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>
              <span className="tabular-nums">{t.parent.key}</span>{t.parent.title ? ` ${t.parent.title}` : ""}
            </button>
          </CardBandField>
        )}
      </CardBand>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 12px" }}>
        <CardField label="Assigned">
          {writable
            ? <TrackerPeoplePick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />
            : (
              <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: t.mine ? "var(--success)" : "var(--text2)" }}>
                {person && <CardFace p={{ name: person.name, initials: person.initials, color: person.color, avatar: person.avatar, me: person.me }} size={18} />}
                <span className="min-w-0 truncate">{t.mine ? "you" : (t.assignees.join(", ") || "nobody")}</span>
              </span>
            )}
        </CardField>
        {rest.map(([k, v]) => <CardField key={k} label={k}>{v}</CardField>)}
      </div>
      {!!t.tags.length && (
        <div className="flex items-center gap-1.5 flex-wrap" aria-label="Labels">
          <span className={EYEBROW} style={{ color: "var(--text4)" }}>labels</span>
          {t.tags.map((x) => (
            <span key={x} className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>{x}</span>
          ))}
        </div>
      )}
      {!writable && <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{WRITES_OFF}</div>}
      <Said said={said} />
    </div>
  );
}
