import { useEffect, useRef, useState } from "react";
import { HIT } from "../../lib/iconSize.ts";
import { prChipLabel, type ChecksView, type PrState, type ReviewState } from "../../lib/paneChip.ts";
import { PaneChipHover } from "./PaneChipHover.tsx";

/*
 * THE ONE BOUNDARY for the right-hand segment of the pane chip: the card, the
 * pull request, its checks and its review.
 *
 * Everything else in the chip (kind, branch, copy, sync, Diff, the three
 * triggers) is decided and drawn elsewhere; this file is the only place that
 * draws these four facts ("Halo": the pull request icon wears its checks as a
 * ring, review is a badge clipped on it, the capsule is tinted with the pull
 * request's state). Its styles are `.agx-halo*` and `.agx-ps-*` in index.css.
 *
 * The contract, whatever the design:
 *   - the segment is right-anchored and each fact keeps a FIXED slot, so no
 *     state moves the Diff button beside it;
 *   - the pull request control is ONE tab stop (`stop`) and opens Pull requests;
 *   - it reports reach (hover or focus) through `onReach` and shows the hover
 *     card (PaneChipHover) after a breath;
 *   - a worktree with no pull request shows a "new" slot (`onNew`), a main
 *     checkout shows nothing there;
 *   - what the checks say is only what was read: none-read-yet and error are
 *     drawn as unknown (a dashed ring), never as a last colour.
 */

export interface PaneChipStatusPr {
  number: number;
  title: string;
  state: PrState;
  author?: string;
  /** The branch it merges into. */
  base?: string;
}

export interface PaneChipStatusCard {
  id: string;
  /** The tracker's own words, and its colour for them, when its answer carried a status. */
  status: string | null;
  statusColor?: string | null;
  priority: string | null;
  /** Opens in the Tasks view (true) or in the tracker's own site (false). */
  inApp: boolean;
}

export interface PaneChipStatusProps {
  /** `null` is "no pull request". */
  pr: PaneChipStatusPr | null;
  checks: ChecksView;
  review: ReviewState;
  /** The review in words, for the hover card ("Changes requested"). */
  reviewWord?: string;
  card: PaneChipStatusCard | null;
  /** Commits the checkout is behind its upstream (GitRepoRef.behind), for the hover card. */
  behind?: number;
  /** A worktree: with no pull request the "new" slot is drawn. A main checkout draws nothing there. */
  worktree: boolean;
  /** False on a narrow pane: the words go, the order stays. */
  words: boolean;
  /** Roving tab index: the chip hands each stop its props, in order. */
  stop: () => Record<string, string | number>;
  onPr: () => void;
  onCard: () => void;
  /** No pull request yet: opens Source control, where one is made. */
  onNew: () => void;
  /** The pointer or the keyboard reached the pull request: read its checks (the store holds them a minute). */
  onReach: () => void;
}

/** The PR icon paths, on the 24px grid. */
export const PR_GLYPH: Record<PrState, React.ReactNode> = {
  open: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v12" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /></>,
  draft: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v12" /><path d="M18 11v1M18 6v1" /></>,
  merged: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>,
  closed: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v12" /><path d="M16 4l4 4M20 4l-4 4" /></>,
};
/** The state's colour: the pull request icon says the pull request's state and nothing else. */
export const PR_COLOR: Record<PrState, string> = {
  open: "var(--success)", draft: "var(--text3)", merged: "var(--merged-ink, var(--info))", closed: "var(--error)",
};

const Svg = ({ children, sw = 2.2 }: { children: React.ReactNode; sw?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

/** The ring: passed share in green, a thicker red arc for what failed, a pale
 *  arc for what is running (plus one comet, drawn apart), dashed when nobody
 *  has read the checks. A merged or closed pull request freezes it in its own colour. */
export function HaloRing({ checks, frozen }: { checks: ChecksView; frozen: boolean }) {
  const box = 22, c = 11, r = 9.2, sw = 2.2, C = 2 * Math.PI * r;
  if (checks.state === "none-read-yet" || checks.state === "error") {
    return <svg className="r" viewBox={`0 0 ${box} ${box}`} aria-hidden><circle cx={c} cy={c} r={r} fill="none" stroke="var(--text3)" strokeWidth={1.4} strokeDasharray="2.1 2.4" /></svg>;
  }
  const n = Math.max(1, checks.total);
  const failed = checks.failing.length;
  const running = checks.state === "running" ? Math.max(0, checks.total - checks.passed - failed) : 0;
  const gap = failed || running ? 1.3 : 0;
  let at = 0;
  const arcs = ([["p", checks.passed], ["f", failed], ["r", running]] as const).filter(([, v]) => v > 0).map(([k, v]) => {
    const len = (C * v) / n;
    const stroke = frozen ? "color-mix(in srgb, var(--sc) 55%, transparent)" : k === "p" ? "var(--success)" : k === "f" ? "var(--error)" : "var(--warning)";
    const el = <circle key={k} className="agx-halo-arc" cx={c} cy={c} r={r} stroke={stroke} strokeWidth={k === "f" && !frozen ? sw + 0.8 : sw}
      strokeDasharray={`${Math.max(len - gap, 0.5)} ${C}`} strokeDashoffset={-at} strokeOpacity={k === "r" ? 0.35 : undefined} />;
    at += len;
    return el;
  });
  return <svg className="r" viewBox={`0 0 ${box} ${box}`} aria-hidden><circle className="agx-halo-trk" cx={c} cy={c} r={r} strokeWidth={sw} />{arcs}</svg>;
}

/** One slow comet while the checks run; nothing else on the segment moves. */
function Comet() {
  const c = 11, r = 9.2, C = 2 * Math.PI * r;
  return (
    <span className="agx-halo-spin" aria-hidden>
      <svg viewBox="0 0 22 22" style={{ transform: "rotate(-90deg)" }}><circle cx={c} cy={c} r={r} fill="none" stroke="var(--warning)" strokeWidth={2.2} strokeLinecap="round" strokeDasharray={`${C * 0.16} ${C}`} /></svg>
    </span>
  );
}

export function PaneChipStatus(p: PaneChipStatusProps) {
  const [cardOn, setCardOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /* The hover card appears after a breath, not on every pass of the pointer. */
  const reach = () => {
    p.onReach();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCardOn(true), 150);
  };
  const leave = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setCardOn(false);
  };

  const c = p.card;
  const pr = p.pr;
  const frozen = !!pr && (pr.state === "merged" || pr.state === "closed");
  return (
    <>
      {c && (
        <button {...p.stop()} onClick={p.onCard} className="agx-btn agx-ps-card text-[11px]"
          style={{ ["--sc" as string]: c.statusColor || "var(--text4)", height: HIT }}
          title={`${c.id}${c.status ? ` · ${c.status}` : ""}${c.priority ? ` · ${c.priority}` : ""}\n${c.inApp ? "Open it in Tasks" : "Open it in the tracker"}`}>
          <span className="agx-ps-tile" style={{ color: c.priority === "urgent" ? "var(--error)" : c.priority === "high" ? "var(--warning)" : c.priority === "low" ? "var(--text3)" : "var(--info)" }}>
            <Svg sw={2.4}><path d="M4 22V4" /><path d="M4 4h13l-2 4 2 4H4" /></Svg>
          </span>
          {p.words && c.id}
        </button>
      )}
      {pr && (
        <span className="relative shrink-0 flex items-center" style={{ height: HIT }} onMouseEnter={reach} onMouseLeave={leave}>
          <button {...p.stop()} onClick={p.onPr} onFocus={reach} onBlur={leave} className="agx-btn agx-halo text-[11px] tabular-nums"
            data-frozen={frozen ? "" : undefined} style={{ ["--sc" as string]: PR_COLOR[pr.state] }}
            aria-label={prChipLabel(pr, p.checks, p.review)}>
            <span className="agx-halo-ring">
              <HaloRing checks={p.checks} frozen={frozen} />
              {p.checks.state === "running" && !frozen && <Comet />}
              <span className="agx-halo-pi"><Svg sw={2.6}>{PR_GLYPH[pr.state]}</Svg></span>
              {(p.review === "approved" || p.review === "changes") && (
                <span className="agx-halo-rv" style={{ background: p.review === "approved" ? "var(--success)" : "var(--warning)" }}>
                  <Svg sw={p.review === "approved" ? 4 : 3.4}>{p.review === "approved" ? <path d="M20 6 9 17l-5-5" /> : <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>}</Svg>
                </span>
              )}
            </span>
            <span style={{ fontWeight: 500, letterSpacing: "-.01em", color: frozen ? "var(--text2)" : "var(--text)" }}>#{pr.number}</span>
            <span className="agx-halo-tail">{p.checks.state === "failing" && !frozen && <span className="agx-halo-cnt text-[10px]">{p.checks.failing.length}×</span>}</span>
          </button>
          {cardOn && <PaneChipHover pr={pr} checks={p.checks} review={p.review} reviewWord={p.reviewWord} card={c} behind={p.behind} />}
        </span>
      )}
      {!pr && p.worktree && (
        <button {...p.stop()} onClick={p.onNew} title="No pull request from this branch yet — opens Source control"
          className="agx-btn shrink-0 flex items-center gap-1 rounded-md px-1.5 text-[11px] whitespace-nowrap"
          style={{ height: HIT, color: "var(--text3)", border: "1px dashed var(--border2)" }}>
          + {p.words ? "PR" : ""}
        </button>
      )}
    </>
  );
}
