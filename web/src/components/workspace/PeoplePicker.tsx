/*
 * The one people picker: reviewers and assignees, and the shell the card half
 * hangs under.
 *
 * Everything it lists is decided in lib/prAskWho.ts (the rows, the sections,
 * who cannot be asked and why, the keyboard steps); this draws it. Keys, with
 * the search box keeping the focus the whole time: Up and Down move the current
 * row over the ones that can be chosen, Home and End jump to the first and last
 * (with an empty box; with text in it they move the caret), Enter toggles the
 * current row, Space does too while the box is empty, Backspace on an empty box
 * takes the last chip off, Ctrl or Cmd with Enter is Done, Escape closes.
 *
 * It opens the way a popover should: from the corner it grew out of, in 160 ms
 * with an ease-out, and not at all for someone who asked for less motion. Moving
 * the current row is a keyboard action and has no animation.
 *
 * Rendered through a Portal under the trigger. `autoFocus` does nothing there:
 * the Portal appends its container in its own effect, after this input's commit,
 * so the focus lands on a detached node. A frame later it is in the document.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Portal } from "../Portal.tsx";
import { Avatar } from "../Avatar.tsx";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CrossIcon, DoneIcon, SearchIcon, UserIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { dropLast, stepRow, type AskMode, type AskRow, type AskView } from "../../lib/prAskWho.ts";
import { Button, EDGE, INPUT, INPUT_STYLE, LINE, Segmented } from "./Chrome.tsx";
import type { ReviewerState } from "../../lib/prReviewers.ts";

export type PickerLoad = "ready" | "loading" | "error";

const TAG: Partial<Record<ReviewerState, { ink: string; said: string }>> = {
  approved: { ink: "var(--success)", said: "approved" },
  awaiting: { ink: "var(--warning)", said: "awaiting" },
  changes: { ink: "var(--error)", said: "changes requested" },
  commented: { ink: "var(--text3)", said: "commented" },
  dismissed: { ink: "var(--text4)", said: "dismissed" },
};

/** The first line with the typed text lit, when it matched there. */
function Marked({ row }: { row: AskRow }) {
  if (!row.mark) return <>{row.label}</>;
  const [a, b] = row.mark;
  return <>{row.label.slice(0, a)}<mark className="rounded-sm" style={{ background: "color-mix(in srgb, var(--primary) 25%, transparent)", color: "inherit" }}>{row.label.slice(a, b)}</mark>{row.label.slice(b)}</>;
}

function Face({ row, size = 22 }: { row: Pick<AskRow, "kind" | "id">; size?: number }) {
  return row.kind === "team"
    ? <span className="shrink-0 inline-flex items-center justify-center rounded-lg" style={{ width: size, height: size, background: "var(--surface-inset)" }}><UserIcon size={ICON.xs} /></span>
    : <Avatar login={row.id} size={size} />;
}

/** The dialog's own cap. It was 640, under the 857px a hand-over takes with the card half and its "Link …" box open; the viewport still caps it. */
const PP_MAX_H = 880;

export function PeoplePicker({
  title, hint, mode, onMode, view, query, onQuery, load, onRetry, repo, locked, dismissible = true,
  onToggle, onRemoveChip, onPopChip, onRerequest, onRemoveHeld, onDone, onClose, anchor, children, footer,
}: {
  title: string;
  /** One line under the title (the hand-over sentence, or why the author is not offered). */
  hint?: string;
  mode: AskMode;
  /** With it, the Reviewers | Assignees switch is drawn; a hand-over leaves it out. */
  onMode?: (m: AskMode) => void;
  view: AskView;
  query: string;
  onQuery: (q: string) => void;
  load: PickerLoad;
  onRetry: () => void;
  /** `owner/name`, for the sentence that says what could not be read. */
  repo: string;
  /** A request is in flight or a failure is open: the list answers nothing. */
  locked?: boolean;
  /** False while a request is in flight: Escape and a click outside leave it be. */
  dismissible?: boolean;
  onToggle: (row: AskRow) => void;
  onRemoveChip: (id: string) => void;
  /** Backspace in an empty box. */
  onPopChip: () => void;
  onRerequest?: (row: AskRow) => void;
  onRemoveHeld?: (row: AskRow) => void;
  /** Ctrl or Cmd with Enter. */
  onDone: () => void;
  onClose: () => void;
  anchor: DOMRect;
  /** The card half, under the list and a hairline. */
  children?: ReactNode;
  /** The summary and the buttons. */
  footer: ReactNode;
}) {
  const W = 440;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const [cur, setCur] = useState(-1);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const canClose = useRef(dismissible); canClose.current = dismissible;
  useCloseWithOwner(onClose, { from: box });

  const rows = view.rows;
  /* A typed box makes the first row that can be chosen current, so Enter picks the top match;
     an empty box starts with none. */
  useEffect(() => { setCur(query.trim() ? stepRow(rows, -1, 1) : -1); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cur >= rows.length) setCur(rows.length ? stepRow(rows, -1, 1) : -1); }, [rows.length, cur]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  /* Whoever opened it gets the focus back. */
  useEffect(() => () => { const el = back.current as HTMLElement | null; if (el && el.isConnected) el.focus?.(); }, []);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (box.current?.contains(t as Node)) return;
      /* A menu opened FROM this picker (the card's status list) is not outside it. */
      if (t?.closest?.("[data-menu-layer]")) return;
      if (canClose.current) closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (canClose.current) closeRef.current();
    };
    const off = () => closeRef.current();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", off);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", off);
    };
  }, []);

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (locked) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(); return; }
    const empty = query === "";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCur(stepRow(rows, cur, e.key === "ArrowDown" ? 1 : -1));
    } else if ((e.key === "Home" || e.key === "End") && empty) {
      e.preventDefault();
      setCur(e.key === "Home" ? stepRow(rows, -1, 1) : stepRow(rows, rows.length, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) onDone();
      else if (cur >= 0 && rows[cur]) onToggle(rows[cur]!);
    } else if (e.key === " " && empty && cur >= 0 && rows[cur]) {
      e.preventDefault();
      onToggle(rows[cur]!);
    } else if (e.key === "Backspace" && empty && dropLast(view.chips.map((c) => c.id), query).length < view.chips.length) {
      e.preventDefault();
      onPopChip();
    }
  };

  const left = Math.round(Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8)));
  const top = Math.round(Math.min(anchor.bottom + 6, window.innerHeight - 140));
  const index = useMemo(() => new Map(rows.map((r, n) => [r.id, n])), [rows]);

  const renderRow = (r: AskRow) => {
    const n = index.get(r.id) ?? -1;
    if (r.held) {
      const tag = r.state ? TAG[r.state] : undefined;
      return (
        <div key={r.id} role="group" aria-label={`${r.label}${tag ? `, ${tag.said}` : ""}`} className="flex items-center gap-2 px-2 rounded-lg" style={{ minHeight: 40 }}>
          <Face row={r} />
          <div className="flex-1 min-w-0 grid">
            <b className="text-[12.5px] font-medium truncate"><Marked row={r} /></b>
            {r.sub && <small className="text-[11px] truncate" style={{ color: "var(--text3)" }}>{r.sub}</small>}
          </div>
          {tag && <span className="text-[10.5px] font-medium px-1.5 rounded-md" style={{ color: tag.ink, background: `color-mix(in srgb, ${tag.ink} 12%, transparent)` }}>{tag.said}</span>}
          {r.canRerequest && onRerequest && <Button size="compact" disabled={locked} label={`Ask ${r.id} again`} onClick={() => onRerequest(r)}>Re-request</Button>}
          {r.canRemove && onRemoveHeld && <Button size="compact" disabled={locked} label={`Take ${r.id} off`} onClick={() => onRemoveHeld(r)}>Remove</Button>}
        </div>
      );
    }
    const on = r.picked;
    return (
      <div key={r.id} id={`pp-${n}`} data-i={n} role="option" aria-selected={on} aria-disabled={!!r.disabled || undefined}
        title={r.disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!locked && !r.disabled) { onToggle(r); input.current?.focus(); } }}
        className="flex items-center gap-2 px-2 rounded-lg"
        style={{
          minHeight: 40, cursor: r.disabled ? "not-allowed" : "pointer", opacity: r.disabled ? 0.55 : 1,
          background: on ? "color-mix(in srgb, var(--primary) 8%, transparent)" : n === cur ? "var(--surface-inset)" : undefined,
          boxShadow: n === cur ? "inset 0 0 0 1.5px var(--primary)" : undefined,
        }}>
        <Face row={r} />
        <div className="flex-1 min-w-0 grid">
          <b className="text-[12.5px] font-medium truncate" style={{ color: "var(--text)" }}><Marked row={r} /></b>
          {(r.disabled || r.sub) && <small className="text-[11px] truncate" style={{ color: r.disabled ? "var(--text4)" : "var(--text3)" }}>{r.disabled ?? r.sub}</small>}
        </div>
        {on && <span style={{ color: "var(--primary)" }}><DoneIcon size={ICON.sm} /></span>}
      </div>
    );
  };

  return (
    <Portal>
      <div ref={box} role="dialog" aria-label={title} className="agx-pp fixed rounded-lg flex flex-col gap-2 p-2.5"
        style={{
          left, top, width: W, maxHeight: `min(${PP_MAX_H}px, calc(100vh - ${top + 12}px))`, overflowY: "auto", overflowX: "hidden",
          border: EDGE, background: "color-mix(in srgb, var(--bg2) 98%, black)", boxShadow: "0 18px 44px -18px rgba(0,0,0,.8)",
        }}>
        <div className="flex items-center gap-2">
          <b className="text-[13px] font-semibold flex-1 min-w-0 truncate" style={{ color: "var(--text)" }}>{title}</b>
          {onMode && !locked && (
            <Segmented track label="Who to ask" value={mode} onChange={onMode}
              options={[{ id: "reviewers", label: "Reviewers" }, { id: "assignees", label: "Assignees" }]} />
          )}
        </div>
        {hint && <div className="text-[11.5px]" style={{ color: "var(--text4)" }}>{hint}</div>}

        <div className="flex flex-wrap items-center gap-1" style={{ minHeight: 24 }} aria-label="Picked">
          {view.chips.length ? view.chips.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 pl-1 pr-0.5 text-[11.5px] font-medium rounded-full" style={{ height: 24, background: "var(--surface-inset)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>
              {c.team ? <UserIcon size={ICON.xs} /> : <Avatar login={c.id} size={16} />}
              {c.label}
              <button type="button" aria-label={c.remove} disabled={locked} onClick={() => onRemoveChip(c.id)}
                className="inline-flex items-center justify-center rounded-full disabled:opacity-40" style={{ width: 16, height: 16, color: "var(--text3)" }}>
                <CrossIcon size={ICON.xs} />
              </button>
            </span>
          )) : <span className="text-[11.5px]" style={{ color: "var(--text4)" }}>{view.chipsHint}</span>}
        </div>

        <label className="relative flex items-center">
          <span className="absolute left-2.5 pointer-events-none" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
          <input ref={input} value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKey}
            placeholder="Name or @login" aria-label="Search people" autoComplete="off" spellCheck={false} readOnly={locked}
            role="combobox" aria-expanded="true" aria-controls="pp-list" aria-autocomplete="list"
            {...(cur >= 0 ? { "aria-activedescendant": `pp-${cur}` } : null)}
            className={`w-full ${INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 32 }} />
        </label>

        <div ref={list} id="pp-list" role="listbox" aria-label="People" aria-multiselectable="true" aria-busy={load === "loading"}
          className="grid content-start gap-px overflow-y-auto agx-scroll -mx-1" style={{ maxHeight: 168, pointerEvents: locked ? "none" : undefined, opacity: locked ? 0.7 : 1 }}>
          {load === "loading" ? [0, 1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2 px-2" style={{ minHeight: 40 }} aria-hidden>
              <span className="agx-skeleton rounded-full" style={{ width: 22, height: 22 }} />
              <span className="flex-1 grid gap-1"><span className="agx-skeleton rounded" style={{ width: "45%", height: 11 }} /><span className="agx-skeleton rounded" style={{ width: "30%", height: 9 }} /></span>
            </div>
          )) : load === "error" ? (
            <div className="grid justify-items-center gap-1 text-center text-[12px] px-2.5 py-5" style={{ color: "var(--text3)" }}>
              <span style={{ color: "var(--error)" }}><WarningIcon size={ICON.md} /></span>
              <b style={{ color: "var(--text)" }}>GitHub did not answer</b>
              <span>Could not read the people of {repo}.</span>
              <Button size="compact" onClick={onRetry}>Try again</Button>
            </div>
          ) : view.empty ? (
            <div className="grid justify-items-center gap-1 text-center text-[12px] px-2.5 py-5" style={{ color: "var(--text3)" }}>
              <SearchIcon size={ICON.md} />
              <b style={{ color: "var(--text)" }}>{view.empty.title}</b>
              <span>{view.empty.hint}</span>
            </div>
          ) : view.sections.map((s) => (
            <div key={s.id} role="presentation" className="grid gap-px">
              {s.title && <div className="text-[10px] font-semibold uppercase tracking-wide px-2 pt-2 pb-0.5" style={{ color: "var(--text4)" }}>{s.title}</div>}
              {s.rows.map(renderRow)}
            </div>
          ))}
        </div>

        {children && <div className="pt-2 grid gap-1.5" style={{ borderTop: LINE }}>{children}</div>}
        {/* Sticky: with the card half open (a "Link bob to…" box under it) the dialog is taller than its cap and scrolls, and Cancel and Done were 219px below the fold. */}
        <div data-pp-footer className="sticky grid gap-2 -mx-2.5 px-2.5 pb-2.5 -mb-2.5 pt-1" style={{ bottom: -10, background: "color-mix(in srgb, var(--bg2) 98%, black)" }}>{footer}</div>
      </div>
    </Portal>
  );
}
