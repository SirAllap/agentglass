/*
 * The top of a Jira card's pane, and the facts under its tabs.
 *
 * `JiraHead` is what stays put above the tabs: the key and the icon controls, the title, the one state chip (which is
 * also the move menu: the steps allowed from here, and a step that needs fields opens the move form) and when it last moved.
 * `JiraProps` is the card tab's first block: the facts as tiles, three to a row, each one a quiet cell that
 * is also the control that changes it (the assignee opens the people picker).
 *
 * Status, assignee and the hand-off change the card, so they are controls only when this app may write to Jira; without
 * that switch they are plain, a lock marks the tiles that could be edited, and one note says why, here, once. The thread's
 * composer and the pull request box stay silent then, or the same sentence would be on screen three times.
 * Priority, due and start date, labels, parent, the flag, the estimates and the title are controls only for what the card's own
 * edit screen offers (`ed.edit`, read from the site's editmeta) and only while writing is on; otherwise they are read as before.
 * Sprint, points and project are always read. A field the card does not have is not drawn at all, never drawn empty, unless the
 * screen offers it, and then it is the invitation to fill it.
 */
import { StartFlightPlan } from "../flightPlan/StartFlightPlan.tsx";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { dayToMs, msToDay } from "../../lib/cardEdits.ts";
import { canEdit, parseEstimate, parseParent, parseTitle, priorityOptions, stepFor } from "../../lib/jiraEdit.ts";
import { fmtAgo } from "../../lib/format.ts";
import { openCard } from "../../lib/openCard.ts";
import { Flag, CardFace, prioLook } from "../../lib/priority.tsx";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { tipAttr } from "../../lib/tip.ts";
import { CopyIcon, DoneIcon, LinkIcon, LockIcon, RefreshIcon } from "../../lib/glyphIcons.tsx";
import type { CardFact, ProviderTask } from "../../../../shared/providers.ts";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { TrackerStatusPick } from "../TrackerStatusPick.tsx";
import { TrackerPeoplePick } from "../TrackerPeoplePick.tsx";
import { TrackerHandOffButton } from "../TrackerHandOffButton.tsx";
import { TypeMark } from "./JiraSections.tsx";
import { ReadOnlyNote, READ_ONLY_TIP } from "../tasks/ReadOnlyNote.tsx";
import { EditDay, EditText, PriorityMenu, TagEditor } from "../tasks/CardEdit.tsx";
import type { JiraEditUi } from "./useJiraEdit.ts";
import type { JiraFollowUi } from "./useJiraFollow.ts";
import { JiraVote, JiraWatch } from "./JiraFollow.tsx";
import { DockIcon, ExtIcon, StateLabel, stateStyle } from "./DockParts.tsx";
import { useCopied } from "../CardChrome.tsx";
import { dueWords } from "../../lib/taskGrammar.ts";

export const WRITES_OFF = "Changes to Jira are switched off, so this card is read-only here. Turn on “Changes in Jira” in the Jira settings.";

/** The line a pick says after it ran: a leading `!` is a warning. */
function Said({ said }: { said: string }) {
  if (!said) return null;
  return <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>;
}

/** What stays above the tabs: the key and the icon controls, the title, the one state chip (which is the move menu) and when it last moved. */
export function JiraHead({ t, writable, onTask, onRefresh, refreshing, ed, follow, nav, onClose }: {
  t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void;
  onRefresh?: () => void; refreshing?: boolean;
  /** Watching and voting, with what the last press said; absent until the card is read. */
  follow?: JiraFollowUi;
  /** What the card lets a person change; absent until the card is read, and where writing is off. */
  ed?: JiraEditUi;
  /** Next and previous, when the card is a dialog over the list. */
  nav?: ReactNode;
  /** Close the card. */
  onClose?: () => void;
}) {
  const key = t.customId ?? t.id;
  const [copied, copy] = useCopied();
  const [said, setSaid] = useState("");
  // A said line belongs to the card it was said about.
  useEffect(() => { setSaid(""); }, [t.id]);
  const done = t.statusKind === "done";
  const editable = !!(writable && ed && canEdit(ed.edit, "summary"));
  const cut = editable ? 0 : t.title.lastIndexOf(" ") + 1;
  return (
    <div className="flex flex-col min-w-0" style={{ background: "var(--bg)", padding: "12px 16px 0", gap: 8 }}>
      <div className="flex items-center min-w-0" style={{ gap: 6 }}>
        <TypeMark type={t.issueType} size={22} />
        <button type="button" onClick={() => void copy(key, "id")} data-tip={tipAttr({ name: key, mono: true, text: "Copy the card id: for a branch, a commit or a colleague." })} aria-label={`Copy ${key}`}
          className="agx-btn tabular-nums rounded-md font-semibold min-w-0 truncate" style={{ fontSize: 11.5, color: "var(--info-ink)" }}>
          {copied === "id" ? "copied" : key}
        </button>
        {t.customId && t.customId !== t.id && <span className="text-[10px] px-1.5 rounded-md leading-[1.35] tabular-nums shrink-0" style={{ color: "var(--text4)", border: EDGE }} data-tip={tipAttr("Jira's own id for this card")}>{t.id}</span>}
        {t.mine && <span className="text-[10px] px-1.5 rounded-md leading-[1.35] tracking-[0.08em] shrink-0" style={{ color: "var(--success-ink)", background: "color-mix(in srgb, var(--success) 15%, transparent)" }}>YOURS</span>}
        <span className="flex-1" />
        {follow && <JiraWatch ui={follow} writes={writable} cardKey={key} />}
        {t.url && (
          <DockIcon tip={{ name: "Copy the link", text: "The Jira address of this card." }} onClick={() => void copy(t.url, "url")}>
            {copied === "url" ? <DoneIcon size={ICON.md} /> : <LinkIcon size={ICON.md} />}
          </DockIcon>
        )}
        {t.url && <DockIcon tip={{ name: "Open in Jira", text: "This card, in your browser." }} href={t.url}><ExtIcon /></DockIcon>}
        <DockIcon tip={{ name: "Read this card again", text: "Asks Jira for it now." }} onClick={onRefresh ?? (() => undefined)} disabled={!!refreshing}>
          <RefreshIcon size={ICON.md} className={refreshing ? "agx-turn" : undefined} />
        </DockIcon>
        {nav}
        {onClose && <DockIcon tip={{ name: "Close", text: "Back to the list.", hint: { key: "Esc", text: "closes the card" } }} onClick={onClose}><CloseIcon size={ICON.md} /></DockIcon>}
      </div>
      <h3 className="min-w-0" style={{ fontFamily: "var(--font-prose)", fontSize: 17, fontWeight: 600, lineHeight: 1.3, letterSpacing: "-0.01em", color: "var(--text)", textWrap: "pretty" }}>
        {editable
          ? <EditText value={t.title} empty="Untitled" title="Rename this card" wrap textClass="text-[17px] font-semibold leading-snug hover:underline decoration-dotted underline-offset-4" busy={ed!.busy === "summary"}
              parse={parseTitle} onSave={(raw) => { const s = stepFor("summary", { value: raw }, ed!.now); if (s) ed!.run(s); }} />
          : t.title.slice(0, cut)}
        {/* The last word and the copy button are one unit, so a full last line never leaves the icon alone on the next one. */}
        <span style={{ whiteSpace: "nowrap" }}>{editable ? "" : t.title.slice(cut)}
          <button type="button" onClick={() => void copy(t.title, "title")} data-tip={tipAttr({ name: "Copy the title" })} aria-label={copied === "title" ? "Title copied" : "Copy the title"}
            className="inline-flex items-center justify-center align-middle ml-1.5 rounded-md hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
            style={{ width: 20, height: 20, color: copied === "title" ? "var(--success)" : "var(--text4)" }}>
            {copied === "title" ? <DoneIcon size={ICON.sm} /> : <CopyIcon size={ICON.sm} />}
          </button>
        </span>
      </h3>
      <Said said={follow?.said || said} />
      <div className="flex items-center flex-wrap min-w-0" style={{ gap: 8 }}>
        {writable
          ? <TrackerStatusPick tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} chip={26} />
          : <span className="inline-flex items-center shrink-0" data-tip={tipAttr({ name: t.status, text: "Read-only. Turn changes on to move this card." })} style={stateStyle(t.statusColor || undefined, done, 26)}><StateLabel status={t.status} done={done} /></span>}
        {t.updated > 0 && <span className="text-[10.5px]" style={{ color: "var(--text4)" }} data-tip={tipAttr({ name: "Last change", text: new Date(t.updated).toLocaleString() })}>moved {fmtAgo(t.updated)} ago</span>}
        <span className="flex-1" />
        {follow && <JiraVote ui={follow} writes={writable} cardKey={key} />}
        <StartFlightPlan id={key} title={t.title} url={t.url} />
        {writable && <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} />}
      </div>
    </div>
  );
}

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
      <Button size="compact" className="shrink-0" disabled={busy}
        title={on ? "Take the flag off this card" : "Flag this card as blocked"}
        onClick={() => { const s = stepFor("flag", { value: !on }, ed.now); if (s) ed.run(s); }}>
        {busy ? "Saving…" : on ? "Remove flag" : "Add flag"}
      </Button>
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
    <span className="flex items-center gap-1.5 flex-wrap min-w-0" aria-label="Labels"><TagEditor tags={t.tags} noun="label" suggestions={names} busy={ed.busy === "labels"}
      onOpen={() => { void api.jiraLabels("").then((r) => { if (!gone.current && r.ok && r.labels) setNames(r.labels); }).catch(() => undefined); }}
      onAdd={(name) => { const s = stepFor("labels", { add: name }, ed.now); if (s) ed.run(s); }}
      onRemove={(name) => { const s = stepFor("labels", { remove: name }, ed.now); if (s) ed.run(s); }} /></span>
  );
}

/** One fact as a tile: its name over its value. A locked tile (writing is off and the fact could be edited) asks for the grant when it is pressed. */
function Tile({ label, tone, locked, onAllow, children }: { label: string; tone?: string; locked?: boolean; onAllow?: () => void; children: ReactNode }) {
  const ask = locked && onAllow ? {
    role: "button" as const, tabIndex: 0, onClick: onAllow, "data-tip": tipAttr(READ_ONLY_TIP), style: { cursor: "pointer" },
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAllow(); } },
  } : locked ? { "data-tip": tipAttr(READ_ONLY_TIP) } : null;
  return (
    <div className="agx-dk-fact" {...ask} style={{ ...(tone ? { ["--tc" as string]: tone } : null), ...(ask && "style" in ask ? ask.style : null) }}>
      <span className="agx-dk-lb truncate">{label}</span>
      <div className="agx-dk-vl">{children}</div>
      {locked && <span className="agx-dk-lock" aria-hidden><LockIcon size={ICON.xs} /></span>}
    </div>
  );
}

const Val = ({ children, dim }: { children: ReactNode; dim?: boolean }) => <span className="truncate min-w-0" style={dim ? { color: "var(--text4)", fontWeight: 400 } : undefined}>{children}</span>;

export function JiraProps({ t, writable, onTask, facts, ed, onAllow }: { t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void; facts?: CardFact[]; onAllow?: () => void; ed?: JiraEditUi }) {
  const query = t.customId ?? t.id;
  const [said, setSaid] = useState("");
  useEffect(() => { setSaid(""); }, [t.id]);
  const person = t.people?.[0];
  // What may be changed is only drawn while writing to Jira is on; a card the site did not describe has no controls.
  const live = writable ? ed : undefined;
  const can = (f: string): boolean => !!live && canEdit(live.edit, f);
  const lockable = (f: string): boolean => !writable && !!onAllow && f.length > 0;
  const look = t.priority ? prioLook(t.priority) : null;
  const today = new Date().toISOString().slice(0, 10);
  const due = t.due ? dueWords(t.due, today, t.statusKind === "done") : null;
  const dueTone = due?.tone === "late" || due?.tone === "today" ? "var(--warning)" : undefined;
  const byId = (id: string) => facts?.find((f) => f.id === id);
  const reporter = byId("reporter");
  const components = byId("components");
  const rest = (facts ?? []).filter((f) => f.id !== "reporter" && f.id !== "components");
  const epicLike = t.parent?.type ? /epic/i.test(t.parent.type) : false;
  return (
    <div className="flex flex-col min-w-0" style={{ gap: 12 }}>
      {!writable && (onAllow
        ? <ReadOnlyNote onAllow={onAllow} title={WRITES_OFF} flush />
        : <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{WRITES_OFF}</div>)}
      <div className="agx-dk-facts">
        <Tile label="Assignee" locked={lockable("assignee")} onAllow={onAllow} tone={t.mine ? "var(--success)" : undefined}>
          {writable
            ? <TrackerPeoplePick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} bare />
            : (
              <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: t.mine ? "var(--success-ink)" : "var(--text)" }}>
                {person && <CardFace p={{ name: person.name, initials: person.initials, color: person.color, avatar: person.avatar, me: person.me }} size={18} />}
                <Val>{t.mine ? "You" : (t.assignees.join(", ") || "Nobody")}</Val>
              </span>
            )}
        </Tile>
        {reporter && <Tile label="Reporter"><FactValue f={reporter} /></Tile>}
        {(t.priority || can("priority")) && (
          <Tile label="Priority" tone={look?.c} locked={lockable("priority")} onAllow={onAllow}>
            {can("priority") && live!.edit?.priority
              ? <PriorityMenu value={live!.edit.priority.id} options={priorityOptions(live!.edit)} writable busy={live!.busy === "priority"} clearable={false}
                  onChoose={(id, label) => { const s = stepFor("priority", { value: id, name: label }, live!.now); if (s) live!.run(s); }} />
              : look && <span className="inline-flex items-center gap-1.5 min-w-0" data-tip={tipAttr("Priority is read from Jira; changing it is not offered here.")}><Flag c={look.c} on /><Val>{look.label}</Val></span>}
          </Tile>
        )}
        {(t.due || can("duedate")) && (
          <Tile label="Due" tone={dueTone} locked={lockable("duedate")} onAllow={onAllow}>
            {can("duedate")
              ? <EditDay value={dayToMs(t.due ?? "")} busy={live!.busy === "duedate"} title="Set the due date"
                  onSave={(ms) => { const s = stepFor("duedate", { value: ms == null ? null : msToDay(ms) }, live!.now); if (s) live!.run(s); }} />
              : <Val>{due && due.tone !== "later" && due.tone !== "none" ? due.text : t.due}</Val>}
          </Tile>
        )}
        {t.sprint && <Tile label="Sprint" tone="var(--info)"><Val>{t.sprint}</Val></Tile>}
        {(t.parent || can("parent")) && (
          <Tile label={epicLike ? "Epic" : "Parent"}>
            {can("parent")
              ? <EditText value={t.parent?.key ?? ""} empty="Add a parent" title="Change the parent card: a card id, or empty to take it off" busy={live!.busy === "parent"} parse={parseParent}
                  onSave={(raw) => { const s = stepFor("parent", { value: raw }, live!.now); if (s) live!.run(s); }} />
              : t.parent && (
                <button type="button" onClick={() => openCard(t.parent!.key, t.parent!.key, "jira")} data-tip={tipAttr({ name: t.parent.key, mono: true, text: t.parent.title || "Open the card this one sits under." })}
                  className="agx-btn min-w-0 truncate text-left" style={{ color: "inherit", font: "inherit" }}>
                  <span className="tabular-nums">{t.parent.key}</span>{t.parent.title ? ` ${t.parent.title}` : ""}
                </button>
              )}
          </Tile>
        )}
        {typeof t.points === "number" && <Tile label="Points"><span className="tabular-nums">{t.points}</span></Tile>}
        {components && <Tile label="Components"><FactValue f={components} /></Tile>}
        {(!!t.tags.length || can("labels")) && (
          <Tile label="Labels" locked={lockable("labels")} onAllow={onAllow}>
            {can("labels")
              ? <LabelEdit t={t} ed={live!} />
              : <span className="flex items-center gap-x-1.5 flex-wrap min-w-0" style={{ fontWeight: 600 }}>{t.tags.map((x) => <span key={x}>#{x}</span>)}</span>}
          </Tile>
        )}
        {t.list && <Tile label="Project"><Val>{t.list}</Val></Tile>}
        {rest.map((f) => <Tile key={f.id} label={f.label}><FactControl f={f} ed={live} /></Tile>)}
      </div>
      <Said said={said} />
    </div>
  );
}
