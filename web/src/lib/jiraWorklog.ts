/*
 * The Jira card's work log, as plain decisions: what the form holds, whether it
 * may be sent, what it will do, what it sends, and how a thing that landed is put
 * back. The pane only draws what this says.
 *
 * What counts as a time, a day or a way to follow the estimate is
 * shared/jiraWorklog.ts, the same check the route and the door make, so a form
 * that lets a value through is one the server would accept.
 *
 * Ceiling: an Undo is offered only where Jira can put the old thing back by
 * itself: an added entry (deleted again, with the estimate set to what it was)
 * and a changed time. A changed day or note, and any delete, say so instead.
 */
import {
  ADJUST_MODES, adjustEffect, adjustOf, minutesOf, parseDuration, startedStamp,
  type Adjust, type AdjustMode, type WorklogOp,
} from "../../../shared/jiraWorklog.ts";
import type { CardEvent } from "../../../shared/providers.ts";

export type WorkEntry = NonNullable<CardEvent["entry"]>;

export interface WorkForm { time: string; day: string; note: string; mode: AdjustMode; value: string }
export const EMPTY_FORM: WorkForm = { time: "", day: "", note: "", mode: "auto", value: "" };

/** An entry as the form that changes it starts: what it holds now, with the estimate left to follow by itself. */
export const entryForm = (e: WorkEntry): WorkForm => ({ time: e.time, day: e.started.slice(0, 10), note: e.note, mode: "auto", value: "" });

/** The words of each mode, for the action it is on. */
export function modeLabel(op: WorklogOp, mode: AdjustMode): string {
  switch (mode) {
    case "new": return "Set it to…";
    case "leave": return "Leave it as it is";
    case "manual": return op === "delete" ? "Add back…" : "Reduce by…";
    default: return op === "add" ? "Reduce by the time logged" : op === "delete" ? "Add the time back" : "Adjust by the difference";
  }
}
export const modesOf = (op: WorklogOp): readonly AdjustMode[] => ADJUST_MODES[op];
/** A mode that needs a time of its own: the box beside it is for that. */
export const takesValue = (mode: AdjustMode): boolean => mode === "new" || mode === "manual";

/** What is wrong with what was typed, by field. Nothing typed yet is not wrong: it is `missing`. */
export interface WorkView {
  canSubmit: boolean;
  problems: { time?: string; day?: string; note?: string; value?: string };
  /** The required things still empty, so the footer can say which. */
  missing: string[];
  /** What pressing the button will do, said before. */
  effects: string[];
  /** Why the button is off, when it is. */
  hint: string;
}

const same = (a: string, b: string): boolean => {
  const x = parseDuration(a), y = parseDuration(b);
  if (!x.ok || !y.ok) return a.trim() === b.trim();
  const m = minutesOf(a), n = minutesOf(b);
  return m !== null && n !== null ? m === n : x.text === y.text;
};

/** The adjust the form says, or the problem with its box. */
function adjustOfForm(op: WorklogOp, f: WorkForm): { adjust?: Adjust; problem?: string; missing?: boolean } {
  if (takesValue(f.mode) && !f.value.trim()) return { missing: true };
  const r = adjustOf({ mode: f.mode, ...(takesValue(f.mode) ? { value: f.value } : {}) }, op);
  return r.ok ? { adjust: r.adjust } : { problem: r.error };
}

export function workView(op: WorklogOp, f: WorkForm, o: { entry?: WorkEntry; now: Date }): WorkView {
  const problems: WorkView["problems"] = {};
  const missing: string[] = [];
  const effects: string[] = [];
  const entry = o.entry;

  let timeText = entry?.time ?? "";
  if (op !== "delete") {
    if (!f.time.trim()) { if (op === "add") missing.push("the time"); }
    else {
      const t = parseDuration(f.time);
      if (!t.ok) problems.time = t.error; else timeText = t.text;
    }
    if (f.day) {
      const d = startedStamp(f.day, o.now);
      if (!d.ok) problems.day = d.error;
    }
    if (op === "edit" && entry?.note && !f.note.trim()) problems.note = "A note cannot be taken off here";
  }
  const a = adjustOfForm(op, f);
  if (a.problem) problems.value = a.problem;
  if (a.missing) missing.push("the estimate");

  if (op === "add") effects.push(`Logs ${timeText || "time"}${f.day ? ` for ${f.day}` : " now"}`);
  if (op === "edit" && entry) {
    const bits = [
      !f.time.trim() || same(f.time, entry.time) ? "" : `time from ${entry.time} to ${timeText}`,
      f.day && f.day !== entry.started.slice(0, 10) ? `day to ${f.day}` : "",
      f.note.trim() && f.note.trim() !== entry.note.trim() ? "note" : "",
    ].filter(Boolean);
    effects.push(bits.length ? `Changes the entry's ${bits.join(", ")}` : "Nothing is different yet");
  }
  if (op === "delete") effects.push(`Deletes the entry of ${entry?.time ?? "time"} for good: Jira cannot bring it back`);
  if (a.adjust) effects.push(adjustEffect(op, a.adjust, timeText));

  const unchanged = op === "edit" && entry
    && (!f.time.trim() || same(f.time, entry.time)) && (!f.day || f.day === entry.started.slice(0, 10)) && (!f.note.trim() || f.note.trim() === entry.note.trim());
  const bad = Object.values(problems).find(Boolean);
  const hint = bad ?? (missing.length ? `Needs ${missing.join(" and ")}` : unchanged ? "Change the time, the day or the note first" : "");
  return { canSubmit: !hint, problems, missing, effects, hint };
}

/** The adjust as the route takes it. */
const adjustSend = (f: WorkForm): { mode: AdjustMode; value?: string } => ({ mode: f.mode, ...(takesValue(f.mode) ? { value: f.value.trim() } : {}) });

export interface WorkSend { time?: string; started?: string; note?: string; adjust: { mode: AdjustMode; value?: string } }

/** What goes to the route: for a change, only what is different from the entry. */
export function workSend(op: WorklogOp, f: WorkForm, entry?: WorkEntry): WorkSend {
  const adjust = adjustSend(f);
  if (op === "delete") return { adjust };
  if (op === "add") return { time: f.time.trim(), ...(f.day ? { started: f.day } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}), adjust };
  return {
    ...(f.time.trim() && entry && !same(f.time, entry.time) ? { time: f.time.trim() } : {}),
    ...(f.day && entry && f.day !== entry.started.slice(0, 10) ? { started: f.day } : {}),
    ...(f.note.trim() && entry && f.note.trim() !== entry.note.trim() ? { note: f.note.trim() } : {}),
    adjust,
  };
}

/** One request to the work-log routes. */
export type WorkCall =
  | { op: "add"; send: WorkSend }
  | { op: "edit"; id: string; send: WorkSend }
  | { op: "delete"; id: string; send: Pick<WorkSend, "adjust"> };

export interface WorkResult {
  ok: boolean; error?: string; conflict?: boolean; partial?: string;
  /** The entry that was added or changed. */
  entry?: string;
  before?: string; after?: string;
}

/**
 * The call that puts a landed one back, or null when Jira cannot. The estimate is set to what it was before, not
 * "followed" again: following it again would go wrong by whatever the first call rounded.
 */
export function undoOf(call: WorkCall, r: WorkResult, was?: WorkEntry): WorkCall | null {
  const back: WorkSend["adjust"] = r.before ? { mode: "new", value: r.before } : { mode: "leave" };
  if (call.op === "add") return r.entry ? { op: "delete", id: r.entry, send: { adjust: back } } : null;
  if (call.op === "edit") {
    const onlyTime = !!call.send.time && !call.send.started && !call.send.note;
    return onlyTime && was ? { op: "edit", id: call.id, send: { time: was.time, adjust: back } } : null;
  }
  return null;
}

/** The sentence said once it landed. The estimate is the site's reading either side of the write. */
export function said(call: WorkCall, r: WorkResult, was?: WorkEntry): string {
  const left = (s?: string) => s || "none";
  const est = r.before === undefined || r.after === undefined ? "" : r.before === r.after ? ` Remaining estimate stays ${left(r.after)}.` : ` Remaining estimate went from ${left(r.before)} to ${left(r.after)}.`;
  const what = call.op === "add" ? `Logged ${call.send.time}`
    : call.op === "edit" ? `Changed the entry${call.send.time ? ` to ${call.send.time}` : ""}`
    : `Deleted the entry of ${was?.time ?? "time"}`;
  return `${what}.${est}${call.op === "delete" ? " It cannot be undone." : ""}`;
}
