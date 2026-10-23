/*
 * The small editors of a card's own fields, apart from any tracker.
 *
 * They were drawn inside TasksPanel next to the ClickUp calls that feed them,
 * which kept the second tracker's card from using them without copying them.
 * What is here knows nothing of `Pending` or `api`: it is handed a value and
 * says what the person chose, and the caller decides what a choice costs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon } from "../CloseButton.tsx";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import { dayToMs, msToDay, tagChoices } from "../../lib/cardEdits.ts";
import { Flag, prioLook } from "../../lib/priority.tsx";
import { schemeOfTheme } from "../../lib/schemeOfTheme.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";
import { edge } from "../git/ui.tsx";
import type { ProviderTask } from "../../../../shared/providers.ts";

/**
 * One thing you can do to a comment.
 *
 * They were four bare words in a row — Reply Edit Resolve Delete — under the
 * paragraph, which reads as a line of text somebody forgot to delete rather
 * than as controls. An icon, a label, a border and the compact control height
 * each (`CTRL_H.compact`, a control inside a card); the destructive one keeps
 * its own colour and is held apart from the other three by a rule.
 */
export function CommentAction({ label, title, d, onClick, busy, on, tone, iconOnly }: {
  label: string; title: string; d: string;
  /** The label stays as the tooltip and aria-label; only the glyph is drawn. */
  iconOnly?: boolean;
  onClick: () => void;
  busy?: boolean;
  /** Already in that state — Resolve on a resolved comment. */
  on?: boolean;
  tone?: string;
}) {
  const colour = on ? (tone ?? "var(--success, #98c379)") : tone && label === "Delete" ? tone : "var(--text3)";
  return (
    <button onClick={onClick} disabled={busy} title={title} aria-label={title} aria-pressed={on || undefined}
      className={`agx-btn inline-flex items-center justify-center gap-1 rounded-md text-[10.5px] ${iconOnly ? "" : "px-1.5"}`}
      style={{
        height: CTRL_H.compact,
        ...(iconOnly ? { width: CTRL_H.compact } : null),
        color: colour,
        border: `1px solid color-mix(in srgb, ${on ? (tone ?? "var(--success, #98c379)") : "var(--text)"} ${on ? 40 : 14}%, transparent)`,
        background: on ? `color-mix(in srgb, ${tone ?? "var(--success, #98c379)"} 12%, transparent)` : "transparent",
      }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
      {!iconOnly && label}
    </button>
  );
}


/**
 * A value on the card that can be typed over.
 *
 * Reads as text until it is clicked, which is the point: the card is READ far
 * more often than it is edited, and a column of input boxes turns a card into a
 * form. Enter saves, Escape puts it back, and leaving the box saves too —
 * because a value typed and then clicked away from is a value somebody meant.
 *
 * An empty box is a CLEAR, not a cancel. See cardEdits.ts: taking a due date
 * off is an edit people need, and a control that can only ever set one cannot.
 */
export function EditText({ value, empty, title, width, busy, parse, onSave, wrap, textClass }: {
  value: string;
  /** Let a long value take lines instead of being cut off, and fill the width when it is typed over (a title). */
  wrap?: boolean;
  /** The reading text's own size and weight, where it is not a small detail. */
  textClass?: string;
  /** What to draw when there is nothing — the invitation, not a dash. */
  empty: string;
  title: string;
  width?: number;
  busy: boolean;
  /** Refuse a value here rather than sending it and reporting ClickUp's 400. */
  parse: (raw: string) => { ok: boolean; error?: string };
  onSave: (raw: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [why, setWhy] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) box.current?.select(); }, [editing]);

  const save = () => {
    const check = parse(draft);
    if (!check.ok) { setWhy(check.error ?? "that is not a value"); return; }
    setWhy("");
    setEditing(false);
    if (draft.trim() !== value.trim()) onSave(draft);
  };

  if (!editing) {
    return (
      <button className={`agx-btn rounded text-left max-w-full ${wrap ? "" : "truncate"} ${textClass ?? ""}`} title={busy ? "Saving…" : title}
        disabled={busy} onClick={() => setEditing(true)}
        style={{ color: value ? (textClass ? "inherit" : "var(--text2)") : "var(--text4)" }}>
        {busy
          ? <span className="agx-spin inline-block align-middle" aria-label="Saving" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
          : (value || empty)}
      </button>
    );
  }
  return (
    <span className={`inline-flex flex-col gap-0.5 ${wrap ? "w-full" : ""}`}>
      <input ref={box} value={draft} autoFocus
        onChange={(e) => { setDraft(e.target.value); setWhy(""); }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          // Escape closes the box and nothing else: it must not reach the modal
          // behind it, which would close the whole card mid-edit.
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(value); setWhy(""); setEditing(false); }
        }}
        className="text-[11.5px] px-1.5 py-0.5 rounded outline-none"
        style={{ background: "var(--bg)", color: "var(--text)", border: EDGE, width: wrap ? "100%" : width ?? 90 }} />
      {why && <span className="text-[10px]" style={{ color: "var(--error-ink)" }}>{why}</span>}
    </span>
  );
}

/** A date on the card, in the reader's own day. The button beside it is how a
 *  date comes OFF, which the picker itself has no way to say. */
export function EditDay({ value, busy, title, onSave }: {
  value: number | null; busy: boolean; title: string; onSave: (ms: number | null) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input type="date" value={msToDay(value)} disabled={busy} title={title}
        onChange={(e) => onSave(dayToMs(e.target.value))}
        className="text-[11px] px-1.5 py-0.5 rounded outline-none"
        style={{ background: "transparent", color: "var(--text2)", border: EDGE, colorScheme: schemeOfTheme() }} />
      {value != null && !busy && (
        <button className="agx-btn rounded text-[10px]" style={{ color: "var(--text4)" }}
          title="Clear this date" onClick={() => onSave(null)}>Clear</button>
      )}
      {busy && <span className="agx-spin" aria-label="Saving" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />}
    </span>
  );
}

/**
 * The flag, as a control — a tracker's own priority field, first class on the card.
 *
 * It was on the row and in the header and could not be changed from here, which
 * made the one field a ClickUp board is ordered by the one field this app could
 * only read. And a card whose list has no "Urgency" drop-down showed no
 * priority ANYWHERE on the card body: the header chip was the whole of it.
 *
 * "None" is offered like any other value. Most cards have no priority, and a
 * picker that can only raise the flag cannot put it back down.
 *
 * What a choice does is the caller's: this draws the menu and reports the id
 * and label picked, with "" for Clear.
 */
export function PriorityMenu({ value, options, writable, busy, onChoose, clearable = true }: {
  /** The id of the option it has now, or null for none. ClickUp's ids are its four ranks; Jira's are the site's own. */
  value: string | null;
  options: readonly { id: string; label: string; c: string }[];
  writable: boolean; busy: boolean;
  onChoose: (id: string, label: string) => void;
  /** Whether "Clear" is offered: Jira has no card without a priority once it has one. */
  clearable?: boolean;
}) {
  const look = options.find((o) => o.id === value) ?? prioLook(value as ProviderTask["priority"]);
  /* The app's one dropdown, with the flag as the option's mark. Only the control changed; the write is the one it always was. */
  const all = [...options, ...(clearable ? [{ id: "", label: "Clear", c: "var(--text4)" }] : [])];
  const now = value ?? "";
  return (
    <Select value={now} busy={busy} disabled={!writable} title={busy ? "Moving the flag…" : writable ? "Set this card's priority" : "Priority"}
      className="text-left rounded flex items-center gap-1.5 px-1.5 py-0.5 -mx-1.5 hover:bg-white/5 disabled:cursor-default text-[11px]"
      style={{ color: look.c }}
      onChange={(id) => { if (id === now) return; const o = all.find((x) => x.id === id); if (o) onChoose(o.id, o.label); }}
      options={[
        ...(now ? [] : [{ value: "", label: look.label, icon: <Flag c={look.c} on={false} />, tint: "var(--text4)" }]),
        ...all.filter((o) => (o.id !== "" || !!now)).map((o) => ({ value: o.id, label: o.label, icon: <Flag c={o.c} on={!!o.id} />, tint: o.id ? o.c : "var(--text3)" })),
      ]} />
  );
}

/** A card's tags, with the two things a tag needs: taking one off, and adding
 *  one. Both by NAME — neither tracker gives a tag an id worth holding. */
/*
 * ADDING ONE USED TO BE TYPING IT BLIND.
 *
 * "the ones already created don't show up for me to pick from properly… it just
 * opens an input". It did: an empty box, and whatever you typed became a tag. Two
 * things go wrong with that on a board somebody else set up — you cannot
 * remember the names, and a near miss (`bug intake` for `bug-intake`) makes a
 * second tag that looks like the first and filters like neither.
 *
 * So it offers what the caller says already exists and keeps the typing for the
 * case that has no answer yet: a name nobody has used, which is still one
 * keystroke away because a tag is created by being put on a card.
 *
 * Where the names come from is the caller's: `suggestions` is whatever it has,
 * and `onOpen` is the moment to go and read the rest, so the names are fetched
 * when the box opens rather than with every card that is drawn.
 */
export function TagEditor({ tags, suggestions, busy, onAdd, onRemove, onOpen, noun = "tag" }: {
  tags: string[];
  /** What the tracker calls one: ClickUp's tags, Jira's labels. */
  noun?: string;
  /** Names already in use, in the order they should be offered. */
  suggestions: string[];
  busy: boolean;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  /** Called each time the add box opens, so the caller can read more names. */
  onOpen?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [hot, setHot] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useCloseWithOwner(() => { setAdding(false); setDraft(""); }, { open: adding, from: box });

  useEffect(() => {
    if (!adding) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setAdding(false); setDraft(""); } };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [adding]);

  /* On opening rather than on mount: a board is drawn far more often than a
     tag is added. */
  useEffect(() => { if (adding) onOpen?.(); }, [adding]);

  const known = suggestions;
  const typed = draft.trim();
  const { rows, newAt, creating: canCreate } = useMemo(() => tagChoices(known, tags, typed), [known, tags, typed]);

  const add = (name: string) => {
    setDraft("");
    setHot(0);
    setAdding(false);
    const tag = name.trim();
    if (!tag || tags.includes(tag)) return;
    onAdd(tag);
  };

  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded-md"
          style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--text) 7%, transparent)", border: EDGE }}>
          {tag}
          <button className="agx-btn rounded flex" title={`Remove ${tag}`} disabled={busy}
            style={{ color: "var(--text4)" }}
            onClick={() => onRemove(tag)}><CloseIcon size={ICON.xs} /></button>
        </span>
      ))}
      <span className="relative inline-block" ref={box}>
        {adding
          ? <input value={draft} autoFocus placeholder={known.length ? "Filter or type a new one" : noun}
              onChange={(e) => { setDraft(e.target.value); setHot(0); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  /* What is highlighted, and the typed name when the list is
                     empty — Enter on a name nobody uses is the whole point. */
                  const pick = rows[hot] ?? (canCreate ? typed : "");
                  if (pick) add(pick);
                  return;
                }
                if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, Math.max(rows.length - 1, 0))); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); return; }
                /* Stopped, or Escape closes the card behind this list. */
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(""); setAdding(false); }
              }}
              className="text-[11px] px-1.5 py-0.5 rounded outline-none"
              style={{ background: "var(--bg)", color: "var(--text)", border: EDGE, width: 170 }} />
          : <button className="agx-btn rounded text-[10.5px]" style={{ color: "var(--text4)" }}
              title={`Add a ${noun}`} disabled={busy} onClick={() => { setAdding(true); setHot(0); }}>+ {noun}</button>}
        {adding && (
          <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto py-1"
            style={{ zIndex: 30, background: "var(--surface-card)", border: edge(28), minWidth: 190, maxHeight: 260 }}>
            {!rows.length && (
              <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
                {/* "in this space", not "on this board": the list is the whole
                    space's now, so naming the board would send somebody looking
                    for a tag that the message has already ruled out. */}
                {known.length ? "Nothing in this space is called that." : `No ${noun}s here yet — type one.`}
              </div>
            )}
            {rows.map((name, i) => {
              const isNew = i === newAt;
              return (
                <button key={`${isNew ? "new:" : ""}${name}`} type="button"
                  onMouseEnter={() => setHot(i)}
                  /* mousedown, not click: the input's blur would close this
                     list before a click landed on it. */
                  onMouseDown={(e) => { e.preventDefault(); add(name); }}
                  className="text-left px-2.5 py-1.5 text-[11px] truncate flex items-center gap-1.5"
                  style={{ background: i === hot ? "color-mix(in srgb, var(--text) 8%, transparent)" : "transparent" }}>
                  {isNew && <span className="shrink-0 text-[10px]" style={{ color: "var(--info-ink)" }}>+</span>}
                  <span className="truncate" style={{ color: isNew ? "var(--info)" : "var(--text2)" }}>{name}</span>
                  {isNew && <span className="shrink-0 text-[9.5px]" style={{ color: "var(--text4)" }}>new {noun}</span>}
                </button>
              );
            })}
          </div>
        )}
      </span>
    </span>
  );
}

