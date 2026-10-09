/*
 * The two blocks that are not about who the card is on or where it is: a comment, and a custom field.
 *
 * A step's status and people are ONE write (see stepChanges). A comment and a field are not part of it:
 * ClickUp takes a comment on `/task/{id}/comment` and a field on `/task/{id}/field/{id}` and neither
 * can ride on the task update, so each is a request of its own, sent after the card write succeeds and
 * in this order: the fields, then the comment (whose text may name the status the card is in by then).
 * A press therefore costs 1 + (a field) + (a comment) requests, never more, and the sentence under
 * the step says which.
 *
 * A field is stored by NAME, because ids differ from list to list and the name is what a person reads.
 * Where the step runs, the name is looked up in THAT card's list: a field the list does not have, a
 * read-only one, a kind this cannot write, or an option the field does not offer is said in words and
 * skipped, and the rest of the step still runs. Ceiling: people fields and checkboxes are not here
 * (the wire shape of a people field has not been checked against a real board).
 */
import type { ListField, StepBlock } from "../../../shared/providers.ts";
import { fillTemplate, type Placeholder } from "../../../shared/stepBlocks.ts";

/** The kinds of field this writes, as ClickUp names them, and what each reads as. */
export const FIELD_KINDS: Record<string, "option" | "options" | "text" | "number" | "date"> = {
  drop_down: "option", labels: "options", short_text: "text", text: "text", number: "number", date: "date",
};
export const fieldIsWritable = (f: Pick<ListField, "type" | "readOnly">): boolean => !f.readOnly && f.type in FIELD_KINDS;

export type ExtraItem =
  | { kind: "comment"; text: string }
  | { kind: "field"; fieldId: string; fieldKind: string; name: string; /** What the field becomes, as a person reads it. */ shown: string; /** What goes on the wire for `fieldWire`. */ value: string };

export type Extra = { item: ExtraItem } | { skip: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The field this block means on this list, and its value as the wire wants it; or why it cannot be. */
export function resolveField(fields: readonly ListField[] | null | undefined, b: { field: string; value: string }): Extra {
  const name = b.field.trim();
  const f = (fields ?? []).find((x) => same(x.name, name));
  if (!f) return { skip: `“${name}” is not a field of this card's list` };
  if (f.readOnly) return { skip: `“${f.name}” is marked read-only` };
  const kind = FIELD_KINDS[f.type];
  if (!kind) return { skip: `“${f.name}” is a ${f.type} field, which this cannot write` };
  const v = b.value.trim();
  const item = (value: string): Extra => ({ item: { kind: "field", fieldId: f.id, fieldKind: f.type, name: f.name, shown: v, value } });
  if (!v) return { skip: `“${f.name}” has no value to set` };
  switch (kind) {
    case "option": {
      const o = f.options?.find((x) => same(x.name, v));
      return o ? item(o.id) : { skip: `“${f.name}” has no option “${v}” here` };
    }
    case "options": {
      const ids = v.split(",").map((x) => x.trim()).filter(Boolean).map((n) => f.options?.find((o) => same(o.name, n)));
      const bad = v.split(",").map((x) => x.trim()).filter(Boolean).find((_, i) => !ids[i]);
      return bad ? { skip: `“${f.name}” has no option “${bad}” here` } : item(ids.map((o) => o!.id).join(","));
    }
    case "number": return Number.isFinite(Number(v)) ? item(String(Number(v))) : { skip: `“${v}” is not a number` };
    case "date": {
      const t = Date.parse(`${v}T00:00:00`);
      return Number.isNaN(t) ? { skip: `“${v}” is not a date (write it as 2026-10-31)` } : item(String(t));
    }
    default: return item(v);
  }
}

/** A comment template filled in. An unfillable placeholder stops it: nothing is posted with “{author}” in it. */
export function resolveComment(text: string, ctx: Partial<Record<Placeholder, string>>): Extra {
  const t = fillTemplate(text, ctx);
  if (!t.text.trim()) return { skip: "the comment is empty" };
  return t.missing.length ? { skip: `the comment names ${t.missing.map((m) => `{${m}}`).join(", ")}, which is not known here` } : { item: { kind: "comment", text: t.text } };
}

/** What a step's comment and field blocks will do here, given the values (the template, or what the person typed). */
export function extrasOf(blocks: readonly StepBlock[], o: { fields: readonly ListField[] | null | undefined; ctx: Partial<Record<Placeholder, string>>; commentText?: string; fieldValue?: string }): Extra[] {
  const out: Extra[] = [];
  const fd = blocks.find((b): b is Extract<StepBlock, { type: "field" }> => b.type === "field");
  if (fd) out.push(resolveField(o.fields, { field: fd.field, value: o.fieldValue ?? fd.value }));
  const cm = blocks.find((b): b is Extract<StepBlock, { type: "comment" }> => b.type === "comment");
  /* An asked comment is already what the person wants posted: only a fixed one is a template to fill. */
  if (cm) out.push(o.commentText !== undefined ? (o.commentText.trim() ? { item: { kind: "comment", text: o.commentText } } : { skip: "the comment is empty" }) : resolveComment(cm.text, o.ctx));
  return out;
}

/** The placeholders' values from what the place knows. */
export function prContext(o: { pr?: { number: number; title: string; url?: string }; author?: { login?: string; name?: string } | null; status?: string; me?: string }): Partial<Record<Placeholder, string>> {
  return {
    ...(o.pr ? { pr: `#${o.pr.number} ${o.pr.title}`, ...(o.pr.url ? { pr_url: o.pr.url } : null) } : null),
    ...(o.author?.name || o.author?.login ? { author: o.author.name || o.author.login! } : null),
    ...(o.status ? { status: o.status } : null),
    ...(o.me ? { me: o.me } : null),
  };
}

/** Send them: the fields in order, then the comment, one request each, stopping at the first that fails. */
export async function runExtras(
  items: readonly ExtraItem[],
  io: { field: (id: string, value: string, kind: string) => Promise<{ ok: boolean; error?: string }>; comment: (text: string) => Promise<{ ok: boolean; error?: string }> },
): Promise<{ ok: boolean; done: string[]; error?: string }> {
  const done: string[] = [];
  const ordered = [...items.filter((i) => i.kind === "field"), ...items.filter((i) => i.kind === "comment")];
  for (const i of ordered) {
    const r = i.kind === "field" ? await io.field(i.fieldId, i.value, i.fieldKind).catch(() => ({ ok: false, error: "Could not reach the server" })) : await io.comment(i.text).catch(() => ({ ok: false, error: "Could not reach the server" }));
    if (!r.ok) return { ok: false, done, error: `${i.kind === "field" ? `setting ${i.name}` : "the comment"}: ${r.error || "ClickUp refused"}` };
    done.push(i.kind === "field" ? `${i.name} → ${i.shown}` : "commented");
  }
  return { ok: true, done };
}
