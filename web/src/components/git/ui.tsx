/*
 * The git view's visual system.
 *
 * The panel grew one section at a time and looks it: an audit of its rows found
 * type at 9.5, 10, 10.5, 11, 11.5 and 12px with no rule saying which belonged
 * where, seven different chip treatments, four ways of drawing "this row is
 * selected", and grid tracks whose widths were tuned per section until the
 * columns of one list stopped agreeing with the next. In Remotes they stopped
 * agreeing with the pane: seven tracks plus three buttons added up to more than
 * the width, and the actions landed on top of the subject.
 *
 * So the sections stop making these decisions. Everything below is the whole
 * vocabulary they get:
 *
 *   TYPE — three sizes, and they mean things. `subject` (11.5px) is the name of
 *   the object, one per row. `meta` (10px) is everything about it. `label`
 *   (9.5px, uppercase, tracked) is furniture: headings, counts, keys.
 *
 *   ROWS — one grid, one height, one hover, one selected state. The action
 *   column is a FIXED track that exists whether or not a button is drawn, which
 *   is what makes overlap impossible rather than unlikely.
 *
 *   STATE — colour carries one meaning each: success is "in sync / you have
 *   it", warning is "needs a decision", error is "gone / destructive". A chip
 *   never invents a colour outside those three plus neutral.
 *
 *   SPACE — 4px rhythm. Rows breathe at 7px vertical, sections at 14px.
 *
 * None of this is a new palette: every colour is a token the app already
 * defines, and the sizes come off `iconSize.ts`'s reasoning — icons at 1.4-1.6x
 * their neighbouring text, text at the two sizes this UI already sets most.
 */
import type { CSSProperties, ReactNode } from "react";

export const TYPE = {
  /** 11.5 — the name of the thing. One per row. */
  subject: "text-[11.5px]",
  /** 10 — everything about it: shas, dates, authors, subjects. */
  meta: "text-[10px]",
  /** 9.5 uppercase — furniture. Headings, counts, key hints. */
  label: "text-[9.5px] uppercase tracking-wider",
} as const;

/** One rhythm for the whole view, so a section cannot invent its own gaps. */
export const SPACE = { row: 7, section: 14, gap: 8 } as const;

export const edge = (pct: number): string => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;
export const wash = (token: string, pct: number): string => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;

/**
 * A list row.
 *
 * `cols` is the grid WITHOUT its action track — the track is appended here, at
 * a fixed width, always. A section that wants no actions passes `actions={0}`
 * and gets no track at all; anything else gets a reserved column that the
 * subject can never grow into.
 */
export function Row({ cols, actions = 9, selected, tone, onClick, onContextMenu, children, title }: {
  cols: string;
  /** Width of the reserved action column, in rem. 0 removes it. */
  actions?: number;
  selected?: boolean;
  /** A row that is the current branch / checkout reads differently from one the
   *  cursor happens to be on, and both differ from an ordinary row. */
  tone?: "current" | "muted";
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: ReactNode;
  title?: string;
}) {
  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: actions ? `${cols} ${actions}rem` : cols,
    alignItems: "center",
    columnGap: SPACE.gap,
    padding: `${SPACE.row}px 10px`,
    borderRadius: 8,
    // The cursor wins over the current-branch tint: you need to see where the
    // keyboard is, and "this is HEAD" is already said by the glyph in column 1.
    background: selected ? wash("--primary", 13) : tone === "current" ? wash("--primary", 8) : "transparent",
    boxShadow: selected ? "inset 2px 0 0 var(--primary)" : undefined,
    opacity: tone === "muted" ? 0.72 : 1,
  };
  return (
    <div className="group git-row" style={style} onClick={onClick} onContextMenu={onContextMenu} title={title}>
      {children}
    </div>
  );
}

/** The name of the thing, and the only cell allowed to be 11.5px. */
export function Subject({ children, mono = true, tint, title }: {
  children: ReactNode; mono?: boolean; tint?: string; title?: string;
}) {
  return (
    <span className={`${TYPE.subject} truncate min-w-0`} title={title}
      style={{ color: tint ?? "var(--text)", fontFamily: mono ? "var(--font-mono, ui-monospace, monospace)" : undefined }}>
      {children}
    </span>
  );
}

/** Anything about the thing: sha, date, author, subject line. */
export function Meta({ children, mono, align = "left", title }: {
  children: ReactNode; mono?: boolean; align?: "left" | "right"; title?: string;
}) {
  return (
    <span className={`${TYPE.meta} truncate min-w-0`} title={title}
      style={{
        color: "var(--text3)", textAlign: align,
        fontFamily: mono ? "var(--font-mono, ui-monospace, monospace)" : undefined,
        fontVariantNumeric: mono ? "tabular-nums" : undefined,
      }}>
      {children}
    </span>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

const TONE: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: "var(--text3)", bg: wash("--text", 9) },
  good: { fg: "var(--success)", bg: wash("--success", 12) },
  warn: { fg: "var(--warning)", bg: wash("--warning", 13) },
  bad: { fg: "var(--error)", bg: wash("--error", 12) },
  accent: { fg: "var(--primary)", bg: wash("--primary", 13) },
};

/** One chip, four tones, no exceptions. Colour means what it means: good is "in
 *  sync / you have it", warn is "needs a decision", bad is "gone / destructive". */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  const t = TONE[tone];
  return (
    <span className="shrink-0 text-[9px] px-1.5 py-px rounded-md whitespace-nowrap"
      style={{ color: t.fg, background: t.bg }} title={title}>{children}</span>
  );
}

/** The one action a row is allowed to draw. Hidden until the row is hovered or
 *  is the cursor, because a list is read far more often than it is acted on. */
export function RowAction({ label, danger, disabled, onClick, title }: {
  label: string; danger?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent) => void; title?: string;
}) {
  return (
    <span className="justify-self-end opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button onClick={(e) => { e.stopPropagation(); onClick(e); }} disabled={disabled} title={title}
        className="text-[10px] px-2 py-0.5 rounded-md whitespace-nowrap font-medium"
        style={danger
          ? { color: "var(--error)", border: `1px solid ${wash("--error", 45)}`, background: "transparent" }
          : { color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)" }}>
        {label}
      </button>
    </span>
  );
}

/** A heading over a group of rows: prefix families, staged/unstaged, a remote's
 *  name. Foldable when `onToggle` is given. */
export function GroupHead({ label, count, note, folded, onToggle }: {
  label: string; count?: number; note?: ReactNode; folded?: boolean; onToggle?: () => void;
}) {
  const inner = (
    <>
      {onToggle && <span className="text-[9px]" style={{ color: "var(--text3)" }}>{folded ? "▸" : "▾"}</span>}
      <span className={TYPE.label} style={{ color: "var(--text3)" }}>{label}</span>
      {count != null && <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text3)" }}>{count}</span>}
      {note}
      <span className="flex-1 h-px" style={{ background: wash("--text", 9) }} />
    </>
  );
  const cls = "w-full flex items-center gap-2 text-left";
  const style: CSSProperties = { padding: `${SPACE.section}px 10px 5px` };
  return onToggle
    ? <button className={cls} style={style} onClick={onToggle}>{inner}</button>
    : <div className={cls} style={style}>{inner}</div>;
}

/** The bar over a list: search, counts, and whatever that section adds. One
 *  shape for all ten, so moving between them does not move the furniture. */
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap px-3 py-2"
      style={{ borderBottom: edge(9) }}>
      {children}
    </div>
  );
}

/** A quiet pill used for filters and counts in the toolbar. */
export function Pill({ on, tone = "neutral", onClick, children, title }: {
  on?: boolean; tone?: Tone; onClick?: () => void; children: ReactNode; title?: string;
}) {
  const t = TONE[tone];
  return (
    <button onClick={onClick} title={title}
      className="text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors"
      style={{
        color: on ? "var(--text)" : t.fg,
        background: on ? t.bg : "transparent",
        border: `1px solid ${on ? t.fg : wash("--border", 40)}`,
      }}>
      {children}
    </button>
  );
}

/** Empty state. Says what is missing in the section's own words rather than
 *  "no data", and never occupies more than the room it needs. */
export function Empty({ what, busy }: { what: string; busy?: boolean }) {
  return (
    <div className="grid place-items-center py-10 text-[11.5px]" style={{ color: "var(--text3)" }}>
      {busy ? `Reading ${what}…` : `No ${what} here`}
    </div>
  );
}
