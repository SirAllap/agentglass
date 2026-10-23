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
 * Priority, due and start date, labels, parent, the flag, the estimates and the
 * title are controls only for what the card's own edit screen offers (`ed.edit`,
 * read from the site's editmeta) and only while writing is on; otherwise they
 * are read as before. Sprint, points and project are always read. A field the
 * card does not have is not drawn at all, never drawn empty, unless the screen
 * offers it, and then it is the invitation to fill it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { dayToMs, msToDay } from "../../lib/cardEdits.ts";
import { canEdit, parseEstimate, parseParent, parseTitle, priorityOptions, stepFor } from "../../lib/jiraEdit.ts";
import { fmtAgo } from "../../lib/format.ts";
import { openCard } from "../../lib/openCard.ts";
import { Flag, CardFace, prioLook } from "../../lib/priority.tsx";
import { TRACKERS } from "../../lib/trackerApi.ts";
import type { CardFact, ProviderTask } from "../../../../shared/providers.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";
import { TrackerStatusPick } from "../TrackerStatusPick.tsx";
import { TrackerPeoplePick } from "../TrackerPeoplePick.tsx";
import { TrackerHandOffButton } from "../TrackerHandOffButton.tsx";
import { TypeMark } from "./JiraSections.tsx";
import { EditDay, EditText, PriorityMenu, TagEditor } from "../tasks/CardEdit.tsx";
import type { JiraEditUi } from "./useJiraEdit.ts";
import type { JiraFollowUi } from "./useJiraFollow.ts";
import { JiraFollow } from "./JiraFollow.tsx";
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
export function JiraHead({ t, writable, onTask, onRefresh, refreshing, ed, follow }: {
  t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void;
  onRefresh?: () => void; refreshing?: boolean;
  /** Watching and voting, with what the last press said; absent until the card is read. */
  follow?: JiraFollowUi;
  /** What the card lets a person change; absent until the card is read, and where writing is off. */
  ed?: JiraEditUi;
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
        marks={follow ? <JiraFollow ui={follow} writes={writable} cardKey={key} /> : undefined}
        handoff={writable ? <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} /> : undefined} />
      <Said said={follow?.said || said} />
      <CardChips id={key} copied={copied} onCopy={(v, w) => void copy(v, w)} mine={t.mine}
        extra={t.customId && t.customId !== t.id ? <span className="text-[10px] px-1.5 py-0.5 rounded-md leading-[1.35] tabular-nums" style={{ color: "var(--text4)", border: EDGE }} title="Jira's own id for this card">{t.id}</span> : undefined} />
      <CardTitle title={t.title} copied={copied} onCopy={(v, w) => void copy(v, w)}>
        {writable && ed && canEdit(ed.edit, "summary")
          ? <EditText value={t.title} empty="Untitled" title="Rename this card" wrap textClass="text-[13px] font-semibold leading-snug hover:underline decoration-dotted underline-offset-4" busy={ed.busy === "summary"}
              parse={parseTitle} onSave={(raw) => { const s = stepFor("summary", { value: raw }, ed.now); if (s) ed.run(s); }} />
          : undefined}
      </CardTitle>
    </div>
  );
}

/** The card tab's properties: the framed band, then the two columns. */
/**
 * One Detail as a value: a person with a face, the flag in its own colour, an
 * empty one as "None". The site decided which Details exist (see
 * server/src/jiraCardRead.ts), so nothing here chooses rows.
 */
export function FactValue({ f }: { f: CardFact }) {
  if (!f.value) return <span style={{ color: "var(--text4)" }}>None</span>;
  if (f.id === "reporter") {
    return (
      <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: "var(--text2)" }}>
        <CardFace p={{ name: f.value, initials: f.initials ?? "?", avatar: f.avatar }} size={18} />
        <span className="min-w-0 truncate">{f.value}</span>
      </span>
    );
  }
  if (f.id === "type") return <span className="inline-flex items-center gap-1.5" style={{ color: "var(--text2)" }}><TypeMark type={f.value} />{f.value}</span>;
  if (f.tone === "flag") return <span className="inline-flex items-center gap-1.5" style={{ color: "var(--error-ink)" }}><Flag c="var(--error)" on />{f.value}</span>;
  return <span style={{ color: "var(--text2)" }}>{f.value}</span>;
}

/** The flag as a control: the state in words, and the one move that changes it. */
function FlagToggle({ f, ed }: { f: CardFact; ed: JiraEditUi }) {
  const on = f.tone === "flag";
  const busy = ed.busy === "flag";
  return (
    <span className="inline-flex items-center gap-x-2 gap-y-1 min-w-0 flex-wrap">
      <FactValue f={f} />
      <button className="agx-btn rounded text-[10.5px] px-1.5 py-0.5 whitespace-nowrap shrink-0" disabled={busy}
        style={{ color: "var(--text3)", border: EDGE }}
        title={on ? "Take the flag off this card" : "Flag this card as blocked"}
        onClick={() => { const s = stepFor("flag", { value: !on }, ed.now); if (s) ed.run(s); }}>
        {busy ? "Saving…" : on ? "Remove flag" : "Add flag"}
      </button>
    </span>
  );
}

/** A Detail that can be typed over, or picked: the control for the row's `field`, or the plain value. */
function FactControl({ f, ed }: { f: CardFact; ed?: JiraEditUi }) {
  if (!ed || !f.field || !canEdit(ed.edit, f.field)) return <FactValue f={f} />;
  const busy = ed.busy === f.field;
  if (f.field === "flag") return <FlagToggle f={f} ed={ed} />;
  if (f.field === "start") {
    return <EditDay value={dayToMs(f.raw ?? "")} busy={busy} title="Set the start date"
      onSave={(ms) => { const s = stepFor("start", { value: ms == null ? null : msToDay(ms) }, ed.now); if (s) ed.run(s); }} />;
  }
  if (f.field === "originalEstimate" || f.field === "remainingEstimate") {
    return <EditText value={f.raw ?? ""} empty="Add an estimate" title={`Change the ${f.label.toLowerCase()}, like 2h 30m`} busy={busy} parse={parseEstimate}
      onSave={(raw) => { const s = stepFor(f.field!, { value: raw }, ed.now); if (s) ed.run(s); }} />;
  }
  return <FactValue f={f} />;
}

/** The card's labels with the two things a label needs: taking one off and adding one, by name. */
function LabelEdit({ t, ed }: { t: ProviderTask; ed: JiraEditUi }) {
  const [names, setNames] = useState<string[]>([]);
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  return (
    <div className="flex items-center gap-1.5 flex-wrap" aria-label="Labels">
      <span className={EYEBROW} style={{ color: "var(--text4)" }}>labels</span>
      <TagEditor tags={t.tags} noun="label" suggestions={names} busy={ed.busy === "labels"}
        onOpen={() => { void api.jiraLabels("").then((r) => { if (!gone.current && r.ok && r.labels) setNames(r.labels); }).catch(() => undefined); }}
        onAdd={(name) => { const s = stepFor("labels", { add: name }, ed.now); if (s) ed.run(s); }}
        onRemove={(name) => { const s = stepFor("labels", { remove: name }, ed.now); if (s) ed.run(s); }} />
    </div>
  );
}

export function JiraProps({ t, writable, onTask, facts, ed }: { t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void; facts?: CardFact[]; ed?: JiraEditUi }) {
  const query = t.customId ?? t.id;
  const [said, setSaid] = useState("");
  useEffect(() => { setSaid(""); }, [t.id]);
  const person = t.people?.[0];
  // What may be changed is only drawn while writing to Jira is on; a card the site did not describe has no controls.
  const live = writable ? ed : undefined;
  const can = (f: string): boolean => !!live && canEdit(live.edit, f);
  const rest = propsOf(t).filter(([k]) => !(can("duedate") && k === "Due"));
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
        {can("priority") && live!.edit?.priority ? (
          <CardBandField label="priority">
            <PriorityMenu value={live!.edit.priority.id} options={priorityOptions(live!.edit)} writable busy={live!.busy === "priority"} clearable={false}
              onChoose={(id, label) => { const s = stepFor("priority", { value: id, name: label }, live!.now); if (s) live!.run(s); }} />
          </CardBandField>
        ) : t.priority && (
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
        {can("duedate") && (
          <CardField label="Due">
            <EditDay value={dayToMs(t.due ?? "")} busy={live!.busy === "duedate"} title="Set the due date"
              onSave={(ms) => { const s = stepFor("duedate", { value: ms == null ? null : msToDay(ms) }, live!.now); if (s) live!.run(s); }} />
          </CardField>
        )}
        {can("parent") && (
          <CardField label="Parent">
            <EditText value={t.parent?.key ?? ""} empty="Add a parent" title="Change the parent card: a card id, or empty to take it off" busy={live!.busy === "parent"} parse={parseParent}
              onSave={(raw) => { const s = stepFor("parent", { value: raw }, live!.now); if (s) live!.run(s); }} />
          </CardField>
        )}
        {facts?.map((f) => <CardField key={f.id} label={f.label}><FactControl f={f} ed={live} /></CardField>)}
      </div>
      {can("labels") && <LabelEdit t={t} ed={live!} />}
      {!can("labels") && !!t.tags.length && (
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
