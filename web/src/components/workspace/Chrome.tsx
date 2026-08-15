/*
 * The controls a view puts in its own top bar, said once.
 *
 * `ViewHeader` already fixed the bar's HEIGHT, and for exactly this reason: five
 * headers written at five different times had drifted, and switching views made
 * the frame twitch. What it never fixed is what goes IN the bar, so the drift
 * moved one level down — a chip at 11.5px here, one at 10px there, a segmented
 * control with its own border and inner padding in a third. Reported, in the
 * author's words: "no hay homogeneidad… parece que estoy en otra app".
 *
 * Nothing here is invented. The numbers are the ones the panels already agree
 * on, counted across the six view files:
 *
 *     rounded-lg   94        text-[11px]    51
 *     px-2         63        text-[10.5px]  38
 *     py-1         54        text-[10px]    22
 *
 * So the chip is `text-[11px] px-2 py-1 rounded-lg`, and everything below is
 * that one shape wearing different states. A view that needs something this
 * cannot express should add it HERE, where the next view will find it.
 */

import type { CSSProperties, ReactNode } from "react";
import { HIT, ICON } from "../../lib/iconSize.ts";

/** The one shape. Exported as a string as well, because a handful of call sites
 *  need to put it on an element this module does not own (a label, an anchor). */
export const CHIP = "text-[11px] px-2 py-1 rounded-lg whitespace-nowrap transition-colors";

/**
 * The fill and hairline a control carries when it is not a toggle.
 *
 * A toolbar toggle is transparent until it is on — the tint IS the state. A
 * control that is always available (the repo picker, the link to GitHub) has no
 * on-state to show, and transparent turns it into grey text: "no parece otra
 * cosa" was the report, about a header where two of them had become captions
 * with arrows after them.
 */
export const CHIP_SURFACE = {
  background: "color-mix(in srgb, var(--text) 5%, transparent)",
  border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
  color: "var(--text)",
} as const;

/** The hover half of the same, which cannot be an inline style. */
export const CHIP_SURFACE_CLS = "hover:brightness-125";

/**
 * What a pressed control looks like.
 *
 * One tint, one weight. The variants that existed — a filled violet block, a
 * 22%-tinted background, a bordered outline, a bold label — were four ways of
 * saying "this one is on", and a row containing two of them reads as two
 * different kinds of control.
 */
export function chipTone(on: boolean): CSSProperties {
  return {
    background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
    color: on ? "var(--text)" : "var(--text3)",
  };
}

type ChipProps = {
  on?: boolean;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  /** For a control that is one of a set — a tab, a mode. Sets `aria-pressed`. */
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function Chip({ on, onClick, title, children, pressed, disabled, className = "", style }: ChipProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      {...(pressed !== undefined || on !== undefined ? { "aria-pressed": !!(pressed ?? on) } : {})}
      className={`${CHIP} ${className}`.trim()}
      style={{ ...chipTone(!!on), ...(disabled ? { opacity: 0.5 } : null), ...style }}
    >
      {children}
    </button>
  );
}

/**
 * A set of chips where exactly one is on — "Uncommitted / Last commit",
 * "Board / Needs my review / Mine".
 *
 * A plain row, deliberately: the version this replaces wrapped its two buttons
 * in a bordered, padded pill, which made the same control visibly taller than
 * the chips doing the same job in the panel next door. The tint says which one
 * is on; a box around the group says nothing the tint has not already said.
 */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: readonly { id: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  /** For screen readers — the question the set answers. */
  label: string;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0" role="group" aria-label={label}>
      {options.map((o) => (
        <Chip key={o.id} on={value === o.id} onClick={() => onChange(o.id)} title={o.title}>{o.label}</Chip>
      ))}
    </div>
  );
}

/**
 * What a view is POINTED AT, in the top-left corner: a repository, a checkout, a
 * branch, a remote.
 *
 * Five views had one and no two were the same object. Measured, left to right in
 * each header:
 *
 *     Terminal   text-[11px] pl-2.5 pr-1.5 py-1 rounded-lg  + an 8.5px badge
 *     Pull reqs  text-[10px] px-1.5 py-0.5  rounded-md
 *     Git        text-[11px] px-3   py-1    rounded-full
 *     Tasks      text-[11px] px-2.5 py-1    rounded-lg
 *     Diff       the segmented chips
 *
 * Four shapes, three heights and three radii for one job — reported as "son
 * todos diferentes", which they were. This is that control, once. It is the chip
 * shape with two optional parts, because the differences between those five were
 * never about the control and always about what it happened to carry:
 *
 *   · a KIND badge (`REPO`, `WT`) for the header that has to tell a checkout
 *     from the repository it was cut from;
 *   · a trailing mark — a caret when pressing it opens a picker, an arrow when
 *     it leaves the app for a browser. Those are different promises and the
 *     control should not make them look alike.
 */
export function ScopeChip({ label, kind, trailing = "none", on, onClick, title, href, className = "" }: {
  /** The thing itself: `orbit`, `orbit · main`, `acme/orbit`. */
  label: ReactNode;
  /** Two to four letters, when the view needs to say what KIND of thing this is. */
  kind?: string;
  /** `menu` draws a caret (this opens a picker), `external` an arrow (this
   *  leaves the app), `none` neither. */
  trailing?: "none" | "menu" | "external";
  on?: boolean;
  onClick?: () => void;
  title?: string;
  /** When it is a link rather than a button — the repository on GitHub. */
  href?: string;
  className?: string;
}) {
  const inner = (
    <>
      {kind && (
        <span className="shrink-0 text-[9.5px] leading-none px-1 py-0.5 rounded"
          style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>{kind}</span>
      )}
      <span className="truncate min-w-0">{label}</span>
      {trailing === "menu" && (
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0" style={{ opacity: 0.7 }}>
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {trailing === "external" && <span aria-hidden className="shrink-0" style={{ opacity: 0.7 }}>↗</span>}
    </>
  );
  const cls = `${CHIP} ${CHIP_SURFACE_CLS} inline-flex items-center gap-1.5 min-w-0 ${className}`.trim();
  /*
   * A SURFACE, not bare text.
   *
   * The first version of this took `chipTone(false)`, which is transparent —
   * correct for a toolbar toggle, wrong here: the pull-request header turned
   * into two grey words with arrows after them, and grey text with punctuation
   * reads as a caption that happens to have an arrow, not as something you can
   * press. Reported the moment it shipped: "usa ese chip que usas en los demás,
   * así está en armonía y no parece otra cosa."
   *
   * The fill and the hairline are the Git panel's, which is the header that had
   * this right — they are what say "this is a control".
   */
  const style = on ? chipTone(true) : CHIP_SURFACE;
  return href
    ? <a href={href} target="_blank" rel="noreferrer" title={title} className={cls} style={style}>{inner}</a>
    : <button onClick={onClick} title={title} className={cls} style={style}>{inner}</button>;
}

/**
 * An icon-only control in a header.
 *
 * `HIT` is 26 because a glyph with `px-2` around it is a thin target — the
 * reason `CloseButton` exists and is the size it is. A view that hand-rolls 24
 * is both slightly wrong and slightly different, which is the worse half.
 */
export function IconChip({ onClick, title, children, on, expanded, hasPopup }: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  on?: boolean;
  expanded?: boolean;
  hasPopup?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      {...(expanded !== undefined ? { "aria-expanded": expanded } : {})}
      {...(hasPopup ? { "aria-haspopup": "menu" as const } : {})}
      className="inline-flex items-center justify-center rounded-lg transition-colors shrink-0"
      style={{ width: HIT, height: HIT, ...chipTone(!!on) }}
    >
      {children}
    </button>
  );
}

/** The size an icon inside `IconChip` is drawn at. Named so a call site does not
 *  have to know that the default rung happens to be the right one. */
export const CHIP_ICON = ICON.md;

/**
 * The filter box a list view puts above its rows.
 *
 * Three of these existed with three heights (`py-1`, `py-1.5`, `py-2`) and three
 * sizes (11, 11.5, 12.5px), which is why moving between two list views felt like
 * moving between two apps — the field is the widest thing in the bar and the
 * first thing the eye lands on.
 */
export function FilterField({ value, onChange, placeholder, label, className = "" }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      className={`px-3 py-1.5 rounded-lg text-[11.5px] outline-none ${className}`.trim()}
      style={{
        background: "color-mix(in srgb, var(--bg3) 40%, transparent)",
        border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)",
        color: "var(--text)",
      }}
    />
  );
}

/**
 * The heading over a group of rows.
 *
 * Its own step, not the row's: the space above a heading is never the same as
 * the space between the items under it, or the heading joins the group above
 * instead of the one it names. This is the one rule `tailwind.config.js` already
 * writes down and the one most often broken.
 */
export const GROUP_HEADING = "px-1.5 pt-3 pb-1 text-[10px] uppercase tracking-wider";
