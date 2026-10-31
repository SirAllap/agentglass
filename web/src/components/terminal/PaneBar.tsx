import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { barKey, branchLabel, chipNameChars, chipParts, pillNameChars, STRIP_H, type ChecksView, type ChipKind, type PaneBarMode, type ReviewState } from "../../lib/paneChip.ts";
import { PaneChipStatus, type PaneChipStatusCard, type PaneChipStatusPr } from "./PaneChipStatus.tsx";
import type { PaneMarker } from "../../lib/paneActionsPref.ts";

/*
 * One bar per pane, hidden under the pane's own bottom edge.
 *
 * What came before this was a 2×2 block of icon-only doors in the pane's
 * bottom-right corner. It worked, and it said nothing: four glyphs cannot name
 * WHICH pull request or WHICH card they open, and a pane in a fleet of six is
 * exactly where that question gets asked. Everything tried to fix it inside the
 * block — a line under the icons, a label on hover, a panel above it — made the
 * corner of a terminal into a paragraph, and a corner that has become a
 * paragraph is not a corner any more.
 *
 * So the block is gone and the bar is the whole thing, with no drawer beside
 * it. It is the strip that used to sit above the terminal —
 * worktree badge, branch, copy, changed count, pull request, card — except that
 * it belongs to ONE pane, is drawn on that pane, and is not there until you ask
 * for it.
 *
 * The asking is a hover, and the affordance is a seam: a 4px line across the
 * pane's foot, tinted by the four things behind it, which is the reason it
 * is not a chevron: a line is simple and clear. Point at the seam and
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
  /** How the bar shows up. The thin line is the default for a machine that already had one. */
  mode?: Exclude<PaneBarMode, "off">;
  /** What the edge looks like: the line, or a small chevron tab. */
  marker?: PaneMarker;
  /** The pointer is in the seam's zone right now. */
  near: boolean;
  /** What this pane is: a worktree, a repo's main checkout, somewhere else, or nothing. */
  kind?: ChipKind;
  /** The repository's name, for a main checkout. */
  repo?: string;
  /** The branch this pane is working in. */
  branch: string;
  /** How many files are uncommitted. */
  dirty: number;
  ahead?: number;
  behind?: number;
  /** The pull request, when the branch has one; its checks, review and the card
   *  are drawn by PaneChipStatus (the one boundary — see that file). */
  pr?: PaneChipStatusPr | null;
  checks?: ChecksView;
  review?: ReviewState;
  reviewWord?: string;
  card?: PaneChipStatusCard | null;
  /** There is no worktree to name — the read is still out, or it came back
   *  with nothing. The seam is drawn either way (a pane that shows nothing at
   *  all is indistinguishable from a broken feature) and the bar says which of
   *  the two it is. */
  note?: string;
  /** The read is still out: the bar says so with a skeleton in place of the parts. */
  loading?: boolean;
  /** A checkout outside this project: the way to its own. */
  noteAction?: { label: string; onClick: () => void };
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
  /** Summary only: out of the way of the last line (see pillPlacement). */
  pill?: { lift: boolean; translucent: boolean };
  /** The pointer or the keyboard reached the pull request: read its checks (once; the store holds them for a minute). */
  onPrReach?: () => void;
  onDown: (e: ReactMouseEvent) => void;
  onGit: () => void;
  onDiff: () => void;
  onPr?: () => void;
  onCard?: () => void;
  onCopy: () => void;
  /** Esc inside the bar: the terminal gets the keyboard back. */
  onEscape?: () => void;
  /** Something is selected in the pane: offer to ask the agent there about it. */
  ask?: { lines: number; onAsk: () => void } | null;
}

/*
 * ONE COLOUR FOR THIS STRIP, and it is the one the person picked.
 *
 * It read as a paint chart: a violet badge, a violet pull request, a blue card
 * and a four-stop rainbow under all of it. None of those were saying anything —
 * the palette's `--info`, `--success` and `--warning` are the words for a link,
 * a pass and a caution, and spending them on chrome is how a warning stops
 * being read as one. What colour is left says ONE thing each: the pull request
 * icon is the pull request's state, the checks disc is the checks, the review
 * mark is the review, the card's flag is its priority and the base under it
 * the status. A failing run is drawn once, on the disc.
 */
const ACCENT = "var(--accent, var(--primary))";

const PLATE = {
  // Opaque, not frosted: this sits over a terminal that repaints constantly,
  // and a backdrop-filter here is a per-frame cost for the whole rectangle.
  background: "var(--surface-card)",
  border: EDGE,
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

// ── the glyphs: the mockup's, on its 24px grid ──────────────────────────────

const G = {
  branch: <><path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  home: <><path d="M3 10.5 12 3l9 7.5V21H3z" /><path d="M9 21v-6h6v6" /></>,
  out: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  diff: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M12 12v6M9 15h6" /></>,
  open: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v12" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /></>,
  draft: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v12" /><path d="M18 11v1M18 6v1" /></>,
  merged: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>,
  closed: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v12" /><path d="M16 4l4 4M20 4l-4 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  flag: <><path d="M4 22V4" /><path d="M4 4h13l-2 4 2 4H4" /></>,
  chev: <path d="m9 18 6-6-6-6" />,
  changes: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
  wait: <circle cx="12" cy="12" r="4.5" />,
};

function Glyph({ g, size = ICON.sm, sw = 2 }: { g: keyof typeof G; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {G[g]}
    </svg>
  );
}

const STOP = "data-chip-stop";

/** The pill's branch: the card id greyed while the whole name fits, else cut to the room there is. */
function PillBranch({ p }: { p: PaneBarProps }) {
  const l = branchLabel(p.branch, p.card?.id, pillNameChars(p.foot.width, !!p.pr, p.dirty > 0));
  return <>{l.pre && <span style={{ color: "var(--text4)" }}>{l.pre}</span>}{l.text}</>;
}

export function PaneBar(p: PaneBarProps) {
  const [hov, setHov] = useState(false);
  const [foc, setFoc] = useState(false);
  const held = hov || foc;
  /* `linger` is the grace period and nothing else: whether the bar is up is
     derived, not stored, so the first paint after the pointer arrives already
     has it up. A stored `on` set from an effect is one frame late — and in a
     static render (the tests) it never arrives at all. */
  const [linger, setLinger] = useState(false);
  const [shout, setShout] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const mode = p.mode ?? "edge";
  const kind: ChipKind = p.kind ?? "worktree";
  const want = p.near || held;
  const pinned = mode === "always";
  const on = pinned || want || linger || shout;

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

  /* Nothing at all while a popup is up — after the hooks, never before them:
     a component that returns early past a `useState` is the black window this
     app has already shipped once. */
  if (p.blocked) return null;

  const { parts, words } = chipParts({
    kind, hasPr: !!p.pr, hasCard: !!p.card, ahead: p.ahead ?? 0, behind: p.behind ?? 0, width: p.foot.width,
  });
  const has = (x: (typeof parts)[number]) => parts.includes(x);
  const label = branchLabel(p.branch, p.card?.id, chipNameChars(p.foot.width, parts, words));

  /* The bar is ONE tab stop (Ctrl+Shift+B puts the keyboard on it) and the
     arrows walk the rest; Esc gives the keyboard back to the terminal. */
  const stops = () => [...(rowRef.current?.querySelectorAll<HTMLElement>(`[${STOP}]`) ?? [])];
  const onKey = (e: ReactKeyboardEvent) => {
    const list = stops();
    const act = barKey(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
    if (!act) return;
    e.preventDefault();
    if ("escape" in act) { (document.activeElement as HTMLElement | null)?.blur?.(); p.onEscape?.(); return; }
    list[act.focus]?.focus();
  };

  const stop = (i: number) => ({ [STOP]: "", tabIndex: i === 0 ? 0 : -1 });
  let n = 0;
  const btn = "agx-btn shrink-0 flex items-center rounded-md text-[11px]";
  const H = { height: HIT } as const;

  const body = (() => {
    if (p.loading) {
      return (<>
        <span className="shrink-0 grid place-items-center rounded-md" style={{ width: 22, height: 22, color: "var(--text4)" }}><Glyph g="branch" size={ICON.xs} /></span>
        <span className="min-w-0 flex-1 truncate px-1.5 text-[11px]" style={{ color: "var(--text4)" }}>Reading this pane…</span>
      </>);
    }
    if (kind === "outside" || kind === "none" || p.note) {
      return (<>
        <span className="shrink-0 grid place-items-center rounded-md" style={{ width: 22, height: 22, color: kind === "outside" ? "var(--warning)" : "var(--text4)", background: kind === "outside" ? "color-mix(in srgb, var(--warning) 12%, transparent)" : "transparent" }}>
          <Glyph g={kind === "outside" ? "out" : "folder"} size={ICON.xs} />
        </span>
        <span className="min-w-0 flex-1 truncate px-1.5 text-[11px]" style={{ color: "var(--text3)" }} title={p.note}>{p.note}</span>
        {p.noteAction && (
          <button {...stop(n++)} onClick={p.noteAction.onClick} className={`${btn} gap-1 px-1.5`} style={{ ...H, color: "var(--text2)" }}>
            <Glyph g="chev" size={ICON.xs} /><span>{p.noteAction.label}</span>
          </button>
        )}
      </>);
    }
    const main = kind === "main";
    const full = `${main && p.repo ? `${p.repo} · ` : ""}${p.branch}`;
    return (<>
      <span className="shrink-0 grid place-items-center rounded-md" title={main ? `Main checkout of ${p.repo ?? "this repository"}` : "Worktree"}
        style={{ width: 22, height: 22, color: main ? "var(--text2)" : ACCENT, background: main ? "color-mix(in srgb, var(--text) 7%, transparent)" : `color-mix(in srgb, ${ACCENT} 14%, transparent)` }}>
        <Glyph g={main ? "home" : "branch"} size={ICON.xs} />
      </span>
      <button
        {...stop(n++)}
        onClick={(e) => { if (e.shiftKey) { p.onCopy(); setCopied(true); setTimeout(() => setCopied(false), 900); } else p.onGit(); }}
        title={`${full}\nclick: Source control · shift+click: copy`}
        className="agx-btn min-w-0 flex-1 justify-start flex items-center rounded-md px-1.5 text-[11px] overflow-hidden whitespace-nowrap"
        style={{ ...H, color: "var(--text)" }}
      >
        {main
          ? <><span style={{ color: "var(--text3)" }}>{p.repo}</span><span style={{ color: "var(--text4)" }}> · </span>{p.branch}</>
          : <>{label.pre && <span style={{ color: "var(--text4)" }}>{label.pre}</span>}{label.text}</>}
      </button>
      {has("copy") && (
        <button {...stop(n++)} onClick={() => { p.onCopy(); setCopied(true); setTimeout(() => setCopied(false), 900); }}
          title="Copy branch name" aria-label="Copy branch name"
          className={`${btn} justify-center`}
          style={{ width: 22, height: 22, color: copied || shout ? "var(--success)" : "var(--text3)" }}
        ><Glyph g={copied || shout ? "check" : "copy"} /></button>
      )}
      {has("sep") && <span aria-hidden className="shrink-0" style={{ width: 1, height: 16, margin: "0 2px", background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />}
      {has("sync") && (
        <button {...stop(n++)} onClick={p.onGit} title={`${p.ahead || 0} to push · ${p.behind || 0} to pull — opens Source control`}
          className={`${btn} gap-1.5 px-1.5 tabular-nums`} style={{ ...H, color: "var(--text3)" }}>
          {(p.ahead ?? 0) > 0 && <span style={{ color: "var(--text2)" }}>↑{p.ahead}</span>}
          {(p.behind ?? 0) > 0 && <span style={{ color: "var(--warning)" }}>↓{p.behind}</span>}
        </button>
      )}
      {(has("card") || has("pr")) && (
        <PaneChipStatus
          pr={p.pr ?? null} checks={p.checks ?? { state: "none-read-yet", passed: 0, total: 0, failing: [] }} review={p.review ?? "none"} reviewWord={p.reviewWord}
          card={has("card") ? p.card ?? null : null} behind={p.behind} worktree={kind === "worktree"} words={words}
          stop={() => stop(n++)} onPr={p.onPr ?? (() => {})} onCard={p.onCard ?? (() => {})} onNew={p.onGit} onReach={p.onPrReach ?? (() => {})} />
      )}
      <button {...stop(n++)} onClick={p.onDiff}
        title={p.dirty > 0 ? `${p.dirty} changed file${p.dirty === 1 ? "" : "s"} — open them in File changes` : "Open this checkout in File changes"}
        className={`${btn} gap-1.5 px-1.5 tabular-nums`} style={{ ...H, color: p.dirty > 0 ? "var(--warning)" : "var(--text3)" }}>
        <Glyph g="diff" />
        {p.dirty > 0 && <span className="font-semibold">{p.dirty}</span>}
        {words && <span>Diff</span>}
      </button>
    </>);
  })();

  const row = (
    <div ref={rowRef} role="toolbar" aria-label="Pane bar (Ctrl+Shift+B)" onKeyDown={onKey}
      onFocus={() => setFoc(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFoc(false); }}
      className="flex items-center gap-1 min-w-0 w-full">
      {body}
      {p.ask && (
        <button
          onClick={p.ask.onAsk}
          title={`Ask the agent in this pane about the ${p.ask.lines === 1 ? "selected line" : `${p.ask.lines} selected lines`}`}
          className="agx-btn shrink-0 flex items-center gap-1.5 rounded px-2 text-[11px] font-medium"
          style={{ height: 22, color: "var(--text)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
        >
          <Glyph g="chev" size={ICON.xs} />
          Ask about this
        </button>
      )}
    </div>
  );

  /* ── Always open: the strip lives in the room the slot kept for it ───── */
  if (pinned) {
    return (
      <div data-pane-bar data-open="1" data-mode="always" onMouseDown={p.onDown}
        className="absolute flex items-center px-1.5"
        style={{
          left: p.foot.left, width: p.foot.width, top: p.foot.top - STRIP_H.always, height: STRIP_H.always, zIndex: 12,
          background: "color-mix(in srgb, var(--surface-card) 55%, var(--bg))",
          borderTop: LINE,
        }}>
        {/* The chip is a plate of its own inside the strip, as in every other mode. */}
        <div className="flex items-center rounded-lg px-1 w-full" style={{ height: 28, background: "var(--surface-card)", border: EDGE }}>
          {row}
        </div>
      </div>
    );
  }


  const summary = mode === "summary";
  const pillOp = p.pill?.translucent ? (p.pill.lift ? 0.8 : 0.55) : 1;

  return (
    <>
      {/* The seam. Decorative on purpose — see the note at the top: at rest this
          pane's bottom rows behave exactly as they did before the feature. */}
      {!summary && p.marker !== "arrow" && (
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
          /* The accent, fading out at both ends — one colour, the one the
             person picked. It was a four-stop rainbow of green, blue, violet
             and amber, which is the palette's whole signal vocabulary spent on
             a decoration: nothing here is a success, a warning or a link, and
             a strip that borrows those words says something it does not mean. */
          background: "linear-gradient(90deg, transparent, var(--accent, var(--primary)), transparent)",
          opacity: on ? 0 : p.near ? 1 : 0.5,
          transition: "opacity .14s ease",
        }}
      />)}
      {!summary && p.marker === "arrow" && (
        <div data-pane-arrow aria-hidden className="absolute pointer-events-none grid place-items-center"
          style={{
            left: p.foot.left + p.foot.width / 2 - (p.near ? 19 : 15), top: p.foot.top - (p.near ? 15 : 11), width: p.near ? 38 : 30, height: p.near ? 15 : 11,
            borderRadius: "6px 6px 0 0", zIndex: 11, color: ACCENT,
            background: `color-mix(in srgb, ${ACCENT} ${p.near ? 26 : 16}%, var(--surface-card))`,
            border: EDGE, borderBottom: 0,
            opacity: on ? 0 : 1, transition: "opacity .14s ease, width .15s ease, height .15s ease",
          }}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "rotate(-90deg)" }}>{G.chev}</svg>
        </div>
      )}
      {/* Summary: a pill at the pane's bottom right and a soft fade behind it
          only. No band, no reserved row: the last line stays readable on its
          left, and where it would run under the pill the pill steps up. */}
      {summary && (<>
        <div aria-hidden className="absolute pointer-events-none" style={{
          left: p.foot.left + p.foot.width - 260, top: p.foot.top - 34, width: 260, height: 34, zIndex: 11,
          background: "radial-gradient(ellipse 100% 100% at 100% 100%, color-mix(in srgb, var(--bg) 94%, transparent) 0 46%, transparent 100%)",
          opacity: on ? 0 : pillOp, transition: "opacity .14s ease",
        }} />
        <button
          data-pane-pill
          onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
          onFocus={() => setFoc(true)} onBlur={() => setFoc(false)}
          onMouseDown={p.onDown}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); p.onEscape?.(); } }}
          aria-label={`Pane bar: ${p.branch}. Ctrl+Shift+B focuses it; Enter opens the full bar.`}
          className="agx-btn absolute flex items-center gap-1.5 rounded-md text-[11px]"
          style={{
            left: p.foot.left + p.foot.width - 8, top: p.foot.top - 5 - 22 - (p.pill?.lift ? 26 : 0), height: 22, zIndex: 11,
            transform: "translateX(-100%)", padding: "0 8px 0 4px", color: "var(--text2)", maxWidth: Math.max(60, p.foot.width - 16),
            background: "color-mix(in srgb, var(--bg) 90%, var(--bg3))",
            boxShadow: "0 0 0 1px color-mix(in srgb, var(--text) 11%, transparent), 0 1px 2px rgba(0,0,0,.08)",
            opacity: on ? 0 : pillOp, pointerEvents: on ? "none" : "auto", transition: "opacity .14s ease, top .18s cubic-bezier(.23,1,.32,1)",
          }}>
          <span className="grid place-items-center rounded" style={{ width: 16, height: 16, color: kind === "main" ? "var(--text2)" : kind === "outside" ? "var(--warning)" : ACCENT, background: kind === "main" ? "color-mix(in srgb, var(--text) 7%, transparent)" : `color-mix(in srgb, ${kind === "outside" ? "var(--warning)" : ACCENT} 14%, transparent)` }}>
            <Glyph g={kind === "main" ? "home" : kind === "outside" ? "out" : kind === "none" ? "folder" : "branch"} size={ICON.xs} />
          </span>
          <span className="truncate">
            {p.loading ? "…" : kind === "main" ? `${p.repo ?? ""} · ${p.branch}` : kind === "worktree" ? <PillBranch p={p} /> : p.note}
          </span>
          {p.pr && <span className="flex items-center gap-1 tabular-nums" style={{ color: "var(--text3)" }}>
            {p.pr.state === "merged" ? <Glyph g="merged" size={ICON.xs} />
              : <span className="rounded-full" style={{ width: 6, height: 6, background: p.checks?.state === "failing" ? "var(--error)" : p.pr.state === "draft" ? "var(--text3)" : "var(--success)" }} />}
            #{p.pr.number}
          </span>}
          {p.dirty > 0 && <span style={{ color: "var(--warning)" }}>±{p.dirty}</span>}
        </button>
      </>)}
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
        className={`absolute flex ${summary ? "justify-end" : "justify-center"}`}
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
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        className="flex items-center rounded-xl px-1 leading-none"
        style={{
          height: BAR_H,
          maxWidth: Math.max(0, p.foot.width - 16),
          width: summary ? Math.min(560, p.foot.width - 16) : undefined,
          marginRight: summary ? 8 : undefined,
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
        {row}
      </div>
      </div>
    </>
  );
}
