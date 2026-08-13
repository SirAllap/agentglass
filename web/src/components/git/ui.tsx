/*
 * The git view's visual system.
 *
 * The first pass at this unified the plumbing — one grid, one set of type
 * sizes, one chip — and the verdict on it was that it still looked like the
 * same list, which was fair: a tidy table of 10px text is still a table of 10px
 * text. The row was the problem, not its tracks.
 *
 * So the row is not a table line any more. It is an object with a hierarchy:
 *
 *     ┃  feat/consolidate-work            gone  ↑166        [ Delete ]
 *     ┃  5 min ago · c76e387 · worktree -consolidate
 *
 *   * a 3px STATUS RAIL down the left, coloured by what the row's state is —
 *     the thing you scan a list of thirty branches for, findable without
 *     reading a word;
 *   * the NAME at 13px, the size the eye lands on first, and the only string
 *     on the row at that size;
 *   * everything else demoted to a 10px SECOND LINE of dot-separated facts,
 *     where dates and shas and paths stop competing with the name;
 *   * air: 12px of vertical padding and 6px between rows, against the 26px
 *     table rows this replaces;
 *   * one action, which appears on hover in a lane reserved for it, so it can
 *     never sit on top of anything.
 *
 * Nothing here invents a colour: every value is a token the app already
 * defines. What changed is how much of each one there is.
 */
import type { CSSProperties, ReactNode } from "react";

export const edge = (pct: number): string => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;
export const wash = (token: string, pct: number): string => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

const TONE: Record<Tone, string> = {
  neutral: "var(--text3)",
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--error)",
  accent: "var(--primary)",
};

/**
 * One row, as a card.
 *
 * `rail` is the status colour — the whole reason a thirty-branch list can be
 * read at a glance. `title` is the name. `facts` is everything else, joined
 * with dots on its own line, and deliberately not aligned into columns: the
 * facts about a branch are not a table, they are a sentence.
 */
export function Row({ rail, title, chips, facts, action, selected, current, onClick, onContextMenu, title2 }: {
  rail?: Tone;
  title: ReactNode;
  chips?: ReactNode;
  facts?: ReactNode[];
  action?: ReactNode;
  selected?: boolean;
  /** The branch you are on / the checkout you are in. */
  current?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title2?: string;
}) {
  const style: CSSProperties = {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 10rem",
    alignItems: "center",
    gap: 12,
    // Compact, but not a table again: 8px of vertical padding and 4px between
    // cards fits several more rows on a laptop than the first pass did, and the
    // two-line hierarchy is what keeps it readable at that density. Both land
    // on the 2px grid the suite enforces — 9 and 5 were caught by it.
    padding: "8px 12px 8px 16px",
    marginBottom: 4,
    borderRadius: 10,
    background: selected ? wash("--primary", 14) : current ? wash("--primary", 6) : wash("--bg3", 34),
    border: `1px solid ${selected ? wash("--primary", 55) : wash("--text", 8)}`,
    // The selected card lifts. Depth is the cheapest way to say "this one" in
    // a list where every card is the same size, and it costs no colour — the
    // colours are already carrying state on the rail and in the chips.
    boxShadow: selected ? `0 6px 18px -10px rgba(0,0,0,.75), inset 0 0 0 1px ${wash("--primary", 18)}` : "none",
    cursor: "default",
    transition: "background .14s ease, border-color .14s ease, box-shadow .14s ease, transform .14s ease",
    transform: selected ? "translateX(2px)" : "none",
  };
  return (
    <div className="git-card group" style={style} onClick={onClick} onContextMenu={onContextMenu} title={title2}>
      {/* The rail. Sits inside the border radius rather than beside it, so a
          list of them reads as one column of colour down the left. */}
      <span aria-hidden style={{
        position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 3,
        background: rail ? TONE[rail] : "transparent",
        opacity: rail === "neutral" ? 0.5 : 0.9,
      }} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[13px] font-medium"
            style={{ color: "var(--text)", fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
            {title}
          </span>
          {chips}
        </div>
        {!!facts?.length && (
          <div className="flex items-center gap-1.5 mt-1 min-w-0 text-[10px]" style={{ color: "var(--text3)" }}>
            {facts.filter(Boolean).map((f, i) => (
              <span key={i} className="flex items-center gap-1.5 min-w-0">
                {i > 0 && <span style={{ opacity: 0.45 }}>·</span>}
                <span className="truncate">{f}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="justify-self-end">{action}</div>
    </div>
  );
}

/** A chip. Small, round, and the only place a status word is allowed to be
 *  coloured — everything else on the card is text or grey. */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className="shrink-0 text-[9.5px] px-2 py-0.5 rounded-full whitespace-nowrap font-medium"
      style={{ color: TONE[tone], background: wash(tone === "neutral" ? "--text" : `--${tone === "good" ? "success" : tone === "warn" ? "warning" : tone === "bad" ? "error" : "primary"}`, tone === "neutral" ? 10 : 14) }}
      title={title}>
      {children}
    </span>
  );
}

/** The one action a card draws. Hidden until hover or cursor, in its own lane. */
export function RowAction({ label, danger, disabled, onClick, title }: {
  label: string; danger?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent) => void; title?: string;
}) {
  return (
    <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button onClick={(e) => { e.stopPropagation(); onClick(e); }} disabled={disabled} title={title}
        className="text-[10.5px] px-3 py-1 rounded-lg whitespace-nowrap font-medium"
        style={danger
          ? { color: "var(--error)", border: `1px solid ${wash("--error", 45)}`, background: wash("--error", 8) }
          : { color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)" }}>
        {label}
      </button>
    </span>
  );
}

/** A heading over a group of cards. */
export function GroupHead({ label, count, note, folded, onToggle }: {
  label: string; count?: number; note?: ReactNode; folded?: boolean; onToggle?: () => void;
}) {
  const inner = (
    <>
      {onToggle && <span className="text-[9px] w-2" style={{ color: "var(--text3)" }}>{folded ? "▸" : "▾"}</span>}
      <span className="text-[10px] uppercase tracking-[0.11em] font-medium" style={{ color: "var(--text2)" }}>{label}</span>
      {count != null && (
        <span className="text-[9.5px] tabular-nums px-1.5 py-px rounded-full"
          style={{ color: "var(--text3)", background: wash("--text", 9) }}>{count}</span>
      )}
      {note}
      <span className="flex-1 h-px" style={{ background: wash("--text", 8) }} />
    </>
  );
  const cls = "w-full flex items-center gap-2 text-left";
  const style: CSSProperties = { padding: "16px 4px 8px" };
  return onToggle
    ? <button className={cls} style={style} onClick={onToggle}>{inner}</button>
    : <div className={cls} style={style}>{inner}</div>;
}

/** The bar over a list. */
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap px-3 py-2.5" style={{ borderBottom: edge(8) }}>
      {children}
    </div>
  );
}

/** A quiet pill for filters and counts. */
export function Pill({ on, tone = "neutral", onClick, children, title }: {
  on?: boolean; tone?: Tone; onClick?: () => void; children: ReactNode; title?: string;
}) {
  return (
    <button onClick={onClick} title={title}
      className="text-[10px] px-3 py-1 rounded-full whitespace-nowrap transition-colors font-medium"
      style={{
        color: on ? "var(--text)" : TONE[tone],
        background: on ? wash("--primary", 14) : "transparent",
        border: `1px solid ${on ? wash("--primary", 40) : wash("--text", 12)}`,
      }}>
      {children}
    </button>
  );
}

/** Empty state, with room around it. */
export function Empty({ what, busy }: { what: string; busy?: boolean }) {
  return (
    <div className="grid place-items-center gap-1 py-16">
      <span className="text-[13px]" style={{ color: "var(--text2)" }}>
        {busy ? `Reading ${what}…` : `Nothing here`}
      </span>
      {!busy && <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>no {what} in this repository</span>}
    </div>
  );
}
