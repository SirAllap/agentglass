/*
 * What changing a field of a Jira card means on the screen, as plain data: the
 * request for a value, the words said about it afterwards, and the request that
 * puts it back. The pane draws controls only for what the card's edit screen
 * offered (`CardEdit.fields`), so nothing here decides what may be changed; it
 * decides how a change reads and how it is undone.
 *
 * An undo is one more edit, with the value that was there. Labels are the one
 * field that is an operation and not a value: the undo of an add is the
 * remove. Ceiling: an undo is offered once, for the last edit, and is checked
 * against the card's stamp like any other, so if somebody else changed the card
 * meanwhile it is refused and the person reads the card again.
 */
import { PRIOS } from "./priority.tsx";
import type { JiraEditAsk } from "./api.ts";
import type { CardEdit, CardFact, ProviderTask } from "../../../shared/providers.ts";

/** What the card holds now, as the controls read it. Dates are `YYYY-MM-DD`, estimates the site's own "2h 30m". */
export interface EditNow {
  title: string;
  priority: { id: string; name: string } | null;
  due: string;
  start: string;
  parent: string;
  flagged: boolean;
  originalEstimate: string;
  remainingEstimate: string;
}

export interface EditStep { ask: JiraEditAsk; said: string; undo: JiraEditAsk | null }

/** Whether the card's edit screen offers this field. */
export const canEdit = (edit: CardEdit | undefined, field: string): boolean => !!edit?.fields.includes(field);

const brief = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A priority's colour by where it sits in the site's own list, the rule the
 * board uses (server `priorityRank`): the first is urgent, the last is low, the
 * second is high when there are four or more, the rest are normal. A list of
 * one is normal.
 */
export function priorityInk(index: number, total: number): string {
  const rank = total < 2 ? "normal" : index === 0 ? "urgent" : index === total - 1 ? "low" : index === 1 && total > 3 ? "high" : "normal";
  return PRIOS.find((p) => p.id === rank)!.c;
}

/** The site's priorities as the menu's options. */
export const priorityOptions = (edit: CardEdit | undefined): { id: string; label: string; c: string }[] =>
  (edit?.priorities ?? []).map((p, i, all) => ({ id: p.id, label: p.name, c: priorityInk(i, all.length) }));

/** "2h 30m", "1w 2d": what Jira's time tracking reads. Empty takes the estimate off. */
const ESTIMATE = /^(?:\d{1,4}[wdhm])(?: ?\d{1,4}[wdhm]){0,3}$/;
export const parseEstimate = (raw: string): { ok: boolean; error?: string } =>
  raw.trim() === "" || ESTIMATE.test(raw.trim()) ? { ok: true } : { ok: false, error: "Write it like 2h 30m (w, d, h, m)" };

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
export const parseParent = (raw: string): { ok: boolean; error?: string } =>
  raw.trim() === "" || KEY.test(raw.trim()) ? { ok: true } : { ok: false, error: "A card id, like ORBIT-1042" };

export const parseTitle = (raw: string): { ok: boolean; error?: string } =>
  raw.trim() === "" ? { ok: false, error: "A card needs a title" } : raw.length > 255 ? { ok: false, error: "At most 255 characters" } : { ok: true };

const unset = (v: string, word: string): string => v || `no ${word}`;

/**
 * The step for putting `field` to `to`, given what the card holds now. `to` is
 * the value as the control gave it: "" or null takes a date, the parent or an
 * estimate off; a flag is a boolean; a label is `{ add }` or `{ remove }`.
 */
export function stepFor(field: string, to: { value?: string | boolean | null; add?: string; remove?: string; name?: string }, now: EditNow): EditStep | null {
  switch (field) {
    case "summary": {
      const v = String(to.value ?? "").trim();
      return { ask: { field, value: v }, said: `Title: “${brief(now.title)}” → “${brief(v)}”`, undo: { field, value: now.title } };
    }
    case "priority": {
      const id = String(to.value ?? "");
      return { ask: { field, value: id }, said: `Priority: ${now.priority?.name ?? "none"} → ${to.name ?? id}`, undo: now.priority ? { field, value: now.priority.id } : null };
    }
    case "labels":
      if (to.add) return { ask: { field, add: to.add }, said: `Label ${to.add} added`, undo: { field, remove: to.add } };
      if (to.remove) return { ask: { field, remove: to.remove }, said: `Label ${to.remove} taken off`, undo: { field, add: to.remove } };
      return null;
    case "duedate":
    case "start": {
      const was = field === "duedate" ? now.due : now.start;
      const word = field === "duedate" ? "Due date" : "Start date";
      const v = typeof to.value === "string" && to.value ? to.value : null;
      return { ask: { field, value: v }, said: v ? `${word}: ${unset(was, "date")} → ${v}` : `${word} cleared (it was ${unset(was, "date")})`, undo: { field, value: was || null } };
    }
    case "parent": {
      const v = typeof to.value === "string" && to.value.trim() ? to.value.trim().toUpperCase() : null;
      return { ask: { field, value: v }, said: v ? `Parent: ${unset(now.parent, "parent")} → ${v}` : `Parent taken off (it was ${unset(now.parent, "parent")})`, undo: { field, value: now.parent || null } };
    }
    case "flag": {
      const on = to.value === true;
      return { ask: { field, value: on }, said: on ? "Flagged" : "Flag removed", undo: { field, value: !on } };
    }
    case "originalEstimate":
    case "remainingEstimate": {
      const was = field === "originalEstimate" ? now.originalEstimate : now.remainingEstimate;
      const word = field === "originalEstimate" ? "Original estimate" : "Remaining estimate";
      const v = String(to.value ?? "").trim();
      return { ask: { field, value: v }, said: v ? `${word}: ${unset(was, "estimate")} → ${v}` : `${word} cleared (it was ${unset(was, "estimate")})`, undo: { field, value: was } };
    }
    default:
      return null;
  }
}

/** What a card holds now, read off the card and its Details, for `stepFor` to say what changed. */
export function nowOf(t: ProviderTask, facts: readonly CardFact[] | undefined, edit: CardEdit | undefined): EditNow {
  const raw = (id: string): string => facts?.find((f) => f.id === id)?.raw ?? "";
  return {
    title: t.title, priority: edit?.priority ?? null, due: t.due ?? "", start: raw("start"), parent: t.parent?.key ?? "",
    flagged: raw("flag") === "1", originalEstimate: raw("originalEstimate"), remainingEstimate: raw("remainingEstimate"),
  };
}
