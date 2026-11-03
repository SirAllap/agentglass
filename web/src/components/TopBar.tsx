// The app's one top strip.
//
// It replaces two things that used to be stacked: the 60px dashboard header
// (nine window buttons, three facet selects, six icon buttons) and the 48px
// band the notch hung in. The window buttons went into the dashboard, where
// they are the only place they mean anything; what is left is the ambient
// state, and that fits on one line.
//
// 30px, not 44. The notch spent that extra height on captions STACKED above
// their numbers — "VIVOS" over "4" — which is two rows to say one thing. Inline
// captions read the same and cost nothing: `● 4 vivos` is as legible as the
// stack and half as tall. The rest of the saving is the second bar not existing.
//
// It sits on --bg2 with a hairline, like every other toolbar in this app,
// rather than on the near-black the notch needed to read as "carved out of the
// screen". That is what makes it belong to the theme instead of floating over it.
import type { SystemNote } from "../lib/sysNotify.ts";
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import { subscribeProviderUsage, usageOf, busiestOf, providerUsage, usageLoaded, heldRows, resetShort, ageLabel, refreshProviderUsage } from "../lib/usageStore.ts";
import { providerInContext } from "../lib/providerContext.ts";
import { windowLabel } from "../../../shared/quota.ts";
import { stalenessLabel } from "../lib/usageAge.ts";
import { heldAgeLabel, stripRow } from "../lib/usageHold.ts";
import { dayCells, lastWeek, subscribeDayStrip, warmDayStrip } from "../lib/dayStrip.ts";
import { fmtTokens } from "../lib/format.ts";
import { NO_DRAG } from "../lib/dragRegion.ts";
import { DayStrip, PaceMarker } from "./PlanPace.tsx";
import { metersMustHide } from "../lib/topbarFit.ts";
import { subscribeSessions, liveSessionCount } from "./TerminalPanel.tsx";
import { clock24, subscribeClock24 } from "../lib/clockPref.ts";
import { updateAvailable, subscribeUpdate, updateState } from "../lib/updateStore.ts";
import { IS_MAC_DESKTOP, WINDOW_CONTROLS } from "../lib/desktop.ts";
import { CleanupChip } from "./CleanupChip.tsx";
import { LivingMark } from "./Logo.tsx";
import { useAmbientNotes, NoteToast, NotifyBell } from "./TopBarNotes.tsx";
import { NeedsPopover, type NeedsItem } from "./NeedsPopover.tsx";
import { openFlightPlan } from "../lib/flightPlanNav.ts";
import { chipGoesToPlan, needsStaysOpen } from "../lib/needsPanel.ts";
import { HIT, ICON, MIN_BOX } from "../lib/iconSize.ts";
import { USAGE_KEY_GUIDE } from "../lib/usageKeyGuide.ts";
import { openCodePanelWindows, CONSOLE_REREAD_MS } from "../../../shared/opencodePanel.ts";
import { LAYER } from "../lib/layers.ts";
import { AccountChips, AccountKeyBar, useAccountPanel } from "./AccountChips.tsx";
import { isCoreRow } from "../lib/accountStore.ts";
import { chipView, tabBadge, worstWindow } from "../lib/usageChips.ts";
import { bankTip, BANK_CELL_PX, foldCells, groupWindows, paceBudget, paceVerdict, resetWhen, runsOut, sheetTail } from "../lib/usageBank.ts";
import { OLD_READING_MS } from "../lib/usagePace.ts";
import { rowsInBar } from "../lib/usageBarPref.ts";
import { ProviderMark } from "./ProviderMark.tsx";
import { logoOf } from "./engines/enginesCopy.ts";
import { accountStageOf, peekStage, subscribeStage } from "../lib/stageIntent.ts";
import { onProposal, stagedProvider } from "../lib/accountKeys.ts";
import { GearIcon } from "./workspace/icons.tsx";
import { openSettings } from "../lib/openSettings.ts";
import { appChordFor, chordLabel } from "../lib/keybindings.ts";
import { ExpandIcon, FolderIcon, SearchIcon } from "../lib/glyphIcons.tsx";
import { scopeAria, scopeLabel, scopeTitle } from "../lib/projectPick.ts";
import { RefreshButton, EDGE, LINE } from "./workspace/Chrome.tsx";

export const TOP_BAR_H = 30;


/** The seven-day window's label, asked of the same function that made it rather
 *  than spelled out here, so the two cannot drift apart. */
const WEEKLY = windowLabel(10080);

/**
 * Minimise, maximise, close — drawn by the app because the window is frameless.
 *
 * Deliberately in this app's own language rather than an imitation of the
 * platform's: hairline glyphs on transparent, the same hover wash every icon
 * button here uses, and close going red only under the cursor. A convincing
 * copy of a GTK or Windows control sitting on our own bar would land in the
 * uncanny valley from both directions; something that plainly belongs to this
 * app does not have to compete.
 *
 * Renders nothing at all where the shell still has a system title bar (macOS
 * keeps its traffic lights) or where there is no window to control (a browser
 * tab). Three buttons that do nothing would be worse than the frame we removed.
 */
function WindowControls({ max }: { max: boolean }) {
  if (!WINDOW_CONTROLS || IS_MAC_DESKTOP) return null;

  /*
   * A window button must not keep the keyboard.
   *
   * Chromium focuses a <button> when it is clicked, and a focused button is
   * activated again by Enter or Space — so pressing the maximise button once
   * arms every later Enter to un-maximise the window, from wherever the person
   * happens to be typing. Reported three times as a window that "se minimiza
   * sola", twice while pasting and once with no paste at all, and the log
   * agreed each time: `asked=yes` — this app asked for it, through this button,
   * with no pointer involved.
   *
   * Blurring after the action costs nothing: the control is a title-bar
   * affordance you point at, and Tab still reaches it for anyone who navigates
   * that way. Close is the one that matters most — the same stale focus on it
   * would quit the app on an Enter meant for a prompt.
   *
   * `why` rides along to the window log so the next occurrence, if there is
   * one, names its own cause: a real click, a keyboard activation, or a click
   * nobody made.
   */
  const how = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = document.activeElement as HTMLElement | null;
    const focus = el ? `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}` : "none";
    return `detail=${e.detail} trusted=${e.isTrusted} focus=${focus}`;
  };
  const run = (fn: (why: string) => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const why = how(e);
    e.currentTarget.blur();
    fn(why);
  };

  const btn = "grid place-items-center rounded transition-colors";
  const box = { width: 26, height: 20, color: "var(--text3)", ...NO_DRAG } as React.CSSProperties;
  return (
    <span className="flex items-center gap-0.5 shrink-0 ml-1 -mr-1.5">
      <button onClick={run(() => WINDOW_CONTROLS!.minimize())} aria-label="Minimise" title="Minimise"
        className={`${btn} hover:bg-white/10 hover:text-[var(--text)]`} style={box}>
        <svg viewBox="0 0 12 12" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={1.1}><path d="M2.5 6h7" /></svg>
      </button>
      <button onClick={run((why) => WINDOW_CONTROLS!.toggleMaximize(why))} aria-label={max ? "Restore" : "Maximise"} title={max ? "Restore" : "Maximise"}
        className={`${btn} hover:bg-white/10 hover:text-[var(--text)]`} style={box}>
        {max ? (
          // Two offset squares: the window comes back OUT of full width, which
          // one square cannot say.
          <svg viewBox="0 0 12 12" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={1.1}>
            <rect x="2" y="4" width="6" height="6" rx="1" /><path d="M4.4 4V3a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1H8" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={1.1}>
            <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
          </svg>
        )}
      </button>
      <button onClick={run(() => WINDOW_CONTROLS!.close())} aria-label="Close" title="Close"
        className={`${btn} hover:text-white`} style={box}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--error)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
        <svg viewBox="0 0 12 12" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={1.1}><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </span>
  );
}

/** The clock, re-read every minute and on coming back to a visible tab. A
 *  second's resolution is pointless at this size, and it stops while hidden
 *  because nobody reads a clock they cannot see. */
function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const ms = 60_000 - (Date.now() % 60_000);
      id = setTimeout(() => { if (!document.hidden) setNow(new Date()); schedule(); }, ms + 20);
    };
    schedule();
    const onVis = () => { if (!document.hidden) setNow(new Date()); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return now;
}

/** The window's own clock. */
function useMinuteClock(): string {
  const h24 = useSyncExternalStore(subscribeClock24, clock24, () => true);
  const now = useMinuteNow();
  const h = now.getHours();
  const hh = h24 ? String(h).padStart(2, "0") : String(h % 12 || 12);
  /*
   * THE DATE, ahead of the time, the way the desktop's own clock writes it.
   *
   * This strip IS the title bar — the window is frameless, so in fullscreen it
   * is the only clock on screen and the system tray is not there to answer
   * "what day is it". A bare `13:05` was the whole of what it said.
   *
   * `Intl` with no locale of its own, so it follows the machine: on his it
   * reads `ago 24`, on an English one `Aug 24`, and neither is a string this
   * file has to know. Month-then-day for the same reason — the order comes
   * from the locale rather than from a guess, which is how 01/02 ends up
   * meaning two different days to two different readers.
   */
  const day = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} ${hh}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * The "⋯" that opens the app menu.
 *
 * There is no menu bar in this app and there is deliberately not going to be
 * one: it embeds a real terminal where Alt is part of ordinary use, and an
 * auto-hiding bar kept dropping over the UI mid-keystroke. Removing the frame
 * then took away the last visible trace of a menu, along with the only obvious
 * route to reload, zoom, devtools and quit — so it comes back here, as a
 * button, popped by the main process under this exact spot and gone the moment
 * you look away.
 */
function AppMenuButton() {
  const ref = useRef<HTMLButtonElement>(null);
  if (!WINDOW_CONTROLS?.menu) return null;
  return (
    <button ref={ref} aria-label="Menu" title="Menu"
      onClick={() => {
        const r = ref.current?.getBoundingClientRect();
        // Under the button, flush with its left edge — a menu that opens where
        // the pointer happened to be does not read as belonging to the control
        // you pressed.
        WINDOW_CONTROLS!.menu!(r ? r.left : 8, r ? r.bottom : TOP_BAR_H);
      }}
      className="shrink-0 grid place-items-center rounded hover:bg-white/10"
      style={{ width: 20, height: 18, color: "var(--text3)", ...NO_DRAG }}>
      <svg viewBox="0 0 16 16" width={ICON.sm} height={ICON.sm} fill="currentColor" aria-hidden>
        <circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" />
      </svg>
    </button>
  );
}

/**
 * Maximised, and fullscreen.
 *
 * Both are pushed from the main process rather than polled: a window manager
 * maximises on a drag to the edge and F11 goes fullscreen without either passing
 * through us, and a bar that guesses shows the wrong glyph and hides the clock
 * at the wrong moment.
 */
function useWindowState(): { max: boolean; full: boolean } {
  const [st, setSt] = useState({ max: false, full: false });
  useEffect(() => {
    if (!WINDOW_CONTROLS) return;
    void WINDOW_CONTROLS.state().then(setSt).catch(() => {});
    return WINDOW_CONTROLS.subscribe(setSt);
  }, []);
  return st;
}

/** Commits moving one way or the other. Direction by shape, so the two readings
 *  are told apart without reading their captions. */
function Arrow({ up }: { up?: boolean }) {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ color: up ? "var(--success)" : "var(--info)" }}>
      {up ? <><path d="M12 20V9M6 13l6-6 6 6" /><path d="M4.5 4h15" /></>
        : <><path d="M12 4v11M6 11l6 6 6-6" /><path d="M4.5 20h15" /></>}
    </svg>
  );
}

/**
 * The console's week against the one this PC counted.
 *
 * The only sentence on screen that says the local number under-reads — another
 * machine can spend the same plan — so it sits beside the number it qualifies.
 * The console is the authority, but reading it needs the person's login, so it
 * happens behind this button and never on a timer.
 */
function ConsoleCalibration({ u }: { u: ProviderUsage }) {
  const [cue, setCue] = useState<QuotaWindow[] | null>(u.calibration?.windows ?? null);
  const [busy, setBusy] = useState(false);
  const week = (ws: QuotaWindow[] | null) => ws?.find((w) => w.minutes === 10080)?.usedPercent ?? null;
  const consoleWeek = week(cue);
  const localWeek = week(u.windows);
  const read = () => {
    setBusy(true);
    api.refreshOpenCodeUsage(true)
      .then((row) => { if (row.available) setCue(row.windows); })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  // Wraps rather than shares one line: at the sheet's width the sentence and
  // the button do not both fit.
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
      {consoleWeek !== null && localWeek !== null && (
        <span>Console says the week is {consoleWeek}% used; this PC counted {localWeek}%.</span>
      )}
      <button type="button" onClick={read} disabled={busy}
        className="shrink-0 text-[10px] hover:underline disabled:opacity-50" style={{ color: "var(--text3)" }}>
        {busy ? "Reading…" : "Read the console"}
      </button>
    </div>
  );
}

/**
 * OpenCode Go's own detail: per-model spend, the fold its per-model weekly has
 * no window for. The days live in the sheet's one chart, as every agent's do.
 */
function OpenCodeLocal({ u }: { u: ProviderUsage }) {
  const [open, setOpen] = useState(u.windows.length === 0);
  const [detail, setDetail] = useState<{ model: string; steps: number; costUsd: number }[] | null>(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    if (!open || detail) return;
    let live = true;
    api.openCodeDetail()
      .then((r) => { if (live) setDetail(r.detail?.models ?? []); })
      .catch(() => { if (live) setDetail([]); });
    return () => { live = false; };
  }, [open, detail]);
  const view = openCodePanelWindows(u, now);
  return (
    <div className="flex flex-col gap-2" style={{ borderTop: LINE, paddingTop: 10 }}>
      {u.usageNote && (
        <span className="text-[10px] leading-snug" style={{ color: "var(--warning)" }}>{u.usageNote}</span>
      )}
      {!u.usageKey && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] leading-snug" style={{ color: "var(--text4)" }}>{USAGE_KEY_GUIDE}</span>
          <button type="button" onClick={() => openSettings("engines")}
            className="self-start text-[10px] hover:underline" style={{ color: "var(--primary)" }}>
            Set the key in Settings › Agent engines
          </button>
        </div>
      )}
      {view.estimate && u.source && <span className="self-start chip text-[9.5px] t-dim" title={`These numbers cover this PC, not the whole plan: the console counted more on 31 Oct`}>{u.source}</span>}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="self-start text-[10px] hover:underline" style={{ color: "var(--text3)" }}>
        {open ? "▾" : "▸"} Per-model spend · last 30 days
      </button>
      {open && detail === null && <span className="text-[10px]" style={{ color: "var(--text4)" }}>Reading the local stats…</span>}
      {open && detail?.length === 0 && <span className="text-[10px]" style={{ color: "var(--text4)" }}>The local stats reported no models.</span>}
      {open && detail?.map((m) => (
        <div key={m.model} className="flex items-baseline gap-2 text-[10px]">
          <span className="truncate" style={{ color: "var(--text2)" }}>{m.model}</span>
          <span className="ml-auto tabular-nums" style={{ color: "var(--text3)" }}>${m.costUsd.toFixed(2)}</span>
          <span className="tabular-nums" style={{ color: "var(--text4)" }}>{m.steps} steps</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The panel behind the chip: every window, spelled out.
 *
 * The strip answers "how much" in one line and cannot answer anything else —
 * which window is which, when each one actually comes back, whether the reading
 * is current. Those are the questions you have exactly once, at the moment you
 * are deciding whether to keep going, and they were unanswerable without
 * opening Stats.
 *
 * A bar per window, full width, because here there IS room and a row of three
 * short bars is a chart. `resetLabel` rather than the strip's compact form:
 * with the space for it, "Wed 3:00 PM" is more use than "2d 1h" when you are
 * deciding whether to wait.
 */
/** A tab is a bank cell, so it carries the short name the cell would. */
const TAB_LABEL: Record<ProviderUsage["provider"], string> = {
  anthropic: "Claude", opencode: "OpenCode", codex: "Codex", antigravity: "Antigravity",
};

/** Ink escalates only when it matters: a plan at 4% is not a green badge. */
const bankInk = (p: number): string =>
  p >= 85 ? "var(--error-ink)" : p >= 60 ? "var(--warning-ink)" : "var(--text)";

/** The same rule for a fill: quiet ink until the plan is actually close. */
const bankFill = (p: number): string =>
  p >= 85 ? "var(--error)" : p >= 60 ? "var(--warning)" : "var(--text3)";

/** The marks are the engines' own colours, shared across themes. Asked of the
 *  one table the Settings tiles use, so a new engine is added in one place. */
const MARK_INK: Record<ProviderUsage["provider"], string> = {
  anthropic: logoOf("claude"), opencode: logoOf("opencode"), codex: logoOf("codex"), antigravity: logoOf("antigravity"),
};

function PlanPanel({ u: strip, age: stripAge, tabs, at, onClose, onEscape, onRefresh, busy }: {
  u: ProviderUsage; age: string | null; tabs: { row: ProviderUsage; age: string | null }[];
  at: { top: number; right: number; staged?: true };
  onClose: () => void; onEscape: (provider: ProviderUsage["provider"]) => void; onRefresh: () => void; busy: boolean;
}) {
  // The sheet's provider is its own state: opening it from a cell says where to
  // start, and the tabs are how you move without closing it.
  const [tabId, setTabId] = useState<ProviderUsage["provider"]>(strip.provider);
  const tab = tabs.find((t) => t.row.provider === tabId) ?? { row: strip, age: stripAge };
  // The tab whose row is actually drawn. `tabId` can name a provider that has
  // left the bar (its switch turned off, or a reading that was not held): the
  // selected tab, the panel's label and Escape must follow the row on screen,
  // not the id nothing draws.
  const activeId = tab.row.provider;
  const tabEls = useRef(new Map<ProviderUsage["provider"], HTMLButtonElement>());
  // A list of open folds, so the one control below can open every row at once.
  // `null` is "nothing chosen yet": the tightest fold is open until the person
  // says otherwise, and an empty list is every row shut.
  const [fold, setFold] = useState<string[] | null>(null);
  const pick = (provider: ProviderUsage["provider"], focus = true) => {
    setTabId(provider);
    setFold(null);
    if (focus) tabEls.current.get(provider)?.focus({ preventScroll: true });
  };
  const tabIds = tabs.map((t) => t.row.provider);
  // Where the focus is decides what ←→ means, so the footer legend asks this:
  // focus lands on a tab on open (not on an agent's staged open, which leaves
  // the person's typing alone).
  const [inTabs, setInTabs] = useState(!at.staged);
  // ↑↓ is the same axis as the tabs: moving it moves the tab, so the headline,
  // the aria-label and the chips cannot belong to another provider than the
  // selected one.
  const acc = useAccountPanel(tab.row, onClose, () => onEscape(activeId), !at.staged, { providers: tabIds, onPick: pick }, inTabs);
  const u = acc.header;
  const other = acc.show && !acc.atCore;
  const shown = other ? acc.row : u;
  // An age belongs to the row the sheet was handed; another login of it has
  // its own reading, and warning ink beside it would date the wrong account.
  const age = other ? null : tab.age;
  // One timer, no fetching: the sheet's own clock, so a window whose reset
  // passes while the sheet is open stops promising "resets in 1m" forever.
  const now = useMinuteNow().getTime();
  const view = shown ? openCodePanelWindows(shown, now) : null;
  const windows = [...(view?.windows ?? [])].sort((a, b) => a.minutes - b.minutes);
  const estimate = view?.estimate ?? false;
  const estimatedMinutes = new Set(view?.estimatedMinutes ?? (estimate ? windows.map((w) => w.minutes) : []));
  const observedAt = !estimate && shown?.calibration ? shown.calibration.at : shown?.observedAt;
  const worst = shown?.available ? worstWindow({ ...shown, windows }) : null;
  // A local estimate is this PC's arithmetic, not the plan's number: the
  // headline says so beside the figure rather than only inside the open fold.
  const worstEstimated = !!worst && estimatedMinutes.has(worst.minutes);
  // Past this the number is history: today's clock on a days-old percent would
  // project a rate the plan may have left behind days ago.
  const staleReading = !estimate && observedAt != null && now - observedAt > OLD_READING_MS;
  const groups = groupWindows(windows);
  const tightest = groups.find((g) => g.windows.some((w) => w.usedPercent === worst?.usedPercent))?.key ?? groups[0]?.key ?? null;
  const budget = worst ? paceBudget(worst, now) : null;
  // The age belongs next to the sentence it qualifies: a weeks-old Codex
  // reading looks exactly like a fresh one otherwise. `ageLabel` already says
  // "5m ago", so the line adds only the word in front of it.
  const readAge = observedAt ? ageLabel(observedAt) : null;
  const readLine = age ? `last read ${age} ago` : readAge ? `read ${readAge}` : "no reading";
  // Empty list is "every fold shut", so a person who closes the tightest one
  // is not overruled on the next render.
  const openKeys = fold ?? (tightest ? [tightest] : []);
  const toggleFold = (key: string) =>
    setFold(openKeys.includes(key) ? openKeys.filter((k) => k !== key) : [...openKeys, key]);
  // Every row the body can draw, so the control's label follows the rows
  // whether they were opened by hand or by the control itself.
  const foldKeys = [...groups.map((g) => g.key), ...(shown?.available ? ["days"] : [])];
  const allOpen = foldKeys.length > 0 && foldKeys.every((k) => openKeys.includes(k));
  // Subscribed, not read once: the week arrives after the first paint, and a
  // total computed from `null` used to stay blank for the life of the sheet.
  const week = useSyncExternalStore(subscribeDayStrip, lastWeek, lastWeek);
  const weekTotal = week ? dayCells(week, now).reduce((n, c) => n + c.tokens, 0) : null;
  // Opening the sheet, and every tab moved to, is the one read the console gets
  // besides the refresh button: no polling, and only when a key is stored. The
  // local number is already on screen; this is what makes the console line
  // current — unless it already is, so a held arrow walking in and out of the
  // tab cannot re-post the read at the keyboard's repeat rate.
  useEffect(() => {
    if (activeId !== "opencode" || !(tab.row.usageKey ?? shown?.usageKey)) return;
    if (shown?.calibration && now - shown.calibration.at < CONSOLE_REREAD_MS) return;
    void api.refreshOpenCodeUsage().then(() => refreshProviderUsage()).catch(() => {});
  }, [activeId]);

  // The tabs are the way round this sheet and the keyboard should land on them,
  // not on the dialog root, or the arrows the legend promises do nothing. Not
  // when an agent's proposal opened it: the person may be typing elsewhere.
  useEffect(() => { if (!at.staged) tabEls.current.get(activeId)?.focus({ preventScroll: true }); }, []);

  return (
    <Portal z={LAYER.usage}>
      {/* The scrim is what closes it. A panel this small does not deserve a
          key handler of its own and a click anywhere else is what everybody
          already tries. Closed like Escape, so focus goes back to the strip. */}
      <div className="fixed inset-0" onClick={() => onEscape(activeId)} style={{ background: "transparent" }} />
      <div {...acc.rootProps} className="fixed flex flex-col rounded-xl overflow-hidden outline-none"
        style={{
          top: at.top, right: at.right, width: 378, maxHeight: 610,
          background: "var(--surface-card)",
          border: EDGE,
          boxShadow: "0 22px 48px -20px var(--shadow)",
        }}>
        {/* The providers as tabs, each a mini bank. The place that names them is
            also the place that switches them. */}
        <div role="tablist" aria-label="Providers" className="flex gap-0.5 px-2 pt-2 pb-1.5"
          style={{ borderBottom: LINE }}
          onFocus={() => setInTabs(true)}
          onBlur={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setInTabs(false); }}
          onKeyDown={(ev) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(ev.key)) return;
            const ids = tabs.map((t) => t.row.provider);
            // The dialog root maps the arrows to the account candidate: a key
            // pressed on a tab must move the tab and nothing else, so the row
            // swallows it even when there is only one tab to move between.
            ev.preventDefault();
            ev.stopPropagation();
            if (ids.length < 2) return;
            const i = ids.indexOf(activeId);
            const next = ev.key === "Home" ? ids[0]!
              : ev.key === "End" ? ids[ids.length - 1]!
                : ids[(i + (ev.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]!;
            pick(next);
          }}>
          {tabs.map(({ row }) => {
            // The sheet's own clock: a badge recomputed from the wall clock
            // flipped to the local estimate while the body under it still drew
            // the console's windows.
            const v = chipView(row, now);
            const badge = tabBadge(v);
            const on = row.provider === activeId;
            return (
              <button key={row.provider} role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
                id={`bank-tab-${row.provider}`} aria-controls="bank-sheet-body"
                ref={(el) => { if (el) tabEls.current.set(row.provider, el); else tabEls.current.delete(row.provider); }}
                onClick={() => pick(row.provider)}
                className="flex-1 min-w-0 flex flex-col justify-center gap-1 rounded-md"
                style={{
                  height: 30, padding: "2px 4px",
                  border: on ? EDGE : undefined,
                  background: on ? "var(--bg)" : "none",
                  boxShadow: on ? "0 1px 2px rgba(0,0,0,.05)" : undefined,
                }}>
                <span className="flex items-center gap-0.5 min-w-0">
                  <span className="flex shrink-0" style={{ color: MARK_INK[row.provider] }}>
                    <ProviderMark provider={row.provider} size={ICON.xs} />
                  </span>
                  <span className="text-[9.5px] truncate" style={{ color: on ? "var(--text)" : "var(--text3)", fontWeight: on ? 600 : 400 }}>
                    {TAB_LABEL[row.provider]}
                  </span>
                  <b className="ml-auto text-[9.5px] font-semibold tabular-nums shrink-0"
                    style={{ color: badge.percent === null ? (v.kind === "spend" ? "var(--text2)" : "var(--text4)") : bankInk(badge.percent) }}>{badge.text}</b>
                </span>
                {/* A spend-only provider has dollars and no track, like its cell
                    on the bar: a dash over an empty track beside a headline of
                    "$7.07" says "no reading" about a provider that has one. */}
                {badge.track && (
                  <span aria-hidden className="block rounded-sm overflow-hidden"
                    style={{ height: 3, background: "color-mix(in srgb, var(--text) 16%, transparent)" }}>
                    {badge.percent !== null && <span className="block h-full rounded-sm" style={{ width: `${Math.max(0, Math.min(100, badge.percent))}%`, background: bankFill(badge.percent) }} />}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* The sentence the bar cannot say: what the number belongs to, when it
            comes back, and what the budget says it should be by now. The tabs
            above already name the provider, so this line does not repeat it. */}
        <div className="px-3 py-2.5" style={{ borderBottom: LINE }}>
          {shown?.available && worst ? (
            <div className="text-[11.5px] leading-snug" style={{ color: "var(--text2)" }}>
              <b className="font-sans text-[22px] font-semibold tabular-nums mr-0.5 align-[-2px]"
                style={{ color: bankInk(worst.usedPercent) }}>{worst.usedPercent}%</b>
              <span style={{ color: "var(--text2)" }}>{sheetTail(worst, now)}</span>
            </div>
          ) : shown?.available && shown.spend ? (
            /* A spend total is a reading with no window: the dollars are the
               headline, and "not reporting quota" here would contradict the
               cell on the bar that is showing them. */
            <div className="text-[11.5px] leading-snug" style={{ color: "var(--text2)" }}>
              <b className="font-sans text-[22px] font-semibold tabular-nums mr-0.5 align-[-2px]"
                style={{ color: "var(--text2)" }}>${shown.spend.usd.toFixed(2)}</b>
              <span> spent over {shown.spend.window}{shown.source ? `, from ${shown.source}` : ""}</span>
            </div>
          ) : (
            <div className="text-[11.5px] leading-snug" style={{ color: "var(--text)" }}>
              <b className="font-sans text-[22px] font-semibold tabular-nums mr-0.5 align-[-2px]"
                style={{ color: "var(--text4)" }}>—</b>
              {" "}{shown?.label ?? u.label} is not reporting quota.
            </div>
          )}
          {activeId === "opencode" && !other && shown && <ConsoleCalibration u={shown} />}
          <div className="flex items-center gap-2 mt-1.5 text-[9.5px]" style={{ color: "var(--text4)" }}>
            {/* Beside every number in this sheet, not only the one inside the
                open fold: an estimate printed as a plan reading is the lie the
                12-hour console rule exists to avoid. */}
            {worstEstimated && <span>estimate · this PC</span>}
            {shown?.available && worst && (
              <span>pace budget <b style={{ color: "var(--text3)" }}>{budget === null ? "—" : `${budget}%`}</b></span>
            )}
            <span className={shown?.available && worst ? "ml-auto" : ""}
              style={{ color: age ? "var(--warning)" : "var(--text4)" }}>{readLine}</span>
            {/* One control for the whole list below, read against the rows
                themselves so opening them by hand turns it into Collapse all. */}
            {foldKeys.length > 0 && (
              <button type="button" onClick={() => setFold(allOpen ? [] : foldKeys)}
                aria-label={allOpen ? "Collapse all" : "Expand all"} title={allOpen ? "Collapse all" : "Expand all"}
                aria-pressed={allOpen}
                className="shrink-0 grid place-items-center rounded hover:bg-white/10"
                style={{ width: HIT, height: HIT, color: "var(--text3)" }}>
                <ExpandIcon size={ICON.xs} shrink={allOpen} />
              </button>
            )}
            <button type="button" onClick={() => { onClose(); openSettings("budgets"); }} aria-label="Usage settings…" title="Usage settings…"
                  className="shrink-0 grid place-items-center rounded hover:bg-white/10"
                  style={{ width: MIN_BOX, height: MIN_BOX, color: "var(--text3)" }}><GearIcon size={ICON.xs} /></button>
            <RefreshButton onRefresh={onRefresh} busy={busy} title="Read the plan again" />
          </div>
        </div>

        <AccountChips p={acc} />

        <div id="bank-sheet-body" role="tabpanel" aria-labelledby={`bank-tab-${activeId}`}
          className="flex flex-col px-3 py-2 overflow-auto" style={{ maxHeight: 420 }}>
          {shown?.available && groups.map((g) => {
            const open = openKeys.includes(g.key);
            const top = Math.max(...g.windows.map((w) => w.usedPercent));
            // The number beside the reset is the group maximum, so the reset
            // must be that same window's: the first window put one model's
            // clock against another model's percent.
            const tightestWindow = g.windows.find((w) => w.usedPercent === top)!;
            return (
              <div key={g.key} className="relative" style={{
                borderLeft: LINE,
                boxShadow: open ? "inset 1px 0 0 color-mix(in srgb, var(--primary) 55%, transparent)" : undefined,
                marginLeft: 2, paddingLeft: 8,
              }}>
                <button type="button" aria-expanded={open}
                  onClick={() => toggleFold(g.key)}
                  className="w-full flex items-center gap-2 py-1.5 pr-0.5 text-left"
                  style={{ paddingLeft: 2 }}>
                  <span aria-hidden className="text-[10px] shrink-0 transition-transform"
                    style={{ color: "var(--text4)", transform: open ? "rotate(90deg)" : undefined }}>›</span>
                  <span className="text-[11.5px]" style={{ color: "var(--text)" }}>{g.title}</span>
                  {g.windows.length > 1 && <span className="text-[9px]" style={{ color: "var(--text4)" }}>{g.windows.length} models</span>}
                  <span className="ml-auto flex items-baseline gap-1.5 shrink-0">
                    <b className="text-[11px] font-semibold tabular-nums" style={{ color: bankInk(top) }}>{top}%</b>
                    <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text4)", minWidth: "3.6em", textAlign: "right" }}>
                      {resetShort(tightestWindow.resetsAt)}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="pb-2.5">
                    {g.windows.map((w) => {
                      const budget = paceBudget(w, now);
                      // A days-old reading gets neither: both are today's clock
                      // judging a rate the plan may have left days ago, and the
                      // meta line beside them already says how old the number is.
                      const estimated = estimatedMinutes.has(w.minutes);
                      const verdict = budget === null || staleReading ? null : paceVerdict(w.usedPercent, budget);
                      const reset = resetWhen(w, now);
                      // A local estimate is this PC's arithmetic, not the plan's,
                      // so it gets no projection either: the tag under the row
                      // already says which number this is.
                      const pace = staleReading || estimated ? null : runsOut(w, budget, now);
                      return (
                        <div key={`${g.key}-${w.label}`} className="mb-2 last:mb-0">
                          {g.windows.length > 1 && (
                            <div className="flex items-baseline gap-1.5">
                              <span className="text-[10.5px]" style={{ color: "var(--text2)" }}>{w.label}</span>
                              <span className="ml-auto text-[11px] font-semibold tabular-nums" style={{ color: bankInk(w.usedPercent) }}>{w.usedPercent}%</span>
                            </div>
                          )}
                          <span className="block relative rounded-sm mt-1.5" style={{
                            height: 4, background: "color-mix(in srgb, var(--text) 13%, transparent)",
                          }}>
                            <span className="block h-full rounded-sm" style={{
                              width: `${Math.max(0, Math.min(100, w.usedPercent))}%`,
                              background: bankFill(w.usedPercent),
                            }} />
                            {budget !== null && <PaceMarker expected={budget} />}
                          </span>
                          {verdict && (
                            <div className="text-[9.5px] mt-1 leading-snug" style={{ color: "var(--text4)" }}>
                              Budget <b style={{ color: "var(--text3)" }}>{budget}%</b> earned by now —{" "}
                              {/* An estimate is this PC's arithmetic: it keeps the words
                                  but never the measured pace's green or amber ink. */}
                              <b style={{ color: estimated ? "var(--text3)" : verdict.tone === "over" ? "var(--warning-ink)" : verdict.tone === "under" ? "var(--success-ink)" : "var(--text3)" }}>
                                {verdict.text}{estimated ? " (estimate)" : ""}
                              </b>.
                            </div>
                          )}
                          {reset && <div className="text-[9.5px] leading-snug" style={{ color: "var(--text4)" }}>Resets {reset}</div>}
                          {pace && <div className="text-[9.5px] leading-snug" style={{ color: "var(--text4)" }}>{pace}</div>}
                          {estimatedMinutes.has(w.minutes) && (
                            <div className="text-[9.5px] leading-snug" style={{ color: "var(--text4)" }}>estimate · this PC</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {shown?.available && (
            <div className="relative" style={{
              borderLeft: LINE,
              marginLeft: 2, paddingLeft: 8,
            }}>
              <button type="button" aria-expanded={openKeys.includes("days")}
                onClick={() => toggleFold("days")}
                className="w-full flex items-center gap-2 py-1.5 pr-0.5 text-left" style={{ paddingLeft: 2 }}>
                <span aria-hidden className="text-[10px] shrink-0 transition-transform"
                  style={{ color: "var(--text4)", transform: openKeys.includes("days") ? "rotate(90deg)" : undefined }}>›</span>
                <span className="text-[11.5px]" style={{ color: "var(--text)" }}>Last 7 days</span>
                <span className="text-[9px]" style={{ color: "var(--text4)" }}>all agents</span>
                <span className="ml-auto text-[10.5px] font-semibold tabular-nums shrink-0" style={{ color: "var(--text2)" }}>
                  {weekTotal === null ? "" : fmtTokens(weekTotal)}
                </span>
              </button>
              {openKeys.includes("days") && <div className="pb-2.5"><DayStrip provider="anthropic" all /></div>}
            </div>
          )}
          {!windows.length && (
            <span className="text-[11.5px] leading-snug py-1" style={{ color: "var(--text4)" }}>
              {other ? "No reading yet for this account."
                : shown?.available && shown.spend
                  ? `$${shown.spend.usd.toFixed(2)} spent over ${shown.spend.window}${shown.source ? `, from ${shown.source}` : ""}. No quota windows were reported.`
                : shown?.available ? "This provider reports no windows."
                /* The cell can only say "no reading" in a tooltip; the sentence
                   that says why — signed out, page changed — belongs here. */
                : shown?.note ?? "No reading from this provider right now."}
            </span>
          )}
          {!windows.length && shown?.provider === "opencode" && !shown.usageKey && (
            <div className="flex flex-col gap-1.5 py-1">
              <span className="text-[10px] leading-snug" style={{ color: "var(--text4)" }}>{USAGE_KEY_GUIDE}</span>
              <button type="button" onClick={() => { onClose(); openSettings("engines"); }}
                className="self-start text-[10px] hover:underline" style={{ color: "var(--primary)" }}>
                Set the key in Settings › Agent engines
              </button>
            </div>
          )}
          {!other && shown?.provider === "opencode" && <OpenCodeLocal u={shown} />}
        </div>
        <AccountKeyBar p={acc} />
      </div>
    </Portal>
  );
}

/**
 * One provider's cell in the bank: the mark, its tightest window's number, and
 * a fill on the baseline the four cells share. The cell is fixed width so the
 * number never moves the row, and a provider that cannot report keeps a dash
 * over a dashed track — a hole is a state, not a zero.
 *
 * The window the number belongs to is not on the bar: it is in the hover, in
 * the full sentence, and in the sheet the cell opens.
 */
function PlanChip({ u, age, dim, active, first, onOpen, anchor }: {
  u: ProviderUsage; age: string | null; dim?: boolean; active?: boolean; first?: boolean;
  onOpen: () => void; anchor: (el: HTMLButtonElement | null) => void;
}) {
  const view = chipView(u);
  const w = view.kind === "reading" ? view.window : null;
  const tip = [bankTip(u, w), age ? `Could not refresh — last read ${age} ago.` : ""].filter(Boolean).join(" ");
  const nil = view.kind === "none";
  return (
    <button onClick={onOpen} ref={anchor} data-bank-cell data-tip={tip} aria-label={tip} aria-expanded={active} aria-haspopup="dialog"
      className="relative flex flex-col justify-center shrink-0"
      style={{
        opacity: dim ? 0.45 : 1, transition: "opacity .15s",
        // 24 inside the 26 track, as the mockup has it: the two spare pixels
        // are the box's own border and baseline, not a click target.
        minWidth: 38, height: 24, padding: "2px 6px", gap: 2,
        // One border and one baseline for the whole instrument: the divider
        // between cells is an inset shadow so it costs no width.
        boxShadow: first ? undefined : "inset 1px 0 0 color-mix(in srgb, var(--text) 8%, transparent)",
        ...NO_DRAG,
      }}>
      <span className="flex items-center justify-center gap-1" style={{ height: 12 }}>
        <span className="flex" style={{ color: MARK_INK[u.provider] }}>
          <ProviderMark provider={u.provider} size={ICON.xs} />
        </span>
        {view.kind === "reading" ? (
          <>
            <b className="text-[10.5px] font-semibold tabular-nums text-right truncate"
              style={{ minWidth: "2.05em", maxWidth: "2.05em", color: bankInk(view.percent), opacity: age ? 0.55 : 1 }}>{view.percent}%</b>
            {view.hot && <span aria-hidden className="text-[8px] font-semibold leading-none" style={{ color: "var(--error-ink)" }}>!</span>}
          </>
        ) : (
          <>
            {/* A spend total is a reading with no window to fill: the dollars,
                and no track, because a track at zero would say "nothing used".
                Capped to the width the fold charges a cell, so a six-figure
                spend cannot push the row past the room it was given. */}
            <b className="text-[10.5px] tabular-nums text-right truncate"
              style={{ minWidth: "2.05em", maxWidth: "2.05em", color: view.kind === "spend" ? "var(--text2)" : "var(--text4)" }}>
              {view.kind === "spend" ? `$${view.usd.toFixed(2)}` : "—"}
            </b>
          </>
        )}
      </span>
      {view.kind !== "spend" && (
        <span aria-hidden className="block rounded-sm overflow-hidden"
          style={{
            height: 2,
            background: nil ? "transparent" : "color-mix(in srgb, var(--text) 13%, transparent)",
            border: nil ? "1px dashed color-mix(in srgb, var(--text) 26%, transparent)" : undefined,
          }}>
          {view.kind === "reading" && (
            <span className="block h-full rounded-sm" style={{
              width: `${Math.max(0, Math.min(100, view.percent))}%`,
              background: bankFill(view.percent),
            }} />
          )}
        </span>
      )}
    </button>
  );
}


export function TopBar({
  workspace, workspaces, onOpenProject, onOpenPalette, onOpenFiles, quiet, needs,
  needsList, onNeedApprove, onNeedProject, onNeedTerminal, onNoteGoto, onOpenLantern,
  filterProvider = "",
}: {
  /** `undefined` means "not asked yet" — distinct from null, which is a real
   *  answer ("the whole machine"). The chip must not claim either while the
   *  server is still coming up underneath it. */
  workspace: string | null | undefined;
  /** Every open project, when several were opened together. `workspace` is
   *  the first of them. */
  workspaces?: readonly string[];
  onOpenProject: () => void;
  onOpenPalette: () => void;
  /** Open the finder. It had a chord and nothing else, which makes it a
   *  feature you have to be told about — reported as exactly that. */
  onOpenFiles: () => void;
  /**
   * Step back — the view below is already saying all of this.
   *
   * On the dashboard the readings dim rather than disappear: the bar must not
   * change height or the whole app would jump a row every time you switch to
   * it, and a strip that says the same thing as the screen underneath is
   * exactly what made the old notch feel decorative.
   */
  quiet?: boolean;
  /** Something wants you: how many, which one, WHAT FOR, and where it lives. */
  needs: { count: number; label: string; because: string; plan?: string } | null;
  /** All of them, with what can honestly be done about each — see NeedsPopover. */
  needsList: NeedsItem[];
  onNeedApprove: () => void;
  onNeedProject: (root: string) => void;
  onNeedTerminal: () => void;
  /** A notification that knows where it belongs. */
  /** Where a notification points — a pull request, or a checkout with work in
   *  it. See SystemNote["goto"]. */
  onNoteGoto: (g: NonNullable<SystemNote["goto"]>) => void;
  onOpenLantern: () => void;
  /** The dashboard's provider filter, which decides whose plan the meters
   *  show. */
  filterProvider?: string;
}) {
  const time = useMinuteClock();
  const win = useWindowState();
  // An older server answers with `workspace` alone; that one project is the list.
  const open = workspaces?.length ? workspaces : workspace ? [workspace] : [];
  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);
  const upd = useSyncExternalStore(subscribeUpdate, updateState, updateState);
  const { note, behind, ahead } = useAmbientNotes();
  const chip = useRef<HTMLButtonElement>(null);
  const [needsOpen, setNeedsOpen] = useState(false);
  // What the panel was opened FOR. See needsStaysOpen: without this the flag
  // outlived its alerts and the next one drew the panel by itself.
  const needsFor = useRef<string[]>([]);
  const needKeys = needsList.map((n) => n.key).join("\n");
  useEffect(() => {
    if (needsOpen && !needsStaysOpen(needsFor.current, needKeys ? needKeys.split("\n") : [])) setNeedsOpen(false);
  }, [needsOpen, needKeys]);

  /*
   * The meters stand down while the middle of the bar is in use.
   *
   * The centred slot is positioned on the WINDOW and the group on the right is
   * laid out from the right edge, so the two are not in the same flow and
   * nothing stops them meeting: on a narrow window a notification runs straight
   * under the plan meters and neither can be read. Reported with a screenshot
   * of exactly that, and with the right question — "is that possible? knowing
   * exactly when there is a collision?".
   *
   * It is, and it is measured rather than guessed at a breakpoint: two
   * `getBoundingClientRect`s and the arithmetic in topbarFit. A breakpoint
   * would be wrong twice — a short message on a narrow window hides meters that
   * fit, and a long one on a wide window still collides.
   *
   * `metersWide` remembers what they measured while they were showing, because
   * hiding them moves the right group's edge by their own width: feeding the
   * moved edge back in would say there is room, bring them back, and collide
   * again. The decision is fed the geometry as if they were there.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const metersRef = useRef<HTMLSpanElement>(null);
  const metersWide = useRef(0);
  const [metersHidden, setMetersHidden] = useState(false);
  const [bankRoom, setBankRoom] = useState(Number.POSITIVE_INFINITY);
  const plusRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current, right = rightRef.current, bar = barRef.current;
    if (!slot || !right || !bar) return;
    const measure = () => {
      const s = slot.getBoundingClientRect();
      const r = right.getBoundingClientRect();
      const m = metersRef.current?.getBoundingClientRect().width ?? 0;
      if (m > 0) metersWide.current = m;
      // The bar's own width, not the bank's: a bank that folds gets narrower
      // and would feed its new width back in as "there is room", which is the
      // same loop the collision measure avoids. 430 is the furniture around
      // it — mark, project, finder, clock.
      setBankRoom(bar.getBoundingClientRect().width - 430);
      setMetersHidden((hidden) => metersMustHide({
        slotRight: s.right,
        // As if they were showing — see metersWide above.
        rightEdge: r.left - (hidden ? metersWide.current : 0),
        occupied: s.width > 0,
        hidden,
      }));
    };
    measure();
    /*
     * Observed rather than polled — and the BAR is observed too, which is the
     * half a first pass missed. Measured in Chrome on a replica of this strip:
     * narrowing the window from 1280 to 860 changed the size of neither the
     * slot (its cap is `min(46vw, 460px)`, and 46vw is still over 460) nor the
     * right group, so a ResizeObserver on those two never fired and the
     * message sat under the meters at 1100, 980 and 860 with the arithmetic
     * saying `hide` and nobody asking it. A ResizeObserver reports SIZE, not
     * position; the bar is the box whose size does change with the window.
     */
    const ro = new ResizeObserver(measure);
    ro.observe(slot);
    ro.observe(right);
    ro.observe(bar);
    return () => ro.disconnect();
  });

  // A chip per provider — direction A: the number and the window it belongs
  // to, in the same breath. A provider filter narrows the row to one.
  const [, bumpUsage] = useState(0);
  useEffect(() => subscribeProviderUsage(() => bumpUsage((n) => n + 1)), []);
  const [refreshing, setRefreshing] = useState(false);
  const refreshUsage = useCallback(() => {
    setRefreshing(true);
    // The button means "read it now" for every provider: Claude and Codex answer
    // the GET, and OpenCode's console reading only exists if it is asked for.
    // Asked only when it has a chip, so a machine without the opencode binary
    // never opens a page on a button press.
    const asked = (providerUsage() ?? []).some((r) => r.provider === "opencode");
    const read = asked ? api.refreshOpenCodeUsage(true).catch(() => {}) : Promise.resolve();
    void read.finally(() => refreshProviderUsage().finally(() => setRefreshing(false)));
  }, []);
  /* Anchored off the chip's own rect rather than positioned with CSS: the strip
     is inside a flex row whose width changes with the plan text, so a panel
     pinned to it in the layout would move every time a percentage did. */
  const chipEls = useRef(new Map<ProviderUsage["provider"], HTMLButtonElement>());
  // Read through a ref so the fallback below stays a stable callback: a cell
  // hidden by the fold is unmounted and has no element to return focus to.
  const hiddenCount = useRef(0);
  const anchorFor = useCallback((provider?: ProviderUsage["provider"]) =>
    (provider ? chipEls.current.get(provider) ?? null : null)
    ?? (hiddenCount.current > 0 ? plusRef.current : null)
    ?? chipEls.current.values().next().value ?? null, []);
  const [planAt, setPlanAt] = useState<{ top: number; right: number; provider: ProviderUsage["provider"]; staged?: true } | null>(null);
  // The sheet is opened from a cell that stands down with the meters; without
  // this it outlived the strip it belongs to and sat over nothing.
  useEffect(() => { if (metersHidden) setPlanAt(null); }, [metersHidden]);
  /* A resize moves the chip (the strip is a flex row that gives cells up as it
     narrows) and changes how much window is to the right of it. The `right`
     measured at open then put the 378px sheet at x = -127 in a 427px window. */
  const planProviderForAnchor = planAt?.provider;
  useEffect(() => {
    if (!planProviderForAnchor) return;
    const place = () => setPlanAt((was) => {
      if (!was) return was;
      const b = anchorFor(was.provider);
      if (!b) return was;
      const r = b.getBoundingClientRect();
      return { ...was, top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) };
    });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [planProviderForAnchor, anchorFor]);
  const openPlan = useCallback((provider: ProviderUsage["provider"], el: HTMLButtonElement | null) => {
    warmDayStrip().catch(() => {});
    setPlanAt((was) => {
      if (was?.provider === provider) return null;
      const r = el?.getBoundingClientRect();
      return r ? { top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right), provider } : null;
    });
  }, []);
  // An agent's proposal to switch account: the popover is where it is drawn, so open it.
  // Seen once per request, so closing it is not undone by the next render.
  const seenProposal = useRef(0);
  const hasRow = useRef(false);
  const liveProvider = useRef<ProviderUsage["provider"] | undefined>(undefined);
  // The providers the bar has a cell for. A ref because the proposal
  // subscription is registered once and must read this render's cells.
  const barIds = useRef<Set<ProviderUsage["provider"]>>(new Set());
  useEffect(() => subscribeStage(() => {
    const r = accountStageOf(peekStage());
    if (!r) return;
    const d = onProposal(seenProposal.current, r.n, hasRow.current);
    seenProposal.current = d.seen;
    if (!d.open) return;
    const provider = stagedProvider(r.a.provider, (p) => barIds.current.has(p), liveProvider.current);
    setPlanAt((was) => {
      if (was) return was;
      const b = anchorFor(provider);
      return b && provider
        ? { top: Math.round(b.getBoundingClientRect().bottom + 6), right: Math.round(window.innerWidth - b.getBoundingClientRect().right), provider, staged: true }
        : null;
    });
  }), [anchorFor]);
  const ctx = providerInContext(filterProvider);
  /* No context is not "no quota". `providerInContext` answers null whenever the
     filter names no provider — on the dashboard, in the terminal, in a browser
     tab — and a single lookup there drew nothing. The row is every provider's
     chip instead, so the strip still answers when nobody is in focus. */
  const allRows = rowsInBar((providerUsage() ?? []).filter(isCoreRow));
  // Just after a switch the new login may have no reading yet; a chip keeps the
  // previous row, marked old, rather than vanishing (usageHold.ts).
  const chips = (ctx ? allRows.filter((r) => r.provider === ctx) : allRows).map((row) => {
    const { u: shown, held } = stripRow(row, heldRows(row.provider));
    const r = shown ?? row;
    // Codex's reading only moves when a turn runs, so it can be days old and
    // the age is the whole difference between a number and a lie.
    const age = !r.available ? null : held ? heldAgeLabel(r.observedAt, Date.now()) : r.observedAt ? stalenessLabel(r.observedAt) : null;
    return { row: r, age };
  });
  const live = (ctx ? usageOf(ctx) : null) ?? (ctx ? null : busiestOf(rowsInBar(providerUsage() ?? [])));
  const { u } = stripRow(live, heldRows(ctx ?? undefined));
  hasRow.current = !!u;
  liveProvider.current = u?.provider;
  // The popover's day chart is answered before the popover exists; see dayStrip.ts.
  const planProvider = u?.provider;
  useEffect(() => { if (planProvider === "anthropic") warmDayStrip().catch(() => {}); }, [planProvider]);
  const planShown = planAt ? chips.find((c) => c.row.provider === planAt.provider) ?? null : null;
  const fold = foldCells(bankRoom, chips.length);
  const shownChips = chips.slice(0, fold.shown);
  const hiddenChips = chips.slice(fold.shown);
  hiddenCount.current = hiddenChips.length;
  barIds.current = new Set(chips.map((c) => c.row.provider));

  const alarm = !!needs?.count;

  return (
    <div
      ref={barRef}
      className="flex flex-nowrap items-center gap-2.5 px-2.5 shrink-0 relative select-none overflow-hidden whitespace-nowrap"
      style={{
        height: TOP_BAR_H,
        // The traffic lights live in this strip on macOS and belong to the
        // system, so the first control starts after them. The old header did
        // the same for the same reason; it is not a Mac tax on other platforms.
        paddingLeft: IS_MAC_DESKTOP ? 78 : undefined,
        background: alarm ? "color-mix(in srgb, var(--warning) 10%, var(--bg2))" : "var(--surface-card)",
        borderBottom: alarm ? "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" : LINE,
        transition: "background .18s, border-color .18s",
        // This strip IS the title bar: the window is frameless (see
        // electron/main.js), so dragging it is the only way to move the window.
        // Every control in it marks itself no-drag, or it would be a button you
        // cannot press.
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      {/* ── who and where ─────────────────────────────────────────── */}
      {/* The mark, not the word. At this height the wordmark was eight
          characters of the one thing on screen nobody needs to be told, and the
          logo says it in a sixth of the width — which is width the project name
          gets instead.

          The landing's mark, alive, at the landing's proportion of its bar
          (22 in 30 here, 45 in 62 there), and where the launch cover's mark
          lands when the app is ready — see lib/cover.ts. */}
      <LivingMark size={ICON.xl} coverTarget className="shrink-0" title="agentglass" style={{ pointerEvents: "none" }} />
      <AppMenuButton />
      {/* The project this cockpit is about, and the way to change it.
          It used to be two spans of plain text with a chevron, and it read as
          a label: nobody who had not been told could tell it was the control
          that switches project. So it is drawn as what it is — a chip with an
          edge, a hover state and a pressable surface — and the open project
          carries the weight, since "which project am I in" is the one thing
          this corner exists to answer. */}
      <button onClick={onOpenProject} aria-label={scopeAria(open, workspace)} className="agx-btn flex items-center gap-1.5 shrink-0 min-w-0 rounded-md pl-1.5 pr-1"
        title={workspace ? `${scopeTitle(open)}\nClick to switch project` : workspace === null ? "Every repo on this machine — click to open projects" : "Reading the open project…"}
        style={{
          ...NO_DRAG,
          // 20 tall, like the finder beside it: five clear either side in the
          // 30px strip, instead of the padding filling it edge to edge.
          height: 20,
          border: `1px solid color-mix(in srgb, var(--border) ${workspace ? 55 : 40}%, transparent)`,
          background: workspace ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)",
        }}>
        <span className="shrink-0 flex" style={{ color: workspace ? "var(--primary-hover)" : "var(--text4)" }}><FolderIcon size={ICON.xs} /></span>
        <span className="text-[10.5px] truncate" style={{ color: workspace ? "var(--text)" : "var(--text3)", fontWeight: workspace ? 600 : 400, maxWidth: 190 }}>
          {/* Three states, said differently on purpose: a project, the
              deliberate whole-machine view, and "not known yet" — which used
              to be indistinguishable from the second and had the bar quietly
              claiming "all repos" over a cockpit scoped to one project. */}
          {workspace ? scopeLabel(open) : workspace === null ? "all repos" : "…"}
        </span>
        <span className="text-[10px] shrink-0" style={{ color: "var(--text4)" }}>▾</span>
      </button>

      {/*
        * NO LIVE COUNT, NO AHEAD, NO BEHIND.
        *
        * Three numbers that were read once and then never again. How many
        * shells are running is answered by the terminal you are looking at; how
        * many commits are unpushed is a fact about a branch, and the strip above
        * that branch already carries it where you are deciding about it. Up here
        * they were a permanent ticker on a bar whose middle is deliberately
        * empty so that the ONE thing that wants you has somewhere to appear.
        */}

      {/* ── the middle: nothing, until something wants you ─────────── */}
      {/* Absolutely centred rather than a flex remainder between two groups of
          different widths, which is centred on the leftover space and therefore
          on nothing. When the bar is calm this is empty on purpose: a strip
          whose middle always has something in it has nowhere left to put the
          one thing that matters. */}
      <div className="flex-1 min-w-0" />
      {/* One slot, and the blocked thing always wins it. A toast is something
          that happened and is already in the bell's list; the chip is something
          that has not happened yet and will not until you act. Showing the
          passing message over the standing block would be the wrong way round,
          and showing both would put two things in the one place the bar keeps
          empty so that it has somewhere to put the one thing that matters. */}
      <div ref={slotRef} data-topbar-slot className="absolute left-1/2 -translate-x-1/2 flex items-center" style={{ top: 0, bottom: 0 }}>
        {alarm ? (
          <button ref={chip} onClick={() => {
              /* One plan waiting for Go is the whole reason: the chip goes straight to it. Several are a list, and the arrow below is only drawn where a list opens. */
              if (chipGoesToPlan(needs, needsList.length)) { openFlightPlan({ card: needs!.plan }); return; }
              needsFor.current = needsList.map((n) => n.key);
              setNeedsOpen((v) => !v);
            }}
            aria-label="What needs you" aria-expanded={needsOpen}
            className="flex items-center gap-2 px-2.5 py-px rounded-full min-w-0"
            style={{
              color: "var(--warning-ink)",
              border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)",
              background: "color-mix(in srgb, var(--warning) 14%, transparent)",
              maxWidth: "min(52vw, 520px)",
              ...NO_DRAG,
            }}
            title={`${needs!.label} — ${needs!.because}`}>
            <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: "var(--warning)" }} />
            <span className="text-[10px] font-semibold truncate shrink-0" style={{ maxWidth: 200 }}>{needs!.label}</span>
            {/* WHAT it wants, in its own words. The chip used to say only that
                something wanted you, which leaves you to open the thing to find
                out whether it was worth opening — and the reason was on the
                event all along: a permission request names its tool, a
                notification carries its message. */}
            <span className="text-[10px] truncate opacity-90 min-w-0">{needs!.because}</span>
            {needs!.count > 1 && (
              <span className="text-[10px] tabular-nums shrink-0 opacity-75" title={`${needs!.count} agents want you`}>+{needs!.count - 1}</span>
            )}
            {/* No key advertised. Enter belongs to whatever has focus — a
                shell, a composer — and binding it globally would take it from
                them; promising it and not binding it is worse. The chip is the
                gesture.

                And no arrow either. It said "go →" while what it did was open a
                screen you could not answer from; the chip opens a panel over
                itself now and moves nothing, so a glyph promising travel would
                be the same lie in a smaller font. */}
            {!chipGoesToPlan(needs, needsList.length) && <span className="text-[10px] opacity-75 shrink-0">{needsOpen ? "▴" : "▾"}</span>}
          </button>
        ) : (
          <NoteToast note={note} />
        )}
      </div>
      <NeedsPopover
        anchorRef={chip}
        avoidRef={rightRef}
        open={needsOpen && alarm}
        items={needsList}
        onClose={() => setNeedsOpen(false)}
        onApprove={() => { setNeedsOpen(false); onNeedApprove(); }}
        onProject={(root) => { setNeedsOpen(false); onNeedProject(root); }}
        onTerminal={() => { setNeedsOpen(false); onNeedTerminal(); }}
      />

      {/* ── the plan, the clock, the way in ───────────────────────── */}
      <div ref={rightRef} data-topbar-right className="flex items-center gap-2.5 shrink-0">
        {/* No reading is worth saying out loud: a meter that silently stops
            moving reads as "you have used nothing", which is the opposite. The
            word is short because the strip is narrow; the sentence explaining
            which failure it was rides in the tooltip, and both the dashboard
            box and Stats print it in full. */}
        {/* One box, so what stands down for a notification is exactly the
            reading and its rule — never the clock, the bell or the window
            buttons, which are furniture you navigate by. Out of the layout
            rather than faded: half the point is the room it frees. */}
        <span ref={metersRef} data-topbar-meters className="flex items-center gap-2.5"
          style={{ display: metersHidden ? "none" : undefined }}>
        {/* One instrument, one cell per provider. The cells share a border and
            a baseline, so four numbers read as one gauge rather than four
            chips. Under ~560px of bar the tail folds into "+n", which opens the
            sheet on the providers it hid — the one width change, at a
            breakpoint. No provider name is ever on the bar to be cut. */}
        {/* No chip is no instrument: the box's border and its 26px would be a
            speck between the project and the finder on a machine that has
            nothing to report, or with every switch off. */}
        {(chips.length > 0 || !usageLoaded()) && (
        <span role="group" aria-label="Plan usage" data-bank
          onKeyDown={(ev) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(ev.key)) return;
            const cells = [...(ev.currentTarget.querySelectorAll<HTMLButtonElement>("[data-bank-cell]"))];
            const i = cells.indexOf(document.activeElement as HTMLButtonElement);
            if (i < 0 || cells.length < 2) return;
            ev.preventDefault();
            const next = ev.key === "Home" ? cells[0]! : ev.key === "End" ? cells[cells.length - 1]!
              : cells[(i + (ev.key === "ArrowRight" ? 1 : cells.length - 1)) % cells.length]!;
            next.focus({ preventScroll: true });
          }}
          className="flex items-stretch shrink-0"
          style={{
            height: 26, borderRadius: 7,
            border: EDGE,
            background: "var(--surface-nav)",
          }}>
          {!usageLoaded() && chips.length === 0
            ? Array.from({ length: 4 }, (_, i) => (
              <span key={i} aria-hidden className="flex flex-col justify-center gap-1 shrink-0"
                style={{ minWidth: BANK_CELL_PX, height: 24, padding: "2px 6px", boxShadow: i ? "inset 1px 0 0 color-mix(in srgb, var(--text) 8%, transparent)" : undefined }}>
                <span className="flex items-center justify-center gap-1">
                  <span className="agx-daybar-pulse rounded" style={{ width: 12, height: 12, background: "color-mix(in srgb, var(--text) 9%, transparent)", animationDelay: `${i * 80}ms` }} />
                  <span className="agx-daybar-pulse rounded-sm" style={{ width: 22, height: 8, background: "color-mix(in srgb, var(--text) 9%, transparent)", animationDelay: `${i * 80}ms` }} />
                </span>
                <span className="agx-daybar-pulse block rounded-sm" style={{ height: 2, background: "color-mix(in srgb, var(--text) 9%, transparent)", animationDelay: `${i * 80}ms` }} />
              </span>
            ))
            : shownChips.map(({ row, age }) => (
              <PlanChip key={row.provider} u={row} age={age} dim={quiet} active={planAt?.provider === row.provider}
                first={row.provider === shownChips[0]!.row.provider}
                anchor={(el) => { if (el) chipEls.current.set(row.provider, el); else chipEls.current.delete(row.provider); }}
                onOpen={() => openPlan(row.provider, chipEls.current.get(row.provider) ?? null)} />
            ))}
          {hiddenChips.length > 0 && (
            <button type="button" data-bank-cell aria-haspopup="dialog"
              title={`${hiddenChips.map((c) => c.row.label).join(", ")} — open details`}
              aria-label={`${hiddenChips.length} more: ${hiddenChips.map((c) => c.row.label).join(", ")} — open details`}
              onClick={() => openPlan(hiddenChips[0]!.row.provider, plusRef.current)}
              ref={plusRef}
              className="text-[9.5px] font-semibold shrink-0"
              style={{
                minWidth: 28, height: 24, paddingInline: 6, color: "var(--text3)", ...NO_DRAG,
                borderLeft: LINE,
                borderRadius: "0 6px 6px 0",
              }}>+{hiddenChips.length}</button>
          )}
        </span>
        )}
        {chips.length > 0 && (
        <span className="shrink-0" style={{ width: 1, height: 12, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
        )}
        </span>
        {/* The ⌘K badge that stood here is gone. It was a label for a
            shortcut, not a control anybody pressed — the palette opens on the
            key it names, and the one person who does not know the key is not
            going to learn it from a 9.5px pill. The strip is 30px tall and
            every millimetre of it is contested. */}
        {/*
          * The finder — shaped like the thing it opens, not like a chip.
          *
          * It was a bare ⌕ the size of the ⌘K badge beside it, and it read as
          * one more status pill: "it is tiny and does not draw the eye". A
          * search box is the one control everybody recognises without being
          * told, so it is drawn as one — a field with its placeholder and its
          * key — even though pressing it opens a palette rather than typing
          * here. That is the same trade GitHub, Linear and VS Code make in
          * their headers, and for the same reason.
          *
          * It collapses to the glyph on a narrow window, where the meters and
          * the clock have the better claim on the space.
          */}
        {/* SIZED TO THE BAR. Measured at 189x27.5 inside a strip 30 tall —
            near enough the full height, and a fifth of the width, for a
            control that is not the subject of the bar. 20 tall leaves five
            either side, which is what everything else up here sits in.
          *
            And the chord is gone from inside it, for the same reason the ⌘K
            badge beside it is gone: a printed shortcut is a label, not a
            control. Ctrl+Shift+P was eleven characters of monospace and the
            widest part of the button by some way, and somebody reading the
            placeholder is looking for the box rather than for the key. It is
            still on the tooltip, where a label belongs. */}
        <button onClick={onOpenFiles} title={`Finder (${chordLabel(appChordFor("files.palette"))})`}
          className="agx-topbar-find group flex items-center gap-1.5 shrink-0 rounded"
          style={{ height: 20, paddingInline: 6, ...NO_DRAG }}>
          {/* 14, not 11. On a narrow window this collapses to the glyph alone,
              and a glyph standing in for a whole control is the one thing on a
              bar that cannot be read at the size of a label. */}
          <span className="flex" style={{ color: "var(--primary-ink)" }}><SearchIcon size={ICON.xs} /></span>
          <span className="hidden md:block text-[10px] whitespace-nowrap leading-none" style={{ color: "var(--text3)" }}>
            Finder
          </span>
        </button>
        {/* Automatic cleanup at work; nothing here when it is idle. */}
        <CleanupChip noDrag={NO_DRAG} onOpen={onOpenLantern} />
        {/* Only in fullscreen. Windowed, the desktop already has a clock two
            centimetres away and a second one is furniture; fullscreen is
            exactly when that one is gone, which is when this earns its place.
            Outside the desktop shell there is no fullscreen to detect and no
            chrome being hidden, so it simply shows. */}
        {(!WINDOW_CONTROLS || win.full) && (
          <b className="text-[11px] tabular-nums tracking-[0.03em] shrink-0" style={{ color: "var(--text)" }}>{time}</b>
        )}
        {/* What you missed. The bar interrupts for one thing at a time in its
            middle; everything else it ever said is still in here. */}
        <NotifyBell noDrag={NO_DRAG} onGoto={onNoteGoto} />
        {planShown && planAt && (
          <PlanPanel u={planShown.row} age={planShown.age} tabs={chips} at={planAt} busy={refreshing}
            onRefresh={refreshUsage} onClose={() => setPlanAt(null)}
            onEscape={(provider) => { setPlanAt(null); anchorFor(provider)?.focus(); }} />
        )}
        {/* An update is worth noticing on the way past, never worth pulling the
            eye off a running fleet. */}
        {updateAvailable() && (
          <span title={`${upd?.branch} is available to install — Settings → About`} className="rounded-full shrink-0"
            style={{ width: 6, height: 6, background: "var(--success)" }} />
        )}
        <WindowControls max={win.max} />
      </div>
    </div>
  );
}
