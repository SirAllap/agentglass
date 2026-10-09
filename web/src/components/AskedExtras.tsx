import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { listMembers } from "../lib/listMembers.ts";
import { Select } from "./Select.tsx";
import { INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { fillTemplate, planOf, type Placeholder } from "../../../shared/stepBlocks.ts";
import type { ListField, StepBlock } from "../../../shared/providers.ts";
import { FIELD_KINDS, extrasOf, runExtras, type Extra, type ExtraItem } from "../lib/stepExtras.ts";

/**
 * What a step's comment and field blocks do where it runs, shown before they do it.
 *
 * A fixed block is a line saying what will be posted or set (and, if it cannot be, why not: a field this card's
 * list does not have, a placeholder this place cannot fill). A block that asks is the control itself, starting
 * from the setting: the comment as an editable text prefilled with the template filled in, the field's value as
 * the app's own Select (a drop-down) or an input. What it holds goes back through `onChange` on every change, so
 * what is sent is what is on screen.
 */
export function AskedExtras({ blocks, fields, ctx, listId, onChange }: {
  blocks: readonly StepBlock[];
  fields: readonly ListField[] | null;
  ctx: Partial<Record<Placeholder, string>>;
  /** For `{me}`: the people of the card's list, read only when a template names it. */
  listId?: string;
  onChange: (items: ExtraItem[]) => void;
}) {
  const plan = planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [...blocks] });
  const [me, setMe] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!listId || !plan.comment || !plan.comment.text.includes("{me}")) return;
    let live = true;
    void listMembers(listId).then((r) => { if (live && r?.ok) setMe(r.members?.find((m) => m.me)?.name); }).catch(() => {});
    return () => { live = false; };
  }, [listId, plan.comment?.text]);
  const full = useMemo(() => (me ? { ...ctx, me } : ctx), [JSON.stringify(ctx), me]);
  const start = useMemo(() => (plan.comment ? fillTemplate(plan.comment.text, full).text : ""), [plan.comment?.text, JSON.stringify(full)]);
  const [text, setText] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const commentText = plan.comment?.ask ? (text ?? start) : undefined;
  const fieldValue = plan.field?.ask ? (value ?? plan.field.value) : undefined;
  const results: Extra[] = extrasOf(blocks, { fields, ctx: full, ...(commentText !== undefined ? { commentText } : null), ...(fieldValue !== undefined ? { fieldValue } : null) });
  const items = results.flatMap((r) => ("item" in r ? [r.item] : []));
  const key = JSON.stringify(items);
  useEffect(() => { onChange(items); }, [key]);
  const known = plan.field ? fields?.find((f) => f.name.trim().toLowerCase() === plan.field!.field.trim().toLowerCase()) : undefined;
  const kind = known ? FIELD_KINDS[known.type] : undefined;
  const label = { color: "var(--text3)", fontSize: 10.5, textTransform: "uppercase" as const, letterSpacing: "0.04em" };
  const skips = results.flatMap((r) => ("skip" in r ? [r.skip] : []));
  if (!plan.comment && !plan.field) return null;
  return (
    <div className="mt-3 grid items-start gap-y-2" style={{ gridTemplateColumns: "84px 1fr" }} data-extras="">
      {plan.field && <>
        <div style={label}>{plan.field.field}</div>
        {plan.field.ask
          ? (kind === "option" && known
            ? <Select value={fieldValue ?? ""} onChange={setValue} align="left" title={plan.field.field} placeholder="Pick a value"
                options={[{ value: "", label: "leave it as it is" }, ...(known.options ?? []).map((o) => ({ value: o.name, label: o.name }))]} />
            : <input value={fieldValue ?? ""} onChange={(e) => setValue(e.target.value)} aria-label={plan.field.field} spellCheck={false}
                type={kind === "number" ? "number" : kind === "date" ? "date" : "text"} className={INPUT} style={{ ...INPUT_STYLE, width: 220 }} />)
          : <span className="text-[11.5px]" style={{ color: "var(--text2)" }}>set to <b>{plan.field.value}</b></span>}
      </>}
      {plan.comment && <>
        <div style={label}>Comment</div>
        {plan.comment.ask
          ? <textarea value={commentText ?? ""} onChange={(e) => setText(e.target.value)} rows={3} aria-label="The comment" spellCheck
              className={`w-full ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto", resize: "vertical", padding: "6px 8px" }} />
          : <span className="text-[11.5px]" style={{ color: "var(--text2)" }}>“{start}”</span>}
      </>}
      {skips.length > 0 && <div className="col-span-2 text-[10.5px]" role="status" style={{ color: "var(--warning-ink)" }}>Not done: {skips.join("; ")}.</div>}
    </div>
  );
}

/** Send what the dialog showed: the fields, then the comment, one request each (see lib/stepExtras). */
export const sendExtras = (taskId: string, items: readonly ExtraItem[]) => runExtras(items, {
  field: (id, value, kind) => api.clickupField(taskId, id, value, kind),
  comment: (text) => api.clickupComment(taskId, text),
});
