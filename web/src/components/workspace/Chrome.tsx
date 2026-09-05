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

import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { HIT, ICON } from "../../lib/iconSize.ts";

/**
 * The one shape — and the class that gives it a body.
 *
 * Exported as a string as well, because a handful of call sites need to put it
 * on an element this module does not own (a label, an anchor).
 *
 * `agx-chip` is not decoration. `chipTone()` writes `background` as an INLINE
 * style, and an inline style beats every `hover:` class Tailwind can emit, so
 * for as long as the tone was the only thing painting a chip there was no way
 * to give one a hover state at all. Measured before this changed: zero `hover:`
 * rules and zero `onMouseEnter` across the whole understudy view, against 41 in
 * TasksPanel. The rule lives unlayered in index.css and carries `!important`
 * for exactly that reason; see the comment there.
 *
 * `min-h-[28px]` rather than `py-1`: 11px type at line-height 1.5 plus 4px of
 * padding measured 24.5px, which clears WCAG 2.2's 24px floor by half a pixel
 * and is why these were reported as easy to miss with the mouse. 28 is the
 * repo's own HIT constant rounded to the type.
 */
export const CHIP = "agx-chip text-[11px] px-2.5 min-h-[28px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap transition-colors";

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

/**
 * Whether a chip draws a body when it is doing nothing.
 *
 * A toggle is transparent until it is on, because the tint IS the state. Every
 * other chip is a button, and a button that is transparent grey text is
 * indistinguishable from the caption beside it — which is how this view ended
 * up with three decorative `<span className="chip">` carrying a 1px border
 * sitting next to a real `<Chip>` carrying none. The affordance was inverted:
 * what you could not click looked more clickable than what you could.
 *
 * So a chip with no `on`/`pressed` gets the surface, and one with a state does
 * not. `resting` forces it on for a toggle that still needs to look pressable
 * when it is off.
 */
function chipBody(hasState: boolean, resting: boolean): CSSProperties {
  if (hasState && !resting) return {};
  return {
    background: "color-mix(in srgb, var(--text) 5%, transparent)",
    border: "1px solid color-mix(in srgb, var(--text) 11%, transparent)",
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
  /**
   * Draw the surface even though this chip has an on/off state.
   *
   * For a set where every option is pressable and the row must read as a
   * control rather than as words — the posture rungs, the window filter.
   */
  resting?: boolean;
  /**
   * Emphasis WITHOUT `aria-pressed`.
   *
   * "Set this up for me" is a one-shot action, not a toggle, and passing `on`
   * to tint it announced it to a screen reader as a pressed toggle button.
   */
  primary?: boolean;
  /** The one that cannot be undone by pressing it again — Halt, remove. */
  danger?: boolean;
  /**
   * The accessible name, when the visible label is not it.
   *
   * A locked option needs "Worktree tie — locked, not enough scored decisions
   * yet" read out; the padlock beside it is `aria-hidden` and the reason lived
   * only in `title`, which most readers never announce.
   */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
};

export function Chip({
  on, onClick, title, children, pressed, disabled, resting, primary, danger, ariaLabel,
  className = "", style,
}: ChipProps) {
  const hasState = pressed !== undefined || on !== undefined;
  const tone: CSSProperties = primary
    ? {
      background: "color-mix(in srgb, var(--primary) 18%, transparent)",
      border: "1px solid color-mix(in srgb, var(--primary) 34%, transparent)",
      color: "var(--primary)",
    }
    : danger
      ? {
        background: "color-mix(in srgb, var(--error) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
        color: "var(--error)",
      }
      : { ...chipBody(hasState, !!resting), ...chipTone(!!on) };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      {...(hasState ? { "aria-pressed": !!(pressed ?? on) } : {})}
      className={`${CHIP}${danger ? " agx-chip-danger" : ""} ${className}`.trim()}
      // `cursor` and not only `opacity`: Tailwind's preflight sets
      // `button { cursor: pointer }` unconditionally, so a disabled chip kept
      // promising a click it could not honour, and two files in the understudy
      // view hand-rolled `cursor:not-allowed` to compensate.
      style={{ ...tone, ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : null), ...style }}
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
    // gap-1.5, not gap-1: four transparent labels 4px apart was the primary
    // navigation of a whole view, and 4px is inside the distance a pointer
    // slips between two 28px targets.
    <div className="flex items-center gap-1.5 shrink-0" role="group" aria-label={label}>
      {options.map((o) => (
        <Chip key={o.id} on={value === o.id} resting onClick={() => onChange(o.id)} title={o.title}>{o.label}</Chip>
      ))}
    </div>
  );
}

/**
 * A real tab bar, for a control that swaps the body of a view.
 *
 * `Segmented` is a `role="group"` of `aria-pressed` buttons, which is right for
 * a filter — "Board / Needs my review / Mine" narrows one list. It is wrong for
 * the understudy's Scorecard / Disagreements / Ledger / Teach, which replace
 * the panel entirely: measured, that was four separate tab stops with no arrow
 * keys, no `aria-selected`, and a swapped panel that was not a `tabpanel`.
 *
 * The pattern is not invented here — ViewRail already ships roving tabIndex
 * plus arrow handling for the same job, and this is that, at the size of a
 * header control.
 *
 * The selected tab is drawn with an underline rather than a fill, so the whole
 * strip reads as one control with no gaps to fall between, and every tab is
 * 32px tall: this is navigation, and navigation gets the largest target on the
 * bar rather than the same one as everything else.
 */
export function Tabs<T extends string>({ value, options, onChange, label, panelId }: {
  value: T;
  options: readonly { id: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  /** The id of the element these tabs swap, for `aria-controls`. */
  panelId?: string;
}) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : e.key === "End" ? options.length - 1 - i : 0;
    if (!d) return;
    e.preventDefault();
    const next = options[(i + d + options.length) % options.length];
    if (!next) return;
    onChange(next.id);
    const el = e.currentTarget.parentElement?.children[(i + d + options.length) % options.length];
    if (el instanceof HTMLElement) el.focus();
  };
  return (
    <div className="flex items-stretch shrink-0" role="tablist" aria-label={label}>
      {options.map((o, i) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            // Roving: the strip is one tab stop, and the arrows move inside it.
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => move(e, i)}
            className="agx-tab text-[12px] px-3 min-h-[32px] inline-flex items-center whitespace-nowrap transition-colors"
            style={on
              ? { color: "var(--primary)", fontWeight: 700, boxShadow: "inset 0 -2px 0 0 var(--primary)" }
              : { color: "var(--text3)" }}
          >
            {o.label}
          </button>
        );
      })}
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
