/*
 * The git view's visual system.
 *
 * The CONTROLS in it are not its own: `CHIP` comes from `workspace/Chrome.tsx`,
 * which is where the app's one button shape lives. This file used to declare two
 * more of them — a 10.5px rounded-lg and a 10px rounded-full — so the git view's
 * buttons were a different size from the identical buttons one view away. What
 * stays local is what is genuinely this view's: the row with its status rail,
 * the group heading, the empty state.
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
import { ICON } from "../../lib/iconSize.ts";
import { CHIP } from "../workspace/Chrome.tsx";

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
export function Row({ rail, title, chips, facts, action, selected, current, onClick, onContextMenu, title2, gutter, variant = "card" }: {
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
  /**
   * Drawn OUTSIDE the card, in a column of its own that runs the full height of
   * the row — the commit graph.
   *
   * Outside because the graph is one continuous drawing down the page, and a
   * card is a boundary: inside it, every lane line was cut by a border and 4px
   * of gap, five hundred times. Reported as "¿puede ser fuera de la card?
   * tenemos ancho suficiente" — both halves of which were right.
   */
  gutter?: ReactNode;
  /**
   * `card` for a list of THINGS — a branch, a worktree, a stash. Each is a
   * discrete object with its own state, and a bounded card is what says so.
   *
   * `line` for a list of MOMENTS, which is what the log is. A commit's meaning
   * comes from what sits above and below it, so the container that separates it
   * from its neighbours is working against the content: the border, the radius,
   * the lift and the 4px gap all say "these are apart" about the one list where
   * they are not. It also cost 40% of the vertical space — seventeen commits on
   * a 1000px screen where a line list shows thirty.
   */
  variant?: "card" | "line";
}) {
  const line = variant === "line";
  const style: CSSProperties = line ? {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: 12,
    // No border, no gap, no lift: the row is separated from its neighbours by
    // the fact that it is a different row, which is all a sequence needs.
    padding: "4px 12px 4px 10px",
    borderRadius: 6,
    background: selected ? wash("--primary", 16) : "transparent",
    border: "1px solid transparent",
    cursor: "default",
    transition: "background .12s ease",
  } : {
    position: "relative",
    display: "grid",
    /* The action lane only exists when there IS one. A fixed 10rem meant every
       row on a list with no primary action — most of the log, every remote —
       reserved 160px of empty card on the right, so the content sat hugging the
       left third of a very wide box. `auto` cannot jitter on hover either: the
       label does not change, only its opacity. */
    gridTemplateColumns: action ? "minmax(0, 1fr) auto" : "minmax(0, 1fr)",
    alignItems: "center",
    gap: 12,
    // Compact, but not a table again: 8px of vertical padding and 4px between
    // cards fits several more rows on a laptop than the first pass did, and the
    // two-line hierarchy is what keeps it readable at that density. Both land
    // on the 2px grid the suite enforces — 9 and 5 were caught by it.
    /*
     * ONE signal for the selection, not four.
     *
     * A selected card used to carry a heavy violet fill, a violet border, an
     * inset ring, a drop shadow AND a 2px sideways nudge — five ways of saying
     * the same thing, which is why it read as a lit-up slab rather than as a
     * row you are on. The fill is halved and the rail (which is already the
     * card's own colour) does the rest; the border stays the quiet hairline it
     * is on every other card, so a list of thirty does not look like thirty
     * outlines.
     *
     * Tighter, too: the padding was 8/12/8/16 and two short lines of text sat
     * in 46px of card. 6px of vertical padding puts a third more rows on the
     * same screen without touching the type. The 4px between cards stays — it
     * is on the grid, and 3px is not.
     */
    padding: "6px 12px 6px 14px",
    marginBottom: 4,
    borderRadius: 8,
    background: selected ? wash("--primary", 9) : current ? wash("--primary", 5) : wash("--bg3", 30),
    border: `1px solid ${selected ? wash("--primary", 30) : wash("--text", 7)}`,
    cursor: "default",
    transition: "background .14s ease, border-color .14s ease",
  };
  /* Inside a gutter the wrapper above owns the ground, so the body must not
     paint a second one — two tints of the same colour do not cancel out, they
     stack, and the row came out a shade brighter than the highlight it was
     supposed to match. */
  if (gutter && line) { style.background = "transparent"; }

  const body = (
    // `git-card` is what the stylesheet hangs hover and reduced-motion off:
    // hovering lifts the border and the ground a step, which is the feedback a
    // list of identical cards needs to feel like it is under your hand rather
    // than printed on the page.
    <div className={line ? `${gutter ? "" : "git-line "}group min-w-0` : "git-card group"} style={style}
      onClick={gutter ? undefined : onClick} onContextMenu={gutter ? undefined : onContextMenu} title={gutter ? undefined : title2}>
      {/* The rail. Sits inside the border radius rather than beside it, so a
          list of them reads as one column of colour down the left. */}
      {!line && (
        <span aria-hidden style={{
          position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
          borderTopLeftRadius: 8, borderBottomLeftRadius: 8,
          background: rail ? TONE[rail] : "transparent",
          // Full height and flush with the corner: inset by 8px it read as a
          // separate mark inside the card instead of as the card's own edge.
          opacity: rail === "neutral" ? 0.45 : 0.95,
        }} />
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[12.5px] font-medium"
            style={{ color: "var(--text)", fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
            {title}
          </span>
          {chips}
        </div>
        {/* On a line, the facts sit BESIDE the subject rather than under it:
            two lines per commit is what made seventeen of them fill a screen,
            and "21 hours ago · abc6072 · Manuel" is a caption, not a paragraph. */}
        {!!facts?.length && !line && (
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[10px]" style={{ color: "var(--text4)" }}>
            {facts.filter(Boolean).map((f, i) => (
              <span key={i} className="flex items-center gap-1.5 min-w-0">
                {i > 0 && <span style={{ opacity: 0.45 }}>·</span>}
                <span className="truncate">{f}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="justify-self-end flex items-center gap-2 shrink-0">
        {line && !!facts?.length && (
          <span className="flex items-center gap-1.5 text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>
            {facts.filter(Boolean).map((f, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span style={{ opacity: 0.45 }}>·</span>}
                {f}
              </span>
            ))}
          </span>
        )}
        {action}
      </div>
    </div>
  );

  if (!gutter) return body;
  /*
   * The gutter is a flex sibling with `items-stretch`, so it is exactly as tall
   * as the row whatever the row decides to be — which is what keeps five hundred
   * little drawings joined into one.
   *
   * The selection moves OUT here with it. A tint that stopped where the graph
   * began drew a line down the middle of the row it was meant to pick out, and
   * left the one dot the reader is looking for outside the highlight — on the
   * very screen where the complaint was that finding it is hard.
   */
  return (
    <div className={`${line ? "git-line" : ""} flex items-stretch min-w-0`}
      style={{
        borderRadius: 6,
        background: selected ? wash("--primary", 16) : "transparent",
        transition: "background .12s ease",
      }}
      onClick={onClick} onContextMenu={onContextMenu} title={title2}>
      <span className="shrink-0 relative self-stretch" aria-hidden>{gutter}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

/** A chip. Small, round, and the only place a status word is allowed to be
 *  coloured — everything else on the card is text or grey. */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    /*
     * `.chip`'s own geometry: 6px radius, 1px/6px padding, no bold.
     *
     * A status word is a LABEL — not a control and not a badge. It was a
     * stadium at 2px/8px in semibold, which made `⎇ master` and `you are here`
     * as loud as the branch name they were describing, and put a third radius
     * on a screen that already had two.
     */
    <span className="shrink-0 text-[9.5px] px-1.5 py-px rounded-md whitespace-nowrap"
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
        className={`${CHIP} font-medium`}
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
      {/* Drawn and rotated, not two typed glyphs. A 9px ▸ is an affordance
          nobody finds — the same finding that took the ▾ out of the
          notification rows — and one control that MOVES reads as the same
          thing in two states, where two characters read as two things. */}
      {onToggle && (
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
          style={{ color: "var(--text3)", transform: folded ? "rotate(-90deg)" : "none", transition: "transform .12s" }}>
          <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
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
      className={`${CHIP} font-medium`}
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
