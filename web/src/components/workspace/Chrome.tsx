/*
 * The controls a view puts in its own top bar, said once.
 *
 * `ViewHeader` already fixed the bar's HEIGHT, and for exactly this reason: five
 * headers written at five different times had drifted, and switching views made
 * the frame twitch. What it never fixed is what goes IN the bar, so the drift
 * moved one level down — a chip at 11.5px here, one at 10px there, a segmented
 * control with its own border and inner padding in a third. The effect is
 * that switching views reads as switching applications.
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

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { externalUrl } from "../../lib/externalUrl.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { DoneIcon, RefreshIcon } from "../../lib/glyphIcons.tsx";

/**
 * The three heights a control comes in, and the one border every one of them
 * shares.
 *
 * Named so the next control reaches for these instead of typing `28` or
 * `edge(14)` again: `CHIP` already is `min-h-[28px]` (588 uses), and `edge(14)`
 * is the most-used of the 17 percentages `edge()` is called with (54, against
 * 52 for the next one down).
 *
 * `EDGE` is `edge(14)`'s own string, not a call to it: `git/ui.tsx` imports
 * `CHIP` from this file already, and calling `edge()` at this module's top
 * level would make the two files' load order decide which one sees the other
 * half-initialized. The value cannot drift — `edge()` is one string template,
 * checked by the slice-1 guard test.
 *
 * `strip` (24) is the Terminal strip's: a 32px bar with a 4px margin above and
 * below each control, the mockup's own measurement. `compact` is a row's and
 * `regular` a view header's; neither fits in 32 without touching the edge.
 */
export const CTRL_H = { compact: 22, strip: 24, hit: HIT, regular: 28, large: 32 } as const;
export const EDGE = "1px solid color-mix(in srgb, var(--text) 14%, transparent)";

/**
 * The divider: a rule BETWEEN things (a row separator, a header's bottom
 * edge, a column's side), as opposed to `EDGE`, which outlines a thing (a
 * control, a card, a dialog).
 *
 * `--surface-line` already existed in index.css for exactly this and was
 * spelled out as a raw `1px solid ...` string at each site that used it,
 * next to 17 different `edge(n)` weights doing the same job. Two weights
 * now: the outline and the rule. An emphasis border (`edge(28)` and up, or a
 * tinted one) says something on purpose and stays what it is.
 */
export const LINE = "1px solid var(--surface-line)";

/**
 * A one-pixel edge tinted by a hue the caller owns: a primary edge on what is
 * chosen, a warning edge on what needs a look. The neutral outline is `EDGE` and
 * the rule is `LINE`; this is for the edge that means something, and it is the
 * one place the string is spelled so the ratchet counts the exceptions, not the
 * spelling.
 */
export const tintEdge = (hue: string, pct: number): string => `1px solid color-mix(in srgb, ${hue} ${pct}%, transparent)`;

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
/**
 * THE radius of a button, chip, pill, icon control and text input: Tailwind's
 * `rounded-lg`, 8px. `CHIP`, `BAR_CTRL`, `INPUT`, `Button` and `IconChip` each
 * spell it in their own class list (a test reads those lists against this
 * value), and every new kit part takes it from here. A card, a panel and a
 * dialog are one step up, `rounded-xl`.
 */
export const CTRL_RADIUS = "rounded-lg";
export const CHIP = "agx-chip text-[11px] px-2.5 min-h-[28px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap transition-colors";
/**
 * `CHIP` at `CTRL_H.compact` (22): a filter row inside a dialog, where forty
 * category chips at 28px would take the list's room. The same rung `Button`'s
 * `compact` size uses, so a compact chip and a compact button share a row.
 */
export const CHIP_COMPACT = "agx-chip text-[10.5px] px-2 min-h-[22px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap transition-colors";

/**
 * The fill and hairline a control carries when it is not a toggle.
 *
 * A toolbar toggle is transparent until it is on — the tint IS the state. A
 * control that is always available (the repo picker, the link to GitHub) has no
 * on-state to show, and transparent turns it into grey text that no longer
 * reads as a control: in one header two of them had become captions with
 * arrows after them.
 */
export const CHIP_SURFACE = {
  background: "color-mix(in srgb, var(--text) 5%, transparent)",
  border: EDGE,
  color: "var(--text)",
} as const;

/**
 * The pull-request bar's one control: every box and button in it, whatever it
 * holds, is this shape.
 *
 * The bar mixed five heights (22, 24, 27.3, 28, 32), four type sizes (10.5, 11,
 * 11.5, 12) and three paddings, because each control was written where it lives
 * (the views in PrPanel, the sets in FilterPresets, the box in PrFilterBar) and
 * none of them knew about the others. So the height is `CTRL_H.regular`, the
 * rung the other headers' chips already sit on (`CHIP` is the same 28), and
 * it is set as `h-[28px]`, not `min-h`: a minimum lets a control that wraps its
 * label come out taller than its neighbours. The type, the padding, the radius,
 * the gap and the border are `CHIP`'s own, so a text control here is the chip
 * every other header uses. An icon-only control is `BAR_SQUARE`: the same
 * height and width, no padding.
 *
 * A new control in the bar takes this, and a source test fails on one that
 * sets its own height or padding there.
 */
export const BAR_H = CTRL_H.regular;
export const BAR_CTRL = "agx-chip text-[11px] px-2.5 h-[28px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap shrink-0 leading-none transition-colors";
/** The icon-only member: `BAR_H` square, nothing inside it to pad. */
export const BAR_SQUARE = "agx-chip text-[11px] w-[28px] h-[28px] inline-flex items-center justify-center rounded-lg shrink-0 leading-none transition-colors";
/** The glyph inside any of them. 14 beside 11px type, the ladder's `sm`. */
export const BAR_ICON = ICON.sm;
/** The search box: the one control that grows in width, and the same height. */
export const BAR_INPUT =
  "text-[11px] px-2.5 h-[28px] rounded-lg bg-[var(--surface-inset)] text-[var(--text)] " +
  "placeholder:text-[var(--text3)] outline-none transition-colors";

/** The hover half of the same, which cannot be an inline style. */
export const CHIP_SURFACE_CLS = "hover:brightness-125";

/**
 * The one text input, `control, large` in the canon table: `rounded-lg`,
 * `CTRL_H.large` (32, the same row height as a dialog's primary button), a
 * well fill instead of a card fill, and `EDGE`. Every `<input>` outside the
 * three structurally-excused ones (§ guard test) reaches for this instead of
 * typing its own `px-2 py-1 rounded-md border` again — that was the search
 * box being a third height next to a 28px filter chip and a 22px row action
 * in the same view.
 */
export const INPUT =
  "text-[12px] px-2.5 h-[32px] rounded-lg bg-[var(--surface-inset)] text-[var(--text)] " +
  "placeholder:text-[var(--text3)] outline-none transition-colors";
export const INPUT_STYLE: CSSProperties = { border: EDGE };

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
    border: tintEdge("var(--text)", 11),
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
  /**
   * One tab of a strip that swaps a view: `role="tab"` and `aria-selected` in place of
   * `aria-pressed`, which a tab does not have.
   */
  tab?: boolean;
  /** 22px instead of 28: a filter row in a dialog (`CHIP_COMPACT`). */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function Chip({
  on, onClick, title, children, pressed, disabled, resting, primary, danger, ariaLabel, tab, compact,
  className = "", style,
}: ChipProps) {
  const hasState = pressed !== undefined || on !== undefined;
  const tone: CSSProperties = primary
    ? {
      background: "color-mix(in srgb, var(--primary) 18%, transparent)",
      border: tintEdge("var(--primary)", 34),
      color: "var(--primary-ink)",
    }
    : danger
      ? {
        background: "color-mix(in srgb, var(--error) 10%, transparent)",
        border: tintEdge("var(--error)", 30),
        color: "var(--error-ink)",
      }
      : { ...chipBody(hasState, !!resting), ...chipTone(!!on) };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      {...(tab ? { role: "tab", "aria-selected": !!on } : hasState ? { "aria-pressed": !!(pressed ?? on) } : {})}
      className={`${compact ? CHIP_COMPACT : CHIP}${danger ? " agx-chip-danger" : ""} ${className}`.trim()}
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
 * A status word: a label, not a control. Small, round, coloured by `tint` (any
 * CSS colour) and nothing else on its row is allowed that colour.
 *
 * Three copies had grown apart: the git card's `Chip` (flat wash, `py-px`),
 * Docker's `RowChip` and the volumes `Chip` (the same wash plus a 40% edge,
 * `py-0.5`). They are this now; `outlined` is the second look and the padding
 * follows it so neither moves a pixel. Not a `Chip`: it has no height to share
 * with a button, because a label that grew to 28px would be a button.
 *
 * `clip`: the text is arbitrary (a commit's refs, a branch), not a status
 * word, so the badge gives up its `shrink-0` and ellipsizes. A badge that will
 * not shrink in a flex row does not get clipped by it: it overflows and paints
 * over its neighbour. `onClick` makes it clickable without making it a button;
 * the click does not reach the row under it.
 */
export function Badge({ tint, fill = tint, wash = 10, outlined, tight, clip, onClick, title, children }: {
  tint: string; /** The wash's colour when it is not the text's (a grey label on a `--text` wash). */ fill?: string; wash?: number; outlined?: boolean; /** `leading-none`: a line box of the glyphs alone, for a row that pins its own height. */ tight?: boolean; clip?: boolean; onClick?: () => void; title?: string; children: ReactNode;
}) {
  return (
    <span
      title={title}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className={`text-[9.5px]${tight ? " leading-none" : ""} ${outlined ? "py-0.5" : "py-px"} px-1.5 rounded-md whitespace-nowrap ${clip ? "min-w-0 truncate" : "shrink-0"}${onClick ? " cursor-pointer" : ""}`}
      style={{
        color: tint,
        background: `color-mix(in srgb, ${fill} ${wash}%, transparent)`,
        ...(outlined ? { border: tintEdge(tint, 40) } : null),
      }}>
      {children}
    </span>
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
export function Segmented<T extends string>({ value, options, onChange, label, track, disabled, compact }: {
  value: T | undefined;
  options: readonly { id: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  /** For screen readers — the question the set answers. */
  label: string;
  /**
   * The second look: an inset track with the chosen option raised on the page's ground (`.agx-seg`
   * in index.css), for a short exclusive choice in a settings row's control column. The bars keep
   * the plain row of chips above. One component, two skins; the track is 28px outer (24 + 2 + 2).
   */
  track?: boolean;
  disabled?: boolean;
  /** Its chips at `CHIP_COMPACT` (22). Ignored with `track`. */
  compact?: boolean;
}) {
  if (track) {
    return (
      <span className="agx-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.id} type="button" title={o.title} onClick={() => onChange(o.id)} disabled={disabled}
            aria-pressed={value === o.id} className="agx-seg-b disabled:cursor-not-allowed">
            {o.label}
          </button>
        ))}
      </span>
    );
  }
  return (
    // gap-1.5, not gap-1: four transparent labels 4px apart was the primary
    // navigation of a whole view, and 4px is inside the distance a pointer
    // slips between two 28px targets.
    <div className="flex items-center gap-1.5 shrink-0" role="group" aria-label={label}>
      {options.map((o) => (
        <Chip key={o.id} on={value === o.id} resting compact={compact} disabled={disabled} onClick={() => onChange(o.id)} title={o.title}>{o.label}</Chip>
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
              ? { color: "var(--primary-ink)", fontWeight: 700, boxShadow: "inset 0 -2px 0 0 var(--primary)" }
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
          style={{ color: "var(--text3)", border: tintEdge("var(--border)", 40) }}>{kind}</span>
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
   * press — and as the one header in the app that does not match the others.
   *
   * The fill and the hairline are the Git panel's, which is the header that had
   * this right — they are what say "this is a control".
   */
  const style = on ? chipTone(true) : CHIP_SURFACE;
  const safe = href ? externalUrl(href) : undefined;
  return safe
    ? <a href={safe} target="_blank" rel="noreferrer" title={title} className={cls} style={style}>{inner}</a>
    : <button type="button" onClick={onClick} title={title} className={cls} style={style}>{inner}</button>;
}

/**
 * An icon-only control in a header.
 *
 * `HIT` is 26 because a glyph with `px-2` around it is a thin target — the
 * reason `CloseButton` exists and is the size it is. A view that hand-rolls 24
 * is both slightly wrong and slightly different, which is the worse half.
 */
export function IconChip({ onClick, title, label, children, on, bare, disabled, expanded, hasPopup, size = HIT }: {
  onClick: () => void;
  title: string;
  /** The accessible name when it is not the tooltip (a tooltip may carry a hint the name should not). */
  label?: string;
  children: ReactNode;
  on?: boolean;
  /**
   * No chrome at rest: transparent, no edge, the caption ink. The hover tint is
   * `agx-chip`'s, so the glyph answers the pointer without a box around it at
   * rest. This is the look 80 hand-painted icon buttons shared.
   */
  bare?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  hasPopup?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label ?? title}
      disabled={disabled}
      {...(expanded !== undefined ? { "aria-expanded": expanded } : {})}
      {...(hasPopup ? { "aria-haspopup": "menu" as const } : {})}
      className={`${bare ? "agx-chip " : ""}inline-flex items-center justify-center ${CTRL_RADIUS} transition-colors shrink-0 disabled:opacity-40`}
      style={{ width: size, height: size, ...chipTone(!!on), ...(bare && !on ? { color: "var(--text2)" } : null) }}
    >
      {children}
    </button>
  );
}

/** The size an icon inside `IconChip` is drawn at. Named so a call site does not
 *  have to know that the default rung happens to be the right one. */
export const CHIP_ICON = ICON.md;

/**
 * `IconChip` at `CTRL_H.regular` (28) instead of `HIT` (26).
 *
 * The audit found the 2px step in every header that mixes an icon control
 * with `CHIP`: `IconChip` was drawn at `HIT`, and `CHIP` is `min-h-[28px]`,
 * so an icon button and a text chip on the same row never lined up. `HIT`
 * itself is unchanged — it still answers "how small can a square target be"
 * for `CloseButton` and the rail — this is only the rung a header control
 * reaches for instead.
 */
export function IconButton(props: Omit<Parameters<typeof IconChip>[0], "size">) {
  return <IconChip {...props} size={CTRL_H.regular} />;
}

export type ButtonTone = "plain" | "quiet" | "primary" | "danger" | "ok" | "warn";

const TONE_INK: Record<ButtonTone, string> = {
  plain: "var(--text)", quiet: "var(--text2)", primary: "var(--on-primary)", danger: "var(--error-ink)", ok: "var(--success-ink)", warn: "var(--warning-ink)",
};
const TONE_HUE: Record<Exclude<ButtonTone, "plain" | "quiet">, string> = {
  primary: "var(--primary)", danger: "var(--error)", ok: "var(--success)", warn: "var(--warning)",
};

/**
 * The one push button: the `CHIP` shape at a `CTRL_H` rung, in one of five
 * tones.
 *
 * Four of these had grown apart — the PR panel's `Btn` (4px corners, 24 and
 * 28px), the git card's `RowAction` (`CHIP`, 28), Docker's row action (6px
 * corners, 22) and the browser column's tool (6px, 24) — so the PR Files
 * toolbar, a Docker row and a git card each drew "a button" at its own height
 * and radius. They are thin wrappers over this now and keep their own prop
 * names; the shape is decided here.
 *
 * `size`: `compact` (22) for a row, a card or a sub-toolbar, `hit` (26, the house's
 * square target) for the buttons on a board card, `regular` (28) for a view
 * header, the same rung as `CHIP` and `RefreshButton`, `strip` (24)
 * for the Terminal's 32px strip.
 *
 * `tone`: a plain button's label is `--text`, not `--text2` — `--text2` is the
 * tier for labels BESIDE things, and a control read at the contrast of a
 * caption next to the button it competes with. Its fill is `CHIP_SURFACE`'s,
 * because a quiet button still needs an edge you can find: transparent with a
 * half-strength border vanished on the neutral themes, where `--border` sits
 * close to the surface. `warn` is the amber "this mutates the branch" accent
 * (update-branch merges the base in), matching Source Control's sync colour.
 * `primary` is filled and carries the weight: on a neutral theme `--primary`
 * is a grey, so the label's weight says which is which as well. `tint` is an
 * arbitrary colour for a caller whose tones are its own (Docker's start/stop);
 * with `solid` it is filled with that colour and the label is the page
 * background, the verdict button of an alert banner (kit-level: the banner
 * drew this by hand at 24 and 28px, and no tone is filled with a caller's ink).
 *
 * `on` makes it a toggle instead: transparent until pressed, `chipTone` when
 * pressed, no border — the tint IS the state, as in `IconChip`.
 *
 * A FIXED height, contents centred, and `leading-none`. Buttons with identical
 * classes came out different heights, and the cause was the LABEL: `↗` and `⋯`
 * are not in the UI font, so they arrive from a fallback whose line box is
 * taller — measured side by side, 17px for a plain label against 21px for one
 * carrying an arrow. Pinning the line height alone got it to 16/16/16 on one
 * machine, but a fallback differs per machine, per theme font and per glyph, so
 * the height stops being derived from the label at all; padding only decides
 * the width.
 *
 * `pending`: this button's own request is in flight. Every action in the PR
 * panel is a round trip through `gh`, and the only feedback used to be the
 * button going grey — the same grey it wears when disabled for an unrelated
 * reason. The spinner goes IN the button, before the label, and the label
 * stays: a control that swaps its words for "Working…" moves everything beside
 * it, and you can no longer tell which of three buttons you pressed.
 *
 * Its ceiling: shape, size, edge and tone. Hover stays a brightness step, and a
 * caller that needs more passes its own handlers through.
 */
export function Button({
  size = "regular", tone = "plain", tint, solid, on, square, pending, label, href, download, buttonRef,
  children, disabled, title, className = "", style, ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Draws an `<a>` in the same shape: a link that leaves the app (new tab, with a ↗ the caller writes)
   *  or, with `download`, saves a file. Everything else on this list is for a `<button>`. */
  href?: string;
  download?: string;
  size?: "compact" | "strip" | "hit" | "regular";
  tone?: ButtonTone;
  /** A colour of the caller's own, in place of a tone. */
  tint?: string;
  /** With `tint`: filled with it, label in `--bg`, not washed. */
  solid?: boolean;
  /** A toggle: transparent until on. */
  on?: boolean;
  /** Icon-only: as wide as it is tall. */
  square?: boolean;
  pending?: boolean;
  /** The `<button>` itself, for a dialog that puts the focus on Cancel or the confirm action. React 18 does not pass `ref` to a function component. */
  buttonRef?: Ref<HTMLButtonElement>;
  /** The accessible name, for an icon-only button. Also the tooltip unless `title` says otherwise. */
  label?: string;
  children: ReactNode;
}) {
  const h = CTRL_H[size];
  const hue = tint ?? (tone === "plain" || tone === "quiet" ? undefined : TONE_HUE[tone]);
  const skin: CSSProperties = on !== undefined
    ? chipTone(on)
    : tint && solid
      ? { color: "var(--bg)", background: tint, border: tintEdge(tint, 100) }
    : tint
      ? { color: tint, background: `color-mix(in srgb, ${tint} 8%, transparent)`, border: tintEdge(tint, 32) }
      : tone === "plain"
        ? CHIP_SURFACE
        : tone === "quiet"
          // Transparent with the edge kept as an invisible 1px, so a quiet button is the same size as a plain one.
          ? { color: TONE_INK.quiet, background: "transparent", border: tintEdge("var(--text)", 0) }
          : {
          color: TONE_INK[tone],
          background: tone === "primary" ? hue : `color-mix(in srgb, ${hue} ${tone === "warn" ? 16 : 8}%, transparent)`,
          border: tintEdge(hue!, tone === "primary" ? 100 : tone === "warn" ? 55 : 85),
        };
  const text = size === "compact" ? "text-[10.5px]" : "text-[11px]";
  const pad = square ? "" : size === "compact" ? "px-2" : "px-2.5";
  const quiet = tone === "quiet" && !tint && on === undefined;
  const shape = `agx-btn ${quiet ? "agx-chip " : ""}${CHIP_SURFACE_CLS} inline-flex items-center justify-center gap-1 rounded-lg whitespace-nowrap leading-none disabled:opacity-40 ${text} ${pad} ${className}`;
  const look: CSSProperties = {
    height: h, minWidth: square ? h : undefined, width: square ? h : undefined,
    ...skin,
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: tone === "primary" || (tint && solid) ? 600 : 500,
    ...style,
  };
  if (href !== undefined) {
    return (
      <a href={download === undefined ? externalUrl(href) : href} download={download} title={title ?? label} aria-label={label}
        {...(download === undefined ? { target: "_blank", rel: "noreferrer noopener" } : null)}
        className={shape} style={look}>
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || pending}
      /* A button that carries `data-tip` is explained by the one tooltip (TipHost), never by a native title as well. */
      title={"data-tip" in rest ? undefined : pending ? "Working…" : title ?? label}
      aria-label={label}
      aria-busy={pending || undefined}
      data-tone={tint || on !== undefined ? undefined : tone}
      ref={buttonRef}
      className={shape}
      style={look}
    >
      {pending && (
        <span className="agx-spin mr-0.5 shrink-0" aria-hidden
          style={{ width: 9, height: 9, borderWidth: 1.5,
            borderColor: tone === "primary" && !tint && on === undefined ? "color-mix(in srgb, var(--on-primary) 55%, transparent)" : "currentColor",
            borderTopColor: "transparent" }} />
      )}
      {children}
    </button>
  );
}

/**
 * The header refresh control, drawn once instead of the twelve looks the
 * audit found: six spelled the word "Refresh" as visible text, three drew a
 * bare icon, two bordered one, one combined icon and text — and three of the
 * twelve hand-rolled the arrow as an inline `<path>` instead of `RefreshIcon`.
 *
 * Icon-only everywhere now; the word moves into `title` (also used as the
 * `aria-label`), which is where a tooltip and a screen reader both already
 * look for it. `done` is the Git panel's flash of a tick in `--success` once
 * a refresh that changed nothing on screen still needs to say that it ran —
 * opt-in, because every other caller has nothing to report back.
 */
export function RefreshButton({ onRefresh, busy, spinning, done, title, disabled, iconSize = CHIP_ICON }: {
  onRefresh: () => void;
  busy?: boolean;
  /** The refresh's own request is out. `busy` also greys the button for work
   *  that is not a refresh, so a caller that has both says which is which: the
   *  icon turns for exactly `spinning` (and for `busy` when this is absent). */
  spinning?: boolean;
  done?: boolean;
  title: string;
  disabled?: boolean;
  /** The glyph's size; a bar with its own icon rung passes it. */
  iconSize?: number;
}) {
  const turning = spinning ?? busy;
  const showDone = !!done && !busy && !turning;
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={disabled ?? (busy || spinning)}
      title={title}
      aria-label={title}
      className="grid place-items-center rounded-lg shrink-0 transition-colors disabled:opacity-60"
      style={{
        width: CTRL_H.regular, height: CTRL_H.regular,
        ...CHIP_SURFACE,
        color: showDone ? "var(--success)" : CHIP_SURFACE.color,
      }}
    >
      {showDone
        ? <DoneIcon size={iconSize} />
        : <RefreshIcon size={iconSize} className={turning ? "agx-turn" : undefined} />}
    </button>
  );
}

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
      className={`${INPUT} ${className}`.trim()}
      style={INPUT_STYLE}
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

/**
 * A full-width selectable row: a picker's option, a palette hit, a file in a
 * list. 104 raw copies drew this by hand; the hover tint is `agx-chip`'s and the
 * current row is the one pressed tint, so a list reads as one control.
 *
 * `leading` is a mark before the label, `trailing` a slot at the right edge (a
 * count, a shortcut, a tick). The label truncates; a row never grows a second
 * line by itself. Label and trailing both shrink when the row is too narrow, the
 * longer one first: a "Nobody" with a sentence of hint after it kept its hint
 * and lost its own name ("N…") when the trailing slot could not shrink.
 *
 * `sub` is the one line under the label (a path, "local · trunk", the branch a
 * checkout is on). It is what turned this from a menu item into a picker row,
 * so the pieces that come with it are decided here and not by each picker: the
 * label steps up to 12px and `--text` (it is the identity, the sub is the
 * detail), the sub is 10.5px `--text3`, the gap after a `leading` tile opens to
 * 10px, and the row keeps 6px above and below so a 28px tile never touches the
 * hover tint. The pickers drew this by hand, each at its own padding.
 *
 * `roomy` is that same step without a second line, for a row whose `leading` is
 * a 28px tile and whose label is alone beside it.
 *
 * `hot` is the keyboard cursor, a step lighter than `current` (14% against 18%;
 * it was 8% until the palettes moved onto this row, where the cursor was drawn
 * at 14 and 18% and 8% read as no cursor on the neutral themes), so the row the
 * arrows are on and the row that is chosen read as two things. Anything else a
 * picker needs on the button (`role="option"`, `aria-selected`, a mouse-enter
 * that moves the cursor) goes through as it is.
 */
export function ListRow({ children, onClick, current, hot, disabled, leading, trailing, sub, roomy, title, className = "", style, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title" | "style"> & {
  children: ReactNode;
  onClick?: () => void;
  /** The row the list is on now: the pressed tint, and `aria-current`. */
  current?: boolean;
  /** The row the arrow keys are on. */
  hot?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  sub?: ReactNode;
  roomy?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const two = sub != null || !!roomy;
  return (
    <button
      type="button"
      {...rest}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-current={current || undefined}
      className={`agx-chip flex w-full min-w-0 items-center ${two ? "gap-2.5 py-1.5" : "gap-1.5"} px-2.5 text-left text-[11px] ${CTRL_RADIUS} transition-colors disabled:opacity-40 ${className}`.trim()}
      style={{
        minHeight: CTRL_H.regular,
        ...chipTone(!!current),
        ...(hot && !current ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)" } : null),
        color: current || two ? "var(--text)" : "var(--text2)",
        ...style,
      }}
    >
      {leading != null && <span className="shrink-0 inline-flex" aria-hidden>{leading}</span>}
      {two
        ? (
          <span className="min-w-0 flex-[0_1_auto]">
            <span className="block truncate text-[12px] font-medium">{children}</span>
            {sub != null && <span className="block truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{sub}</span>}
          </span>
        )
        : <span className="min-w-0 flex-[0_1_auto] truncate">{children}</span>}
      {trailing != null && <span className={`ml-auto min-w-0 overflow-hidden whitespace-nowrap inline-flex items-center gap-1.5 ${two ? "" : "pl-1.5"}`} style={{ color: "var(--text3)" }}>{trailing}</span>}
    </button>
  );
}

export const TEXTAREA =
  `text-[12px] px-2.5 py-1.5 min-h-[64px] resize-y ${CTRL_RADIUS} bg-[var(--surface-inset)] text-[var(--text)] ` +
  "placeholder:text-[var(--text3)] outline-none transition-colors";

/** `textareaRef` is the `<textarea>` itself, as `buttonRef` is `Button`'s: React 18 does not hand a `ref` to a function component. */
export function Textarea({ className = "", style, textareaRef, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { textareaRef?: Ref<HTMLTextAreaElement> }) {
  return <textarea {...rest} ref={textareaRef} className={`${TEXTAREA} ${className}`.trim()} style={{ ...INPUT_STYLE, ...style }} />;
}

/** A native checkbox and its label as one target, in the house accent. */
export function Checkbox({ checked, onChange, children, disabled, id }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px]" style={{ color: "var(--text2)", opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: "var(--primary)" }} />
      {children}
    </label>
  );
}

/** One option of a radio group; `name` ties the group together. */
export function Radio({ checked, onChange, name, children, disabled }: {
  checked: boolean;
  onChange: () => void;
  name: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px]" style={{ color: "var(--text2)", opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} style={{ accentColor: "var(--primary)" }} />
      {children}
    </label>
  );
}

/**
 * A titled block: the heading (`GROUP_HEADING`'s type, at the block's own left
 * edge), an `aside` at its right (a count, a bulk action), then the content.
 * Six views drew this themselves with six paddings.
 *
 * `fold`: the block opens and shuts (a Jira card's sections). The title becomes
 * a button with a chevron and `aria-expanded`, `count` sits after it in the
 * dimmer ink, and the content is not drawn while shut. Whether it is shut is the
 * caller's: this holds no state and no storage, so a view that remembers it
 * per browser does so beside the call, not in the kit.
 */
export function Section({ title, aside, count, fold, children, className = "" }: {
  title: ReactNode;
  aside?: ReactNode;
  /** A number after the title; only with `fold` it is part of the toggle. */
  count?: ReactNode;
  fold?: { shut: boolean; onToggle: () => void };
  children: ReactNode;
  className?: string;
}) {
  const label = typeof title === "string" ? title : undefined;
  return (
    <section className={className} aria-label={fold ? label : undefined}>
      <div className="flex items-center justify-between gap-2 pt-3 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>
        {fold
          ? (
            <button type="button" onClick={fold.onToggle} aria-expanded={!fold.shut}
              className="agx-btn m-0 min-w-0 flex items-center gap-1.5 text-[10px] uppercase tracking-wider" style={{ color: "inherit" }}>
              <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                className="shrink-0" style={{ transform: fold.shut ? "rotate(-90deg)" : "none", transition: "transform 120ms" }}><path d="m6 9 6 6 6-6" /></svg>
              <span className="truncate">{title}</span>
              {count != null && count !== "" && <span className="tabular-nums" style={{ color: "var(--text4)" }}>{count}</span>}
            </button>
          )
          : <h3 className="m-0 min-w-0 truncate text-[10px] font-normal uppercase tracking-wider">{title}{count != null && count !== "" && <span className="tabular-nums" style={{ color: "var(--text4)" }}> {count}</span>}</h3>}
        {aside != null && <div className="shrink-0 normal-case tracking-normal" style={fold ? { color: "var(--text4)" } : undefined}>{aside}</div>}
      </div>
      {!fold?.shut && children}
    </section>
  );
}

/**
 * A raised block: the card level (`--surface-card`), the hairline, the lift,
 * one step rounder than a control (`rounded-xl`). Settings has `SettingsCard`;
 * this is the one for every other view.
 *
 * `compact` is the padding of a notification (12 / 10px) instead of a panel's
 * 16. It takes a ref and any div attribute (`role`, handlers) so a banner or a
 * toast that animates (`motion.create(Card)`) is this card and not a copy of it;
 * a caller that needs a different surface (a translucent toast, a verdict-tinted
 * edge) passes `style`, which wins.
 */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { compact?: boolean }>(function Card(
  { children, className = "", style, compact, ...rest }, ref,
) {
  return (
    <div {...rest} ref={ref} className={`min-w-0 rounded-xl ${compact ? "px-3 py-2.5" : "p-4"} ${className}`.trim()}
      style={{ background: "var(--surface-card)", border: LINE, boxShadow: "var(--surface-lift)", ...style }}>
      {children}
    </div>
  );
});

/** The hairline between blocks of a divided list. */
export const DIVIDER = "1px solid color-mix(in srgb, var(--border) 30%, transparent)";

/**
 * One block of a divided list that is not a button: a hairline above every
 * block but the first. `divide-y` sets the width and never the colour (Preflight
 * resets `border-color` to `currentColor` and a parent's inline colour does not
 * reach it), so each block carries its own explicit border. The usage panel's
 * provider blocks drew this by hand.
 */
export function Entry({ first, children, className = "" }: { first?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`py-2.5 ${className}`.trim()}
      style={first ? undefined : { borderTop: DIVIDER }}>
      {children}
    </div>
  );
}

/**
 * A row of the notification lists (the bell's and the needs popover's): the
 * `agx-note-row` skin, with `tint` for a row that is waiting on an answer.
 */
export function NoteRow({ tint, children, className = "", ...rest }: HTMLAttributes<HTMLDivElement> & { tint?: string }) {
  return (
    <div {...rest} className={`agx-note-row ${className}`.trim()}
      style={tint ? { background: `color-mix(in srgb, ${tint} 8%, transparent)` } : undefined}>
      {children}
    </div>
  );
}

/* The conversation's geometry, GitHub's: a big avatar outside the card, a rail
   running a little way into the card column with the small events sitting on
   it, and air between entries. Here rather than in the pull request panel
   because the tracker card's activity draws the same timeline: the numbers and
   the rules below are one copy, and `TL_CSS` is a string any view can put in
   its own `<style>` without depending on another view being mounted. */
export const TL_AVATAR = 40;
/** Avatar to card. */
export const TL_GAP = 12;
/** The card's left edge to the rail. */
export const TL_RAIL = 16;
/** Between two entries. */
export const TL_SPACE = 16;
/** A small event's text, and a review's threads, start past the rail. */
export const TL_INDENT = TL_RAIL * 2 + 4;

export const TL_CSS = `
/* One timeline, one rail, laid out the way github.com lays it out, so who said
   what reads at a glance: the speaker's face in a column of its own, their
   remark in a card beside it, and the rail running behind the cards with the
   small events sitting on it. The card's own surface hides the rail where a
   card is; between cards, the rail is what says these happened in an order. */
.agx-tl{position:relative;padding-left:${TL_AVATAR + TL_GAP}px}
.agx-tl::before{content:"";position:absolute;left:${TL_AVATAR + TL_GAP + TL_RAIL - 1}px;top:0;bottom:0;width:2px;background:var(--surface-line)}
.agx-ev{position:relative;margin-bottom:${TL_SPACE}px}
.agx-ev:last-child{margin-bottom:0}
.agx-tl>.agx-tiny{margin-bottom:${TL_SPACE}px}
.agx-av{position:absolute;left:-${TL_AVATAR + TL_GAP}px;top:0;display:flex}
.agx-card{position:relative;background:var(--surface-card)}
.agx-nest{margin:8px 0 0 ${TL_INDENT}px}
/* A card with no avatar beside it: indented past the node, like a small event's text, so the node sits on the rail outside the card. */
.agx-note{margin-left:${TL_INDENT}px;min-width:0}
.agx-node{position:absolute;left:${TL_RAIL - 10}px;top:3px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:9px;background:var(--bg);border:2px solid var(--surface-line);z-index:1}
/* A small event — opened, force-pushed, review requested. It sits ON the rail
   and weighs a fraction of a remark, because it is context rather than
   something anybody said. */
.agx-tiny{position:relative;display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--text3);padding:4px 0 4px ${TL_INDENT}px;min-height:26px}
.agx-tiny .agx-node{top:3px}
.agx-tiny b{color:var(--text2);font-weight:500}
`;
