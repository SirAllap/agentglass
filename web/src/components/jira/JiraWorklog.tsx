/*
 * The Jira card's Work log tab: the entries, the card's time tracking, and
 * where time is logged, changed or deleted.
 *
 * Shown only where the site has time tracking on for the card: `tracking` is
 * absent otherwise and the tab is the plain list it always was. With writing to
 * Jira off the entries are only read. Your own entries (the site says which)
 * can be changed or deleted; nobody else's offers a control.
 *
 * Every state is drawn in the same place. The bar's one button keeps its spot
 * and its words (open or closed it is the same "Log time", pressed or not); the
 * line under it holds two lines of height for what the last write did, so
 * neither it nor the form moves what is above. A form's rows keep their height
 * whether they hold a hint or not, and the button that sends changes its words
 * and not its spot. What a press will do is listed before it, and the list says
 * "What happened" afterwards in the line under the bar, with Undo where Jira
 * lets the old thing go back (a delete does not, and says so first).
 *
 * Ceiling: the day is a date (the hour is today's clock, or nine for an earlier
 * day), a note is Markdown with nobody to notify, and a note once written cannot
 * be taken off from here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../Select.tsx";
import { Markdown } from "../../lib/markdown.tsx";
import { fmtAgo } from "../../lib/format.ts";
import { Button, INPUT, INPUT_STYLE, EDGE, LINE, Textarea } from "../workspace/Chrome.tsx";
import { CommentAction } from "../tasks/CardEdit.tsx";
import { WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EditNote } from "./EditNote.tsx";
import { Author } from "./Author.tsx";
import type { JiraWorkUi } from "./useJiraWork.ts";
import { EMPTY_FORM, entryForm, modeLabel, modesOf, takesValue, workSend, workView, type WorkCall, type WorkEntry, type WorkForm } from "../../lib/jiraWorklog.ts";
import type { AdjustMode, WorklogOp } from "../../../../shared/jiraWorklog.ts";
import type { CardEvent, TaskDetail } from "../../../../shared/providers.ts";

const KEY_STYLE = { fontSize: 10.5, color: "var(--text3)" } as const;
const PENCIL = "M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z";
const BIN = "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6";
/** Two lines of the note's text and its bottom padding, kept whether or not there is anything to say. */
const NOTE_H = 2 * 16 + 8;

const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** How the remaining estimate follows: the way, and the time it takes when it takes one. The box is always there, so the row does not change shape. */
function AdjustPicker({ op, form, set, off }: { op: WorklogOp; form: WorkForm; set: (f: Partial<WorkForm>) => void; off: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="min-w-0 flex-1">
        <Select value={form.mode} title="How the remaining estimate follows" disabled={off} align="left" className="w-full h-[32px] px-2.5 rounded-lg" style={{ ...INPUT_STYLE, background: "var(--surface-inset)" }}
          options={modesOf(op).map((m) => ({ value: m, label: modeLabel(op, m) }))} onChange={(v) => set({ mode: v as AdjustMode, value: takesValue(v as AdjustMode) ? form.value : "" })} />
      </div>
      <input value={form.value} disabled={off || !takesValue(form.mode)} aria-label="Time for the remaining estimate" placeholder={takesValue(form.mode) ? "2h" : ""}
        onChange={(e) => set({ value: e.target.value })} className={`${INPUT} w-[84px] shrink-0`} style={INPUT_STYLE} />
    </div>
  );
}

/** The form that logs time or changes an entry; the same fields for both, the entry's own values in it for a change. */
function WorkFormBox({ op, entry, work, onClose, bare }: { op: "add" | "edit"; entry?: WorkEntry; work: JiraWorkUi; onClose: () => void; /** Drawn inside a box already (an entry's card): no edge of its own. */ bare?: boolean }) {
  const [form, setForm] = useState<WorkForm>(entry ? entryForm(entry) : EMPTY_FORM);
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [err, setErr] = useState("");
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  const set = (f: Partial<WorkForm>) => { setForm((x) => ({ ...x, ...f })); setErr(""); if (phase === "failed") setPhase("idle"); };
  const view = useMemo(() => workView(op, form, { entry, now: new Date() }), [op, form, entry]);
  const off = phase === "running";
  const typed = (k: "time" | "day" | "note" | "value") => view.problems[k];

  const go = async () => {
    if (!view.canSubmit || off) return;
    setPhase("running"); setErr("");
    const send = workSend(op, form, entry);
    const call: WorkCall = op === "add" ? { op, send } : { op, id: entry!.id, send };
    const r = await work.run(call, entry);
    if (gone.current) return;
    if (r.ok) { onClose(); return; }
    setPhase("failed"); setErr(r.error || "Jira refused that");
  };
  const label = phase === "running" ? (op === "add" ? "Logging…" : "Saving…") : op === "add" ? "Log time" : "Save";
  const row = (name: string, control: React.ReactNode, hint: React.ReactNode, bad?: boolean) => (
    <>
      <div className="pt-1.5" style={{ ...KEY_STYLE, alignSelf: "start" }}>{name}</div>
      <div className="min-w-0">
        {control}
        {/* The hint row always holds its height, so the form does not jump as it fills in. */}
        <div className="h-[16px] text-[10.5px] leading-[16px] truncate" style={{ color: bad ? "var(--error)" : "var(--text3)" }}>{hint}</div>
      </div>
    </>
  );
  const ring = (k: "time" | "day" | "value") => ({ ...INPUT_STYLE, ...(typed(k) ? { boxShadow: "0 0 0 1px var(--error)" } : null) });

  return (
    <div className={bare ? "pb-1" : "rounded-lg px-3 pt-3 pb-2.5 mb-3"} style={bare ? undefined : { border: EDGE, background: "var(--surface-card)" }} role="group" aria-label={op === "add" ? "Log time" : "Change this entry"} data-work-form={op}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!off) onClose(); }
        else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); void go(); }
      }}>
      <div className="grid gap-x-3 gap-y-0.5" style={{ gridTemplateColumns: "96px 1fr" }}>
        {row("Time spent",
          <input value={form.time} autoFocus disabled={off} aria-label="Time spent" placeholder="1h 30m" onChange={(e) => set({ time: e.target.value })} className={`w-full ${INPUT}`} style={ring("time")} />,
          typed("time") ?? (op === "add" ? (form.time.trim() ? "" : "Required") : "Weeks w, days d, hours h, minutes m"), !!typed("time"))}
        {row("Day",
          <input type="date" value={form.day} max={today()} disabled={off} aria-label="Day the work was done" onChange={(e) => set({ day: e.target.value })} className={`w-full ${INPUT}`} style={{ ...ring("day"), colorScheme: "light dark" }} />,
          typed("day") ?? (op === "add" ? "Optional · today by default" : "Optional"), !!typed("day"))}
        {row("Note",
          <Textarea value={form.note} rows={2} disabled={off} aria-label="What was done" onChange={(e) => set({ note: e.target.value })}
            className="w-full !min-h-0" style={typed("note") ? { boxShadow: "0 0 0 1px var(--error)" } : undefined} />,
          typed("note") ?? "Optional · Markdown", !!typed("note"))}
        {row("Remaining",
          <AdjustPicker op={op} form={form} set={set} off={off} />,
          typed("value") ?? "", !!typed("value"))}
      </div>

      <div className="mt-2 mb-1.5 flex items-center gap-2" style={KEY_STYLE}><span>What will happen</span><span className="flex-1" style={{ borderTop: LINE }} /></div>
      <ul className="flex flex-col gap-0.5 text-[11.5px]" style={{ color: "var(--text)" }} data-effects="">
        {view.effects.map((e) => <li key={e}>{e}</li>)}
      </ul>

      {/* One line of foot, holding its height: what is missing, or what went wrong. */}
      <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug min-h-[30px]" role={err ? "alert" : undefined} data-work-foot={err ? "bad" : view.hint ? "hint" : "ok"}
        style={{ color: err ? "var(--error)" : "var(--text3)" }}>
        {err && <WarningIcon size={ICON.sm} className="shrink-0" />}
        <span>{err || view.hint}</span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onClose} disabled={off} className="shrink-0">Cancel</Button>
        {/* Off, the button keeps its size and place and reads as a drawn outline: white words on a washed primary were not legible. */}
        <Button onClick={() => void go()} disabled={!view.canSubmit || off} tone={view.canSubmit && !off ? "primary" : "plain"} className="min-w-[88px]">{label}</Button>
      </div>
    </div>
  );
}

/** Asked in place before an entry is deleted, and said in full: nothing in Jira brings it back. The estimate's way is chosen here. */
function DeleteAsk({ entry, work, onClose }: { entry: WorkEntry; work: JiraWorkUi; onClose: () => void }) {
  const [form, setForm] = useState<WorkForm>(EMPTY_FORM);
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [err, setErr] = useState("");
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  const view = useMemo(() => workView("delete", form, { entry, now: new Date() }), [form, entry]);
  const off = phase === "running";
  const go = async () => {
    if (!view.canSubmit || off) return;
    setPhase("running"); setErr("");
    const r = await work.run({ op: "delete", id: entry.id, send: workSend("delete", form) }, entry);
    if (gone.current) return;
    if (r.ok) return; // the row is gone with the card as it now stands
    setPhase("failed"); setErr(r.error || "Jira refused the delete");
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[10.5px]" role="alertdialog" aria-label="Delete this entry?" data-work-delete="">
      <span style={{ color: "var(--text2)" }}>Delete this entry for good? Jira cannot bring it back.</span>
      <AdjustPicker op="delete" form={form} set={(f) => { setForm((x) => ({ ...x, ...f })); setErr(""); }} off={off} />
      <span style={{ color: view.problems.value ? "var(--error)" : "var(--text3)" }}>{view.problems.value ?? view.effects[1] ?? ""}</span>
      {err && <span role="alert" style={{ color: "var(--error)" }}>{err}</span>}
      <div className="flex items-center gap-2">
        <Button size="compact" tone="danger" disabled={off || !view.canSubmit} onClick={() => void go()}>{off ? "Deleting…" : "Delete"}</Button>
        <Button size="compact" tone="quiet" disabled={off} onClick={onClose}>Keep it</Button>
      </div>
    </div>
  );
}

type Mode = "read" | "edit" | "delete";

/** One entry of the work log: who, how long, when, the note; and for your own, what can be done to it. */
function WorkRow({ e, entry, work }: { e: CardEvent; entry?: WorkEntry; work?: JiraWorkUi }) {
  const [mode, setMode] = useState<Mode>("read");
  const own = !!work && !!entry?.mine;
  const spent = entry?.time || e.text?.replace(/^logged\s+/, "").split(":")[0] || "";
  return (
    <div className="agx-card rounded-lg px-3 py-2 min-w-0" style={{ border: EDGE, background: "var(--surface-card)" }} data-work-entry={entry?.id ?? ""}>
      <div className="flex items-center gap-1.5 min-w-0 text-[10.5px]">
        <Author who={e.who ?? "Someone"} avatar={e.avatar} initials={(e.who ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()} size={18} />
        <span className="min-w-0 truncate"><span className="font-semibold" style={{ color: "var(--text2)" }}>{e.who || "Someone"}</span>
          <span style={{ color: "var(--text3)" }}> logged </span><b style={{ color: "var(--text)" }}>{spent}</b></span>
        <span className="flex-1" />
        <span className="shrink-0 tabular-nums" style={{ color: "var(--text4)" }} title={new Date(e.at).toLocaleString()}>{fmtAgo(e.at)} ago</span>
        {/* The controls stay where they are in every state; the one in use shows as pressed. */}
        {own && (
          <span className="shrink-0 inline-flex items-center gap-1">
            <CommentAction iconOnly label="Edit" title="Change this entry" d={PENCIL} on={mode === "edit"} tone="var(--primary)" onClick={() => setMode(mode === "edit" ? "read" : "edit")} />
            <CommentAction iconOnly label="Delete" title="Delete this entry" tone="var(--error)" d={BIN} on={mode === "delete"} onClick={() => setMode(mode === "delete" ? "read" : "delete")} />
          </span>
        )}
      </div>
      {entry?.note && mode !== "edit" && <div className="agx-cu-body agx-cu-note min-w-0 break-words mt-1"><Markdown text={entry.note} /></div>}
      {mode === "edit" && entry && work && <div className="mt-2"><WorkFormBox op="edit" entry={entry} work={work} onClose={() => setMode("read")} bare /></div>}
      {mode === "delete" && entry && work && <DeleteAsk entry={entry} work={work} onClose={() => setMode("read")} />}
    </div>
  );
}

export function WorklogPanel({ events, tracking, work, newest }: {
  /** Every entry read so far, oldest first. */
  events: CardEvent[];
  tracking: TaskDetail["tracking"];
  /** What can be done to the entries; absent where they are only read. */
  work?: JiraWorkUi;
  newest: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const shown = newest ? [...events].reverse() : events;
  const readout = tracking ? [tracking.remaining && `Remaining ${tracking.remaining}`, tracking.original && `Estimated ${tracking.original}`, tracking.spent && `Spent ${tracking.spent}`].filter(Boolean).join(" · ") : "";
  return (
    <>
      {tracking && (
        <>
          <div className="flex items-center gap-2 mb-1 min-h-[26px] text-[10.5px]" data-work-bar="">
            <span className="min-w-0 truncate" style={{ color: "var(--text3)" }} title={readout}>{readout || "No estimate or time yet"}</span>
            <span className="flex-1" />
            {work && (
              <Button size="compact" tint={adding ? "var(--primary)" : undefined} onClick={() => setAdding((a) => !a)} aria-pressed={adding} title="Log time on this card"
                className="shrink-0 min-w-[76px]">Log time</Button>
            )}
          </div>
          {work && <div style={{ minHeight: NOTE_H }} data-work-note=""><EditNote flush lines={2} note={work.note} busy={work.busy} onUndo={work.undo} onClose={work.clear} /></div>}
          {work && adding && <WorkFormBox op="add" work={work} onClose={() => setAdding(false)} />}
        </>
      )}
      <div className="flex flex-col gap-2" data-work-list="">
        {shown.map((e, i) => <WorkRow key={e.entry?.id ?? `${e.at}-${i}`} e={e} entry={e.entry} work={tracking ? work : undefined} />)}
      </div>
    </>
  );
}
