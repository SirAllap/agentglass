/*
 * The person's merge lock on a pull request (shared/mergeLock.ts): the badge on
 * the drawer's header, the "Lock merge" button next to Merge, and the editor
 * both of those and the card's menu open. The server refuses every merge while
 * the lock holds; this only shows it and lets the person change it.
 */
import { useState } from "react";
import { GitDialog } from "./GitDialog.tsx";
import { Button, CTRL_H, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { CrossIcon, LockIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { tipAttr as tip } from "../lib/tip.ts";
import { api } from "../lib/api.ts";
import { noteMergeLock, useMergeLocks } from "../lib/mergeLocks.ts";
import type { MergeLockItem } from "../../../shared/mergeLock.ts";

/** `<input type="datetime-local">` speaks local wall time with no zone. */
const two = (n: number) => String(n).padStart(2, "0");
export function toLocalInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function fromLocalInput(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime() : null;
}

/** The lock on the drawer's header, while it holds. */
export function MergeLockBadge({ root, number }: { root: string; number: number }) {
  const row = useMergeLocks(root).get(number);
  if (!row?.state.locked) return null;
  return (
    <span data-merge-lock="" aria-label={`Merge locked. ${row.state.reason}`} data-tip={tip({ name: "Merge locked", text: row.state.reason })}
      className="inline-flex items-center gap-1 px-2 rounded-lg text-[11px] font-semibold shrink-0 leading-none"
      style={{ height: CTRL_H.hit, color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--warning) 30%, transparent)" }}>
      <LockIcon size={ICON.xs} />Locked
    </span>
  );
}

/** Next to Merge in the drawer: "Lock merge", or "Edit lock" when there is one. */
export function MergeLockButton({ root, number, title }: { root: string; number: number; title: string }) {
  const [open, setOpen] = useState(false);
  const row = useMergeLocks(root).get(number);
  const name = row ? "Edit lock" : "Lock merge";
  return (
    <>
      <Button size="hit" square aria-label={name} data-merge-lock-button=""
        data-tip={tip({ name, text: row?.state.locked ? row.state.reason : "Block this merge until a date, a checklist or another pull request." })}
        onClick={() => setOpen(true)}>
        <LockIcon size={ICON.sm} open={!row?.state.locked} />
      </Button>
      {open && <MergeLockEditor root={root} number={number} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

let seq = 0;
const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Set, edit, tick, and the typed "Unlock now". */
export function MergeLockEditor({ root, number, title, onClose }: { root: string; number: number; title: string; onClose: () => void }) {
  const row = useMergeLocks(root).get(number);
  const had = row?.lock ?? null;
  const [until, setUntil] = useState(toLocalInput(had?.until ?? null));
  const [items, setItems] = useState<MergeLockItem[]>(had?.items ?? []);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(had?.note ?? "");
  const [afterPr, setAfterPr] = useState(had?.afterPr != null ? String(had.afterPr) : "");
  const [confirm, setConfirm] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const allItems = draft.trim() ? [...items, { id: newId(), text: draft.trim(), done: false }] : items;
  const untilMs = until ? fromLocalInput(until) : null;
  const empty = untilMs == null && allItems.length === 0 && !afterPr.trim();

  const done = (r: { ok: boolean; lock?: unknown; state?: unknown; error?: string }) => {
    if (!r.ok) { setError(r.error ?? "The lock was not saved"); return false; }
    noteMergeLock(root, number, r.lock && r.state ? { lock: r.lock, state: r.state } as never : null);
    return true;
  };
  const save = async () => {
    setSending(true); setError(null);
    try {
      const r = await api.mergeLockSet(root, number, { until: untilMs, items: allItems, note, afterPr: afterPr.trim() ? Number(afterPr.replace(/^#/, "")) : null });
      if (done(r)) onClose();
    } catch (e) { setError(String((e as Error)?.message ?? e)); } finally { setSending(false); }
  };
  /* A tick on a saved item is its own write: it is what the person does on the
     day, and it must not also save a half-edited date. */
  const tick = async (it: MergeLockItem) => {
    const saved = had?.items.some((i) => i.id === it.id);
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)));
    if (!saved) return;
    try { done(await api.mergeLockTick(root, number, it.id, !it.done)); } catch (e) { setError(String((e as Error)?.message ?? e)); }
  };
  const unlock = async () => {
    setSending(true); setError(null);
    try { if (done(await api.mergeLockUnlock(root, number, confirm))) onClose(); }
    catch (e) { setError(String((e as Error)?.message ?? e)); } finally { setSending(false); }
  };

  if (unlocking) {
    return (
      <GitDialog title={`Unlock #${number} now?`} subtitle="The lock is lifted at once and the merge is live again. This is logged." tone="danger" danger hold
        confirmLabel="Unlock now" onConfirm={() => { void unlock(); }} confirmDisabled={sending || confirm.trim().replace(/^#/, "") !== String(number)}
        reason={error ?? `Type ${number} to unlock.`} initialFocus="input" onClose={() => setUnlocking(false)}>
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>Pull request number
          <input autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={String(number)} inputMode="numeric"
            className={`w-full ${INPUT}`} style={INPUT_STYLE} data-merge-lock-confirm="" />
        </label>
      </GitDialog>
    );
  }

  return (
    <GitDialog title={had ? `Edit the merge lock on #${number}?` : `Lock the merge of #${number}?`} subtitle={title}
      tone="warn" icon={<LockIcon size={ICON.lg} />}
      confirmLabel={had ? "Save lock" : "Lock merge"} onConfirm={() => { void save(); }} confirmDisabled={sending || empty}
      reason={error ?? (empty ? "Add a date, an item or a pull request to wait for." : "Merge stays off until every condition holds.")}
      initialFocus="input" enterConfirms={false} onClose={onClose} width={440}>
      <div className="flex flex-col gap-3" data-merge-lock-editor="">
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>Not before
          <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
        </label>
        <div className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>
          <span>Checklist</span>
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2">
              <input type="checkbox" checked={it.done} onChange={() => { void tick(it); }} aria-label={`Ticked: ${it.text}`} />
              <input value={it.text} onChange={(e) => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, text: e.target.value } : x)))}
                className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} aria-label="Item" />
              <Button size="hit" square aria-label={`Remove "${it.text}"`} data-tip={tip("Remove item")}
                onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}><CrossIcon size={ICON.sm} /></Button>
            </div>
          ))}
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add an item, e.g. step 2a is on production"
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); setItems((xs) => [...xs, { id: newId(), text: draft.trim(), done: false }]); setDraft(""); } }}
            className={`w-full ${INPUT}`} style={INPUT_STYLE} aria-label="New item" />
        </div>
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>After this pull request is merged (optional)
          <input value={afterPr} onChange={(e) => setAfterPr(e.target.value)} placeholder="#1041" inputMode="numeric" className={`w-full ${INPUT}`} style={INPUT_STYLE} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>Note (optional)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`w-full resize-none ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto", minHeight: 48 }} />
        </label>
        {had && (
          <div className="flex items-center justify-between gap-2 text-[11.5px]" style={{ color: "var(--text3)" }}>
            <span>{row?.state.locked ? row.state.reason : "Every condition holds: merge is live."}</span>
            <Button size="hit" tone="danger" onClick={() => { setConfirm(""); setError(null); setUnlocking(true); }}>Unlock now</Button>
          </div>
        )}
      </div>
    </GitDialog>
  );
}
