/*
 * The list + editor page type: what you keep a list of (commands, review
 * prompts, saved replies) on the left, the one you picked on the right.
 *
 * It is the page's own layout, not a kit card: the kit's cards are a flow of
 * groups of settings, and this is two panes that stay side by side. A page
 * using it opens with the bar (filter, and what narrows the list), then the
 * split. The one open item is a draft the pane holds; the foot says whether
 * the draft differs from what is saved, and Save is the only thing that writes.
 *
 * Under 760px of page the two stack, the list first.
 */
import type { ReactNode } from "react";
import { ICON } from "../lib/iconSize.ts";
import { IconLabel, PlusIcon, SearchIcon } from "../lib/glyphIcons.tsx";
import { Button, FilterField, Segmented } from "./workspace/Chrome.tsx";
import { StatusBadge, type StatusTone } from "./SettingsKit.tsx";

export interface ListEntry {
  id: string;
  title: ReactNode;
  /** The second line: what it does, or the command it runs. */
  sub?: ReactNode;
  /** Small labels after the title ("pinned", "ask"). */
  tags?: string[];
  /** Whatever else belongs after the title, e.g. a launch-mode badge. */
  badge?: ReactNode;
}

export interface ListSection {
  id: string;
  /** Left out for a flat list: the head then carries only `flatLabel`. */
  title: string;
  entries: ListEntry[];
  onAdd?: () => void;
  addLabel?: string;
  /** Said under the head when the section has nothing to list. */
  empty?: ReactNode;
}

/** The bar over the split: a filter, an optional narrowing control, anything else at the end. */
export function ListBar<F extends string>({ q, onQ, placeholder, label, filters, filter, onFilter, children }: {
  q: string; onQ: (v: string) => void; placeholder: string; label: string;
  filters?: { id: F; label: string }[]; filter?: F; onFilter?: (v: F) => void;
  children?: ReactNode;
}) {
  return (
    <div className="agx-le-bar">
      <span className="agx-le-q">
        <SearchIcon size={ICON.sm} />
        <FilterField value={q} onChange={onQ} placeholder={placeholder} label={label} />
      </span>
      {filters && filter !== undefined && onFilter && (
        <Segmented<F> track value={filter} options={filters.map((f) => ({ id: f.id, label: f.label }))} onChange={onFilter} label={`Narrow ${label.toLowerCase()}`} />
      )}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** The New button of a page, the one the redesign puts in the page header; kit gap: a pane cannot reach that slot. */
export function NewButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button tone="primary" onClick={onClick} disabled={disabled}>
      <IconLabel icon={<PlusIcon size={ICON.xs} />}>{children}</IconLabel>
    </Button>
  );
}

export function ListEditorSplit({ list, editor }: { list: ReactNode; editor: ReactNode }) {
  return <div className="agx-le">{list}{editor}</div>;
}

/** A list with nothing in it at all, as opposed to a filter that matched nothing. */
export interface ListBlank {
  icon: ReactNode;
  title: string;
  /** One sentence: what an entry is, and where it ends up. */
  text: ReactNode;
  /** What fills the list, the same action as the bar's. */
  action: ReactNode;
}

export function ListPanel({ sections, selected, onSelect, nothing, blank }: {
  sections: ListSection[]; selected: string | null; onSelect: (id: string) => void;
  /** Shown when the filter leaves nothing in any section. */
  nothing?: ReactNode;
  /** Shown instead of the sections when there is nothing to filter: one sentence and the action that fills it. */
  blank?: ListBlank;
}) {
  const none = sections.every((s) => !s.entries.length);
  if (blank) {
    return (
      <div className="agx-le-list agx-le-blank">
        <span aria-hidden className="agx-le-art">{blank.icon}</span>
        <h3>{blank.title}</h3>
        <p>{blank.text}</p>
        {blank.action}
      </div>
    );
  }
  return (
    <div className="agx-le-list">
      {sections.map((s) => (
        <div key={s.id} role="group" aria-label={s.title}>
          <div className="agx-le-lg">
            <b>{s.title}</b>
            <span className="agx-le-n">{s.entries.length}</span>
            {s.onAdd && (
              <button type="button" className="agx-le-add" aria-label={s.addLabel ?? `New in ${s.title}`}
                title={s.addLabel ?? `New in ${s.title}`} onClick={s.onAdd}>
                <PlusIcon size={ICON.sm} />
              </button>
            )}
          </div>
          {s.entries.map((e) => (
            <button type="button" key={e.id} className="agx-le-li" aria-current={e.id === selected ? "true" : undefined}
              onClick={() => onSelect(e.id)}>
              <span className="agx-le-t">{e.title}{e.tags?.map((t) => <span key={t} className="agx-le-tag">{t}</span>)}{e.badge}</span>
              {e.sub && <span className="agx-le-s">{e.sub}</span>}
            </button>
          ))}
          {!s.entries.length && s.empty && <div className="agx-le-empty">{s.empty}</div>}
        </div>
      ))}
      {none && nothing && <div className="agx-le-empty">{nothing}</div>}
    </div>
  );
}

/** The editor card: a head (title, state chips, actions), the form, the foot. */
export function EditorPanel({ title, chips, actions, children, label }: {
  title: ReactNode;
  chips?: { tone: StatusTone; text: string }[];
  actions?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <section className="agx-le-ed" aria-label={label}>
      <div className="agx-le-eh">
        <h3 className="agx-le-et">{title}</h3>
        {chips?.map((c) => <StatusBadge key={c.text} tone={c.tone}>{c.text}</StatusBadge>)}
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

/** What the form's foot says. `dirty` is the draft differing from what is saved; `busy` is the write being out. */
export function EditorFoot({ dirty, canSave, noun, onCancel, busy }: {
  dirty: boolean; canSave: boolean; noun: string; onCancel: () => void; busy?: boolean;
}) {
  return (
    <div className="agx-le-foot" data-dirty={dirty ? "true" : undefined} data-busy={busy ? "true" : undefined}>
      {busy ? <span className="agx-spin" aria-hidden /> : <i aria-hidden />}
      <span role="status">{busy ? `Saving ${noun}…` : dirty ? "Unsaved changes" : "All changes saved"}</span>
      <span className="flex-1" />
      {(dirty || busy) && <Button onClick={onCancel} disabled={busy}>Cancel</Button>}
      {(dirty || busy) && <Button type="submit" tone="primary" pending={busy} disabled={!canSave || busy}>{busy ? "Saving…" : `Save ${noun}`}</Button>}
    </div>
  );
}

/** Nothing picked, or nothing at all: the editor side says so and offers the one next step. */
export function NothingSelected({ noun, onNew, label }: { noun: string; onNew: () => void; label: string }) {
  return (
    <section className="agx-le-ed agx-le-none" aria-label={label}>
      <b>Nothing selected</b>
      <span>Pick one on the left, or make a new {noun}.</span>
      <NewButton onClick={onNew}>{`New ${noun}`}</NewButton>
    </section>
  );
}

/** The draft differs from the saved one: field by field, so key order does not matter. */
export function differs<T extends object>(a: T | null, b: T | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = (a as Record<string, unknown>)[k], y = (b as Record<string, unknown>)[k];
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) return true;
  }
  return false;
}
