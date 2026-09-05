import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ICON } from "../../lib/iconSize.ts";

/*
 * One bar per pane, hidden under the pane's own bottom edge.
 *
 * What came before this was a 2×2 block of icon-only doors in the pane's
 * bottom-right corner. It worked, and it said nothing: four glyphs cannot name
 * WHICH pull request or WHICH card they open, and a pane in a fleet of six is
 * exactly where that question gets asked. Everything tried to fix it inside the
 * block — a line under the icons, a label on hover, a panel above it — made the
 * corner of a terminal into a paragraph, and he said so: "what a shitty piece of
 * UI this is".
 *
 * So the block is gone and the bar is the whole thing: "we no longer need the
 * drawer, only the bar". It is the strip that used to sit above the terminal —
 * worktree badge, branch, copy, changed count, pull request, card — except that
 * it belongs to ONE pane, is drawn on that pane, and is not there until you ask
 * for it.
 *
 * The asking is a hover, and the affordance is a seam: a 4px line across the
 * pane's foot, tinted by the four things behind it, which is his own idea and
 * the reason it is not a chevron — "es sencillo y claro". Point at the seam and
 * the bar rises out of the edge; take the pointer away and it drops back, after
 * a grace period, because leaving by accident must not cost you the bar.
 *
 * Two rules the previous attempt broke:
 *
 *   - The pane NEVER moves. The bar floats over the shell; nothing is resized,
 *     nothing reflows, no row of output is lost to it.
 *   - Nothing is stolen at rest. The seam is `pointer-events: none` — the
 *     terminal's own bottom rows keep every click and every drag. The pointer
 *     is watched by the pane slot, which is already watching it for tmux.
 */

/** The visible line, and how far above the pane's edge the pointer counts as
 *  "on it". The zone is deliberately taller than the line: this is a target you
 *  should hit without aiming.
 *
 *  3px, flush with the pane's last pixel row. At 4px with a 3px gap it was
 *  drawn straight through the descenders of the bottom line — "can you put it
 *  a bit lower so it doesn't sit on top of the text?", with a screenshot of the line
 *  it was crossing. A terminal's last row goes all the way to the edge, so the
 *  only place a line does not cover a letter is under the baseline of the last
 *  one. */
export const SEAM_H = 3;
export const SEAM_ZONE = 16;
/** The plate's own height, and the gap between it and the pane's edge. */
export const BAR_H = 32;
export const BAR_GAP = 8;
/** A pane shorter than this has no room to give: the bar would cover the prompt
 *  it is describing. */
export const BAR_MIN_H = BAR_H + BAR_GAP + 40;
export const BAR_MIN_W = 210;

export interface PaneBarProps {
  /** The pane's bottom edge and width, in the slot's coordinates — paneFoot. */
  foot: { left: number; top: number; width: number };
  /** The pointer is in the seam's zone right now. */
  near: boolean;
  /** The branch this pane is working in. */
  branch: string;
  /** How many files are uncommitted. */
  dirty: number;
  /** The pull request, when the branch has one. Absent means no button: a
   *  control that is always refused is worse than no control. */
  pr?: { number: number; title: string; changes: boolean } | null;
  /** The card, same rule. */
  card?: { label: string; prio: string | null; inApp: boolean } | null;
  /** There is no worktree to name — the read is still out, or it came back
   *  with nothing. The seam is drawn either way (a pane that shows nothing at
   *  all is indistinguishable from a broken feature) and the bar says which of
   *  the two it is. */
  note?: string;
  /** A tmux popup is up over this terminal, and nothing of ours is drawn while
   *  it is — seam included.
   *
   *  A popup is painted INTO this screen: same windows, same panes, only the
   *  pixels change. So a 3px line at "the pane's edge" is a 3px line across
   *  somebody's scratch, which is exactly how it was reported, twice, the
   *  second time with the gradient running through the popup's own text.
   *
   *  Keeping the seam was an attempt to survive a stale popup signal — a
   *  scratch client can outlive the popup that opened it — and it bought that
   *  at the cost of drawing on top of the thing being read. The state is not
   *  invisible any more anyway: the tab row wears a POPUP chip for as long as
   *  tmux says one is up, so a stale signal has somewhere to be seen. */
  blocked?: boolean;
  /** How long the bar forgives you for leaving. */
  grace?: number;
  /** A stamp that changes when the branch was copied by keyboard. The bar comes
   *  up for a moment with its copy button green: the feedback is not "copied",
   *  it is WHICH branch was copied, which is the part you cannot check without
   *  pasting it somewhere. */
  flash?: number;
  onDown: (e: ReactMouseEvent) => void;
  onGit: () => void;
  onDiff: () => void;
  onPr?: () => void;
  onCard?: () => void;
  onCopy: () => void;
  /** Something is selected in the pane: offer to ask the agent there about it. */
  ask?: { lines: number; onAsk: () => void } | null;
}

/** Priority → the colour the card wears, the same four the card panel uses. */
const PRIO: Record<string, string> = {
  urgent: "var(--error)",
  high: "var(--warning)",
  normal: "var(--info)",
  low: "var(--text3)",
};

const PLATE = {
  // Opaque, not frosted: this sits over a terminal that repaints constantly,
  // and a backdrop-filter here is a per-frame cost for the whole rectangle.
  background: "var(--bg2)",
  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
  boxShadow: "0 14px 34px -12px var(--shadow)",
} as const;

/**
 * The branch name, cut in the middle when it has to be cut.
 *
 * A branch is named for what it does at the END (…-when-archived), so a cut
 * that eats the tail leaves every branch in a fleet reading the same. Measured
 * against the box it is in rather than guessed from a character count: the same
 * name has room on a full-width pane and none on a quarter of one.
 */
export function midCut(name: string, chars: number, tail = 16): string {
  if (name.length <= chars || chars <= tail + 2) return name;
  return name.slice(0, chars - tail - 1) + "…" + name.slice(-tail);
}

export function PaneBar(p: PaneBarProps) {
  const [held, setHeld] = useState(false);
  /* `linger` is the grace period and nothing else: whether the bar is up is
     derived, not stored, so the first paint after the pointer arrives already
     has it up. A stored `on` set from an effect is one frame late — and in a
     static render (the tests) it never arrives at all. */
  const [linger, setLinger] = useState(false);
  const [shout, setShout] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const want = p.near || held;
  const on = want || linger || shout;

  /* The keyboard's copy, answered. There is no toast over a terminal in this
     app and a line written into the shell would be a line in somebody's command
     history, so the answer is the bar itself: up for a moment, green tick, gone
     — "when I press ctrl+shift+c to copy the branch it must give feedback". */
  useEffect(() => {
    if (!p.flash) return;
    setShout(true);
    const t = setTimeout(() => setShout(false), 1500);
    return () => clearTimeout(t);
  }, [p.flash]);

  /* Up while the pointer is in the seam's zone or on the bar itself; down on a
     timer, so travelling from one to the other — which passes over neither for
     a frame or two — never counts as leaving. */
  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (want) { setLinger(true); return; }
    timer.current = setTimeout(() => { setLinger(false); timer.current = null; }, p.grace ?? 400);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [want, p.grace]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // How much name the plate can show: the buttons beside it are fixed, so what
  // is left is what the branch gets.
  const chips = 30 + (p.dirty > 0 ? 46 : 0) + (p.pr ? 74 : 0) + (p.card ? 108 : 0);
  const room = Math.max(60, Math.min(p.foot.width - 24, 620) - chips - 66);
  const label = midCut(p.branch, Math.max(10, Math.floor(room / 7)));

  /* Nothing at all while a popup is up — after the hooks, never before them:
     a component that returns early past a `useState` is the black window this
     app has already shipped once. */
  if (p.blocked) return null;

  const icon = (d: string, size: number = ICON.xs) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );

  return (
    <>
      {/* The seam. Decorative on purpose — see the note at the top: at rest this
          pane's bottom rows behave exactly as they did before the feature. */}
      <div
        data-pane-seam
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          left: p.foot.left + 6,
          top: p.foot.top - SEAM_H,
          width: Math.max(0, p.foot.width - 12),
          height: SEAM_H,
          borderRadius: 3,
          zIndex: 11,
          background: "linear-gradient(90deg, var(--success, #98c379), var(--info), var(--primary), var(--warning))",
          opacity: on ? 0 : p.near ? 1 : 0.5,
          transition: "opacity .14s ease",
        }}
      />
      {/*
        * A row the width of the pane, and the plate centred inside it.
        *
        * The plate used to be the positioned box itself, at `left: <middle of
        * the pane>` with a -50% transform. The transform moves the pixels; it
        * does NOT move the layout box, whose right edge therefore sat up to
        * half a pane past where it appeared to — and an absolutely positioned
        * box that reaches past its container still counts towards the
        * document's scrollable width. Every view in the app grew a horizontal
        * scrollbar along the bottom.
        *
        * Clipping the container fixed that and cost a row of the terminal:
        * xterm's own viewport overhangs its box by the remainder of a cell, so
        * `overflow: hidden` on the grid cut the last line of every pane — "the
        * console is missing a strip at the bottom", proved with a horizontal split.
        *
        * A wrapper exactly as wide as the pane needs neither: nothing sticks
        * out, so nothing has to be clipped.
        */}
      <div
        aria-hidden={!on}
        className="absolute flex justify-center"
        style={{
          left: p.foot.left,
          width: p.foot.width,
          top: p.foot.top - BAR_H - BAR_GAP,
          height: BAR_H,
          zIndex: 12,
          pointerEvents: "none",
        }}>
      <div
        data-pane-bar
        data-open={on ? "1" : "0"}
        onMouseDown={p.onDown}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        className="flex items-center gap-1.5 rounded-xl px-2 leading-none"
        style={{
          height: BAR_H,
          maxWidth: Math.max(0, p.foot.width - 16),
          ...PLATE,
          // Pushed back down under the pane's edge when it is not wanted.
          // `translateY` rather than `top`, so it is one composited transform.
          transform: on ? "translateY(0)" : `translateY(${BAR_H + BAR_GAP + 6}px)`,
          opacity: on ? 1 : 0,
          pointerEvents: on ? "auto" : "none",
          transition: on
            ? "transform .2s cubic-bezier(.16,.9,.3,1), opacity .12s ease"
            : "transform .16s cubic-bezier(.4,0,.7,.3), opacity .1s ease",
        }}>
        {p.note ? (
          <span className="px-1 text-[11px]" style={{ color: "var(--text3)" }}>{p.note}</span>
        ) : (<>
        <span
          className="shrink-0 text-[9px] leading-none px-1.5 py-1 rounded"
          style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}
        >WT</span>
        <button
          onClick={p.onGit}
          title={`${p.branch}\nOpen its Source control`}
          className="agx-btn min-w-0 shrink truncate rounded px-1 text-[11px] font-medium"
          style={{ color: "var(--text)" }}
        >{label}</button>
        <button
          onClick={() => { p.onCopy(); setCopied(true); setTimeout(() => setCopied(false), 900); }}
          title="Copy branch name"
          className="agx-btn shrink-0 grid place-items-center rounded"
          style={{ width: 22, height: 22, color: copied || shout ? "var(--success, #98c379)" : "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
        >{copied || shout
          ? icon("M3 8.4l3.4 3.4L13 4.6", ICON.sm)
          : (
            <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="5.4" y="5.4" width="8" height="8" rx="1.6" />
              <path d="M10.6 5.4V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v5a1.6 1.6 0 0 0 1.6 1.6h1.4" />
            </svg>
          )}</button>
        {p.ask && (
          <button
            onClick={p.ask.onAsk}
            title={`Ask the agent in this pane about the ${p.ask.lines === 1 ? "selected line" : `${p.ask.lines} selected lines`}`}
            className="agx-btn shrink-0 flex items-center gap-1.5 rounded px-2 text-[11px] font-medium"
            style={{ height: 22, color: "var(--text)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /><path d="M5.5 7h5" />
            </svg>
            Ask about this
          </button>
        )}
        <span aria-hidden className="shrink-0 self-stretch my-1.5" style={{ width: 1, background: "color-mix(in srgb, var(--border) 55%, transparent)" }} />
        <button
          onClick={p.onDiff}
          title={p.dirty > 0
            ? `${p.dirty} changed file${p.dirty === 1 ? "" : "s"} — open them in File changes`
            : "Open this checkout in File changes"}
          className="agx-btn shrink-0 flex items-center gap-1.5 rounded px-2 text-[11px] tabular-nums"
          style={{ height: 22, color: p.dirty > 0 ? "var(--warning)" : "var(--text2)", border: `1px solid color-mix(in srgb, ${p.dirty > 0 ? "var(--warning)" : "var(--border)"} 45%, transparent)` }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3.6 1.8h5l4 4v8.4h-9z" /><path d="M8.6 1.8v4h4" /><path d="M5.9 9h4.4M8.1 6.8v4.4" />
          </svg>
          {p.dirty > 0 ? p.dirty : "Diff"}
        </button>
        {p.pr && p.onPr && (
          <button
            onClick={p.onPr}
            title={`#${p.pr.number} ${p.pr.title}\nOpen it in Pull requests`}
            className="agx-btn shrink-0 flex items-center gap-1.5 rounded px-2 text-[11px] tabular-nums"
            style={{ height: 22, color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="4.2" cy="3.6" r="1.7" /><circle cx="4.2" cy="12.4" r="1.7" /><path d="M4.2 5.3v5.4" />
              <circle cx="11.8" cy="12.4" r="1.7" /><path d="M11.8 10.7V6.6a2 2 0 0 0-2-2H7.3" /><path d="M8.9 3 7.2 4.6 8.9 6.2" />
            </svg>
            #{p.pr.number}
            {/* Changes requested is the one review state that is about YOU, so
                it is the only one drawn — as a dot, not a word. */}
            {p.pr.changes && <span className="rounded-full" style={{ width: 5, height: 5, background: "var(--error)" }} />}
          </button>
        )}
        {p.card && p.onCard && (
          <button
            onClick={p.onCard}
            title={`${p.card.label}${p.card.prio ? ` · ${p.card.prio}` : ""}\n${p.card.inApp ? "Open it in Tasks" : "Open it in the tracker"}`}
            className="agx-btn shrink-0 flex items-center gap-1.5 rounded px-2 text-[11px]"
            style={{ height: 22, color: PRIO[p.card.prio ?? ""] ?? "var(--info)", border: `1px solid color-mix(in srgb, ${PRIO[p.card.prio ?? ""] ?? "var(--info)"} 45%, transparent)` }}
          >
            {/* The priority IS the icon: a flag in the colour the tracker gives
                it, which is the one thing about a card you read at a glance. */}
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M4 2.2a.7.7 0 0 1 1.4 0v.6h6.1c.5 0 .8.6.5 1L10.7 6l1.3 2.2c.3.4 0 1-.5 1H5.4v4.6a.7.7 0 0 1-1.4 0z" />
            </svg>
            {p.card.label}
          </button>
        )}
        </>)}
      </div>
      </div>
    </>
  );
}
