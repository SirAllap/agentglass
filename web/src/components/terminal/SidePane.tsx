import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ICON } from "../../lib/iconSize.ts";
import { ExpandIcon, IconLabel, MaxWidthIcon, PinIcon, SplitIcon } from "../../lib/glyphIcons.tsx";
import { ExternalIcon } from "../browser/icons.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { Button, EDGE, IconButton, LINE, Segmented } from "../workspace/Chrome.tsx";
import { Spinner } from "../Spinner.tsx";
import { LAYER } from "../../lib/layers.ts";
import {
  canRestore, closeSide, DIVIDER_PX, effectiveSplitSection, keepAlive, rememberScroll, scrollOf, sectionForKey, setSection, setSplitSection,
  SIDE_SECTIONS, togglePin, toggleCompact, toggleMaxWidth, toggleSplit,
  type SidePaneView, type SideSection, type SplitSection,
} from "../../lib/sidePane.ts";
import { liveTabFacts } from "../../lib/tabFacts.ts";

/*
 * The pane beside a terminal: Card | PR | Diff for the checkout in front of you.
 *
 * It owns the frame only (header, badges, pin, compact, pop out, close, the divider).
 * Everything inside is the app's own view, mounted for the section on screen and
 * dropped on a switch: the pull request detail is PrView, the card is the board's
 * card, the diff is DiffPage. The frame polls nothing; what changes arrives through the
 * stores those views already read (a ClickUp card section reads through the board's own load, see CardEmbed), and the badges are drawn from the same facts
 * the pane bar draws.
 *
 * It never takes the keyboard. A press on the header is kept off the focus, an
 * update only changes what is drawn, and Escape inside it gives the focus back to
 * the terminal.
 */

const PrView = lazy(() => import("../PrPanel.tsx").then((m) => ({ default: m.PrView })));
const CardEmbed = lazy(() => import("../TasksPanel.tsx").then((m) => ({ default: m.CardEmbed })));
const DiffPage = lazy(() => import("../diff/DiffPage.tsx").then((m) => ({ default: m.DiffPage })));

export type BadgeTone = "bad" | "good" | "warn" | "accent" | "none";

/** What the header and the compact view say about the checkout; drawn from the pane bar's own facts. */
export interface SideSubject {
  /** Changes when the pane is about a different checkout, so the content below it remounts. */
  key: string;
  /** The checkout's root. */
  root: string;
  branch: string;
  card: { query: string; label: string; tracker?: "jira" } | null;
  cardStatus: string | null;
  cardColor: string | null;
  pr: { repo: string; number: number; title: string } | null;
  prText: string;
  prTone: BadgeTone;
  reviewText: string;
  diffText: string;
  filter: string;
}

const TONE: Record<BadgeTone, string> = {
  bad: "var(--error-ink)", good: "var(--success-ink)", warn: "var(--warning-ink)", accent: "var(--primary-ink)", none: "var(--text3)",
};

const TONE_FILL: Record<BadgeTone, string> = {
  bad: "var(--error)", good: "var(--success)", warn: "var(--warning)", accent: "var(--primary)", none: "var(--text3)",
};

/* The diff's line totals and the card's status, as the diff/card sections
   themselves read them, live in the tab's own TabFacts record
   (lib/tabFacts.ts) — never a module-level cache keyed by root:branch, and
   never bounded by an LRU that would evict a still-open tab's facts under
   churn: `forgetTab` already drops the whole record when the window closes,
   so a reused tab id after a server restart starts from `undefined`, not a
   stale value. */
function noteTotals(tab: string, t: { files: number; add: number; del: number }) {
  const o = liveTabFacts.get(tab)?.diff;
  if (o && o.files === t.files && o.add === t.add && o.del === t.del) return;
  liveTabFacts.write(tab, { diff: t });
}
function useTotals(tab: string) {
  useSyncExternalStore(liveTabFacts.subscribe, liveTabFacts.version, () => 0);
  return liveTabFacts.get(tab)?.diff ?? undefined;
}

/* A Jira card has no status in the pane bar's own facts (only a ClickUp
   card's does, via useTabFactsWriter), so the card section's own read is
   kept here instead. */
function noteStatus(tab: string, s: { title: string; color: string | null }) {
  const o = liveTabFacts.get(tab)?.jiraStatus;
  if (o && o.title === s.title && o.color === s.color) return;
  liveTabFacts.write(tab, { jiraStatus: s });
}
function useStatus(tab: string, subject: SideSubject | null) {
  useSyncExternalStore(liveTabFacts.subscribe, liveTabFacts.version, () => 0);
  const seen = liveTabFacts.get(tab)?.jiraStatus ?? undefined;
  if (!subject) return null;
  if (subject.cardStatus) return { title: subject.cardStatus, color: subject.cardColor ?? "var(--text4)" };
  if (!seen) return null;
  const t = seen.title;
  return { title: t, color: seen.color ?? (/done|closed|resolved|complete/i.test(t) ? "var(--success)" : /progress|review|doing|test/i.test(t) ? "var(--warning)" : "var(--text4)") };
}

function DiffBadge({ tab, subject }: { tab: string; subject: SideSubject }) {
  const t = useTotals(tab);
  const flash = useFlash(t ? `${t.add}/${t.del}` : subject.diffText);
  if (!t) return <Badge tone="none">{subject.diffText}</Badge>;
  if (!t.files) return <Badge tone="none">clean</Badge>;
  return (
    <span className={`inline-flex items-center gap-1 px-1 text-[10px] leading-4 tabular-nums rounded ${flash}`} style={{ background: "var(--surface-inset)" }}>
      <span style={{ color: "var(--success-ink)" }}>+{t.add}</span><span style={{ color: "var(--error-ink)" }}>−{t.del}</span>
    </span>
  );
}

const FLASH_CSS = `
@keyframes agx-sp-flash0 { from { background: color-mix(in srgb, var(--primary) 28%, transparent); } to { background: transparent; } }
@keyframes agx-sp-flash1 { from { background: color-mix(in srgb, var(--primary) 28%, transparent); } to { background: transparent; } }
.agx-sp-f0 { animation: agx-sp-flash0 1.4s ease-out; border-radius: 4px; }
.agx-sp-f1 { animation: agx-sp-flash1 1.4s ease-out; border-radius: 4px; }
@keyframes agx-sp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.agx-sp-live { animation: agx-sp-pulse 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .agx-sp-f0, .agx-sp-f1, .agx-sp-live { animation: none; } }
`;

/** A class that replays a short flash each time `value` changes after the first paint: two identical keyframes alternate, because a finished animation only restarts under a new name. */
function useFlash(value: string): string {
  const first = useRef(true);
  const [n, setN] = useState(0);
  useEffect(() => { if (first.current) { first.current = false; return; } setN((x) => x + 1); }, [value]);
  return n ? `agx-sp-f${n % 2}` : "";
}

function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const flash = useFlash(typeof children === "string" ? children : "");
  return (
    <span className={`inline-flex items-center whitespace-nowrap px-1 text-[10px] leading-4 tabular-nums rounded ${flash}`}
      style={{ background: tone === "none" ? "var(--surface-inset)" : `color-mix(in srgb, ${TONE_FILL[tone]} 16%, transparent)`, color: TONE[tone] }}>
      {children}
    </span>
  );
}

function Kbd({ children }: { children: string }) {
  return <span className="text-[10px] font-mono" style={{ color: "var(--text4)" }}>{children}</span>;
}

export interface SidePaneProps {
  tab: string;
  view: SidePaneView;
  width: number;
  /** The terminal view is on screen: nothing is mounted or listening otherwise. */
  active: boolean;
  subject: SideSubject | null;
  /** Leave for the full view of this section: the way the chips used to go. */
  onPopOut: (section: SideSection) => void;
  /** Put the cursor back in the terminal. */
  focusTerm: () => void;
  /** Type text into THIS terminal's prompt, without pressing Enter. */
  onType: (text: string) => void;
  /** Drawn over the terminal's right edge instead of beside it: the window has no room for both. */
  overlay: boolean;
  /** Not on screen (the tab has no pane open): sections stay mounted and quiet so the way back is instant. */
  hidden?: boolean;
}

export function SidePane(p: SidePaneProps) {
  const { view, subject } = p;
  const body = useRef<HTMLDivElement>(null);
  const saved = useRef<{ tab: string; key: string } | null>(null);
  const scrollKey = view.compact ? "compact" : view.section;

  /* Where each section was scrolled belongs to the tab: written as it moves, put back when it comes in.
     The content may still be a spinner then, so the put-back waits for it to grow tall enough. */
  const restoring = useRef(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    saved.current = { tab: p.tab, key: scrollKey };
    const want = scrollOf(p.tab, scrollKey);
    restoring.current = want > 0;
    el.scrollTop = want;
    if (!restoring.current) return;
    const state: { ro?: ResizeObserver; giveUp?: ReturnType<typeof setTimeout> } = {};
    function done() { restoring.current = false; state.ro?.disconnect(); clearTimeout(state.giveUp); }
    const ro = new ResizeObserver(() => {
      if (!canRestore(want, el.scrollHeight, el.clientHeight)) return;
      el.scrollTop = want;
      done();
    });
    state.ro = ro;
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    state.giveUp = setTimeout(done, 5000);
    // A hand on the content settles it: whatever the person does next is the position to keep.
    el.addEventListener("wheel", done, { once: true, passive: true });
    el.addEventListener("pointerdown", done, { once: true });
    return () => { done(); el.removeEventListener("wheel", done); el.removeEventListener("pointerdown", done); };
  }, [p.tab, scrollKey, subject?.key]);
  const onScroll = () => {
    const el = body.current;
    if (el && saved.current && !restoring.current) rememberScroll(saved.current.tab, saved.current.key, el.scrollTop);
  };

  /* Digits inside the pane pick a section; Escape hands the cursor back. Alt+digit is the window strip's own and is never taken here. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    const typing = /input|textarea|select/i.test(t.tagName) || t.isContentEditable;
    if (e.key === "Escape" && !e.defaultPrevented && !typing && !document.querySelector('[role=dialog], [role=menu], [aria-modal=true]')) {
      e.preventDefault();
      p.focusTerm();
      return;
    }
    if (typing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const s = sectionForKey(e.key);
    if (s) { e.preventDefault(); setSection(p.tab, s); }
  };

  const card = useStatus(p.tab, subject);
  const prFlash = useFlash(subject ? `${subject.prText}|${subject.reviewText}` : "");
  const options = SIDE_SECTIONS.map((s) => ({
    id: s,
    label: (
      <span className="inline-flex items-center gap-1.5">
        {s === "card" ? "Card" : s === "pr" ? "PR" : "Diff"}
        {s === "card" && card && <span className="w-1.5 h-1.5 rounded-full" data-tip={card.title} style={{ background: card.color }} />}
        {s === "pr" && <Badge tone={subject?.prTone ?? "none"}>{subject?.prText ?? "no PR"}</Badge>}
        {s === "diff" && subject && <DiffBadge tab={p.tab} subject={subject} />}
        <Kbd>{s === "card" ? "1" : s === "pr" ? "2" : "3"}</Kbd>
      </span>
    ),
    title: s === "card" ? "Card (1)" : s === "pr" ? (subject?.pr ? "Pull request (2)" : "No PR for this branch") : "Diff (3)",
    disabled: s === "pr" && !subject?.pr,
  }));

  return (
    <aside data-side-pane data-compact={view.compact ? "1" : undefined} aria-label="Card, pull request and diff"
      className="flex flex-col min-w-0 min-h-0 shrink-0 relative" onKeyDown={onKeyDown} tabIndex={-1}
      style={{ width: p.width, display: p.hidden ? "none" : undefined, background: "var(--bg)", borderLeft: LINE, outline: "none", zIndex: LAYER.paneSide }}>
      <style>{FLASH_CSS}</style>
      {/* A press on the header never moves the focus off the terminal. */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5" style={{ borderBottom: LINE, background: "var(--surface-card)" }}
        onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}>
        {view.compact
          ? <span className="font-mono text-[11px] truncate" style={{ color: "var(--text3)" }}>{subject?.card?.label ?? subject?.branch ?? ""}</span>
          : <Segmented value={view.section} options={options} onChange={(s) => setSection(p.tab, s)} label="Section" compact />}
        <span className="flex-1" />
        <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${prFlash}`} style={{ color: "var(--text3)" }}
          data-tip="Updates as the worker's card, pull request and checkout change">
          <span className="agx-sp-live w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />{view.compact ? "" : "live"}
        </span>
        <IconButton onClick={() => { togglePin(); }} on={view.pinned} bare
          title={view.pinned ? "Pinned: the pane stays open on every worker tab" : "Pin: keep the pane open on every worker tab"}>
          <PinIcon size={ICON.sm} filled={view.pinned} />
        </IconButton>
        <IconButton onClick={() => { toggleCompact(); }} bare title={view.compact ? "Expand to full" : "Compact: essentials only"}>
          <ExpandIcon size={ICON.sm} shrink={!view.compact} />
        </IconButton>
        {!view.compact && (
          <IconButton onClick={() => { toggleMaxWidth(p.tab); }} on={view.maxWidth} bare title={view.maxWidth ? "Restore width" : "Max width"}>
            <MaxWidthIcon size={ICON.sm} restore={view.maxWidth} />
          </IconButton>
        )}
        {!view.compact && view.maxWidth && (
          <IconButton onClick={() => { toggleSplit(p.tab); }} on={view.split} bare title="Split: card beside diff or PR">
            <SplitIcon size={ICON.sm} />
          </IconButton>
        )}
        <IconButton onClick={() => p.onPopOut(view.section)} bare
          title={`Pop out to the full ${view.section === "card" ? "card" : view.section === "pr" ? "pull request" : "diff"} view`}>
          <ExternalIcon size={ICON.sm} />
        </IconButton>
        <IconButton onClick={() => { closeSide(p.tab); p.focusTerm(); }} bare title="Close the pane"><CloseIcon size={ICON.sm} /></IconButton>
      </div>

      <div ref={body} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto flex flex-col">
        {!subject
          ? <Note>Reading this checkout…</Note>
          : view.maxWidth && view.split && !view.compact
          ? <Suspense fallback={<div className="p-5"><Spinner label="Opening…" className="" /></div>}>
              <SplitBody {...p} subject={subject} />
            </Suspense>
          : <>
              {view.compact && <Compact {...p} subject={subject} />}
              <Suspense fallback={view.compact ? null : <div className="p-5"><Spinner label="Opening…" className="" /></div>}>
                <PaneBody {...p} subject={subject} hidden={p.hidden || view.compact} />
              </Suspense>
            </>}
      </div>
    </aside>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>{children}</div>;
}

/* Outside the component, not a ref: a tab switch can make `subject` briefly null (its facts are being read
   again), and SidePane unmounts PaneBody for that one render — see the `!subject` branch above. A ref dies
   with it, so every section this cache ever kept, for every tab, was wiped by one tab's momentary gap. A
   module-level list survives the unmount and is there, unchanged, the next time PaneBody mounts. */
let keptSections: { id: string; subject: SideSubject; section: SideSection }[] = [];

/** Every section visited stays mounted; only the current one is shown and live. */
function PaneBody(p: SidePaneProps & { subject: SideSubject }) {
  const cur = { id: `${p.tab}:${p.subject.key}:${p.view.section}`, subject: p.subject, section: p.view.section };
  if (!p.hidden) keptSections = keepAlive(keptSections, cur);
  const shown = (id: string) => !p.hidden && id === cur.id;
  return (
    <>
      {keptSections.map((e) => (
        <div key={e.id} data-keep={shown(e.id) ? "shown" : "hidden"} className="flex flex-col flex-1 min-h-0"
          style={shown(e.id) ? undefined : { display: "none" }}>
          <KeptSection {...p} subject={e.subject} section={e.section} live={p.active && shown(e.id)} />
        </div>
      ))}
    </>
  );
}

/** Max width, split: the card on the left, a Diff/PR picker on the right — never a kept section of its own. */
function SplitBody(p: SidePaneProps & { subject: SideSubject }) {
  const right: SplitSection = effectiveSplitSection(p.view.splitSection, !!p.subject.pr);
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col overflow-auto" style={{ borderRight: LINE }}>
        <KeptSection {...p} subject={p.subject} section="card" live={p.active} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 flex items-center gap-1.5 px-3 py-2" style={{ borderBottom: LINE }}>
          <Segmented<SplitSection> value={right} label="Right section" compact onChange={(s) => setSplitSection(p.tab, s)} options={[
            { id: "diff", label: <span className="inline-flex items-center gap-1.5">Diff<DiffBadge tab={p.tab} subject={p.subject} /></span> },
            {
              id: "pr", label: <span className="inline-flex items-center gap-1.5">PR{p.subject.pr && <Badge tone={p.subject.prTone}>{p.subject.prText}</Badge>}</span>,
              disabled: !p.subject.pr, title: p.subject.pr ? undefined : "No PR for this branch",
            },
          ]} />
        </div>
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          <KeptSection {...p} subject={p.subject} section={right} live={p.active} />
        </div>
      </div>
    </div>
  );
}

function KeptSection(p: SidePaneProps & { subject: SideSubject; section: SideSection; live: boolean }) {
  const { subject: s } = p;
  const view = { ...p.view, section: p.section };
  const key = `${s.key}:${view.section}`;
  const onStatus = useCallback((t: { title: string; color: string | null }) => noteStatus(p.tab, t), [p.tab]);
  const onTotals = useCallback((t: { files: number; add: number; del: number }) => noteTotals(p.tab, t), [p.tab]);
  if (view.section === "card") {
    return s.card
      ? <>
          {s.pr && (
            <button type="button" onClick={() => setSection(p.tab, "pr")} data-tip="Open the pull request (2)"
              className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-left text-[11.5px] agx-btn"
              style={{ borderBottom: LINE, color: "var(--text2)" }}>
              <span className="font-mono whitespace-nowrap shrink-0" style={{ color: "var(--text3)" }}>PR #{s.pr.number}</span>
              <span className="shrink-0 whitespace-nowrap"><Badge tone={s.prTone}>{s.prText}</Badge></span>
              <span className="truncate min-w-0" style={{ color: "var(--text3)" }}>{s.pr.title}</span>
            </button>
          )}
          <CardEmbed key={key} active={p.live} card={s.card} here={s.root} onStatus={onStatus} />
        </>
      : <Note>No card is named by this branch. A branch that starts with the card's id gets one here.</Note>;
  }
  if (view.section === "pr") {
    if (s.pr) return <PrView key={key} active={p.live} embedded={{ repo: s.pr.repo, number: s.pr.number, root: s.root, typeInto: p.onType }} />;
    return (
      <div className="p-5 flex flex-col gap-3 items-start text-[11.5px]" style={{ color: "var(--text3)" }}>
        <span>No pull request for <b style={{ color: "var(--text2)" }}>{s.branch}</b> yet.</span>
        <Button size="compact" onClick={() => p.onType(`Open a pull request for the branch ${s.branch}.`)}
          title="Types the request into this terminal's prompt. Press Enter there to send it.">
          Ask the worker to open it
        </Button>
      </div>
    );
  }
  return <DiffPage key={key} active={p.live} embedded={{ filter: s.filter, tab: p.tab, onTotals }} />;
}

/** Essentials only: three boxes that say where the work stands, each one a way into its section. */
function Compact(p: SidePaneProps & { subject: SideSubject }) {
  const s = p.subject;
  const card = useStatus(p.tab, s);
  const go = (sec: SideSection) => { toggleCompact(); setSection(p.tab, sec); };
  const box = "text-left w-full rounded-xl px-3 py-2.5 flex flex-col gap-1";
  const style = { background: "var(--surface-card)", border: EDGE } as const;
  return (
    <div className="p-2.5 flex flex-col gap-2.5 text-[11.5px]" style={{ color: "var(--text2)" }}>
      <button type="button" className={box} style={style} onClick={() => go("card")}>
        <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase" style={{ color: "var(--text4)" }}>Card
          {card && <span className="ml-auto normal-case inline-flex items-center gap-1" style={{ color: "var(--text2)" }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: card.color }} />{card.title}</span>}
        </span>
        <span style={{ color: "var(--text)" }}>{s.card?.label ?? "No card on this branch"}</span>
      </button>
      <button type="button" className={box} style={style} onClick={() => go("pr")}>
        <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase" style={{ color: "var(--text4)" }}>
          {s.pr ? `PR #${s.pr.number}` : "Pull request"}<span className="ml-auto normal-case"><Badge tone={s.prTone}>{s.prText}</Badge></span>
        </span>
        <span style={{ color: "var(--text)" }}>{s.pr?.title ?? "None yet"}</span>
        {s.reviewText && <span style={{ color: "var(--text3)" }}>{s.reviewText}</span>}
      </button>
      <button type="button" className={box} style={style} onClick={() => go("diff")}>
        <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase" style={{ color: "var(--text4)" }}>Diff
          <span className="ml-auto normal-case"><DiffBadge tab={p.tab} subject={s} /></span></span>
        <span style={{ color: "var(--text3)" }}>{s.branch}</span>
      </button>
      <Button size="compact" onClick={() => { toggleCompact(); }} className="self-stretch justify-center"><IconLabel icon={<ExpandIcon size={ICON.xs} />}>Expand to full</IconLabel></Button>
    </div>
  );
}

/**
 * The seam between the terminal and the pane. Dragging sets the width, a double
 * click puts it back. `rowLeft` is the row's left edge, which the caller measures.
 */
export function SideDivider({ onWidth, onReset, rowLeft }: {
  onWidth: (pointerX: number) => void;
  onReset: () => void;
  rowLeft: () => number;
}) {
  const [drag, setDrag] = useState(false);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDrag(true);
    const move = (ev: PointerEvent) => onWidth(ev.clientX - rowLeft());
    const up = () => {
      setDrag(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div role="separator" aria-orientation="vertical" tabIndex={-1} aria-label="Drag to resize the pane, double-click to reset"
      data-tip="Drag to resize · double-click to reset"
      onPointerDown={down} onDoubleClick={onReset}
      className="shrink-0 self-stretch" style={{ width: DIVIDER_PX, cursor: "col-resize", background: drag ? "var(--primary)" : "var(--surface-line)", touchAction: "none" }} />
  );
}
