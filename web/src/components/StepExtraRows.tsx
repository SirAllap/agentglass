import { useEffect, useState } from "react";
import { Select } from "./Select.tsx";
import { INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { PLACEHOLDERS, PLACEHOLDER_HELP } from "../../../shared/stepBlocks.ts";
import { FIELD_KINDS } from "../lib/stepExtras.ts";
import type { StepBlock } from "../../../shared/providers.ts";

/*
 * The rows of the two blocks that have more to say than one value: the comment's text and the field's name and value.
 *
 * Each is edited in place and saved when it is left (a blur, a pick), not on every key: a settings save is a write to a
 * file, and a sentence typed in one go is one save. The field's name and its dropdown values are the app's own
 * Select, read from the fields of the lists this person works in (see ClickUpPane.readFields), so what is offered is
 * what those lists have; a name the lists no longer have is kept and said so, never dropped.
 */

/** One custom field as the picker knows it: by name, because ids differ from list to list. */
export interface FieldChoice { name: string; type: string; options?: { id: string; name: string }[] }

type Comment = Extract<StepBlock, { type: "comment" }>;
type Field = Extract<StepBlock, { type: "field" }>;
const hint = (t: string) => <span className="text-[11px]" style={{ color: "var(--text3)" }}>{t}</span>;

export function CommentEditor({ block, frozen, onChange }: { block: Comment; frozen?: boolean; onChange: (b: Comment) => void }) {
  const [text, setText] = useState(block.text);
  useEffect(() => setText(block.text), [block.text]);
  return (
    <div className="flex flex-col gap-1" data-comment-editor="">
      <textarea value={text} rows={2} disabled={frozen} spellCheck aria-label="The comment" onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text.trim() && text !== block.text) onChange({ ...block, text }); else setText(block.text); }}
        className={`w-full ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto", resize: "vertical", padding: "6px 8px" }} />
      {hint(`${block.ask ? "The person edits this when it runs, starting from it. " : ""}${PLACEHOLDERS.map((n) => `{${n}}`).join(" ")} are filled in: ${PLACEHOLDERS.map((n) => `{${n}} ${PLACEHOLDER_HELP[n]}`).join("; ")}.`)}
    </div>
  );
}

export function FieldEditor({ block, fields, frozen, onChange }: { block: Field; fields: FieldChoice[] | null; frozen?: boolean; onChange: (b: Field) => void }) {
  const known = fields?.find((f) => f.name.trim().toLowerCase() === block.field.trim().toLowerCase());
  const kind = known ? FIELD_KINDS[known.type] : undefined;
  const [value, setValue] = useState(block.value);
  useEffect(() => setValue(block.value), [block.value]);
  const commit = (v: string) => { if (v.trim() && v !== block.value) onChange({ ...block, value: v.trim() }); else setValue(block.value); };
  const names = fields?.map((f) => f.name) ?? [];
  return (
    <div className="flex items-center gap-2 flex-wrap" data-field-editor="">
      <Select value={block.field} align="left" disabled={frozen} title="The custom field"
        onChange={(name) => { const f = fields?.find((x) => x.name === name); onChange({ ...block, field: name, value: f?.options?.[0]?.name ?? "" } as Field); }}
        options={[...(names.includes(block.field) ? [] : [{ value: block.field, label: block.field }]), ...names.map((n) => ({ value: n, label: n }))]} />
      {kind === "option" && known && (
        <Select value={block.value} align="left" disabled={frozen} title="The value" placeholder="Pick a value"
          onChange={(v) => onChange({ ...block, value: v })}
          options={[...(known.options?.some((o) => o.name === block.value) || !block.value ? [] : [{ value: block.value, label: block.value }]), ...(known.options ?? []).map((o) => ({ value: o.name, label: o.name }))]} />
      )}
      {kind !== "option" && (
        <input value={value} disabled={frozen} aria-label="The value" spellCheck={false}
          type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
          placeholder={kind === "options" ? "label, label" : kind === "date" ? "2026-10-31" : "value"}
          onChange={(e) => setValue(e.target.value)} onBlur={() => commit(value)} onKeyDown={(e) => { if (e.key === "Enter") commit(value); }}
          className={INPUT} style={{ ...INPUT_STYLE, width: 200 }} />
      )}
      {fields && !known && block.field && hint("Not a field of the lists you work in: it is kept, and skipped where a card's list does not have it.")}
    </div>
  );
}
