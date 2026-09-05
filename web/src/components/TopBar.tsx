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
import type { ProviderUsage } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import { subscribeProviderUsage, usageOf, busiestOf, providerUsage, resetShort, resetLabel, usedColor, ageLabel, refreshProviderUsage } from "../lib/usageStore.ts";
import { providerInContext } from "../lib/providerContext.ts";
import { windowLabel } from "../../../shared/quota.ts";
import { stalenessLabel } from "../lib/usageAge.ts";
import { metersMustHide } from "../lib/topbarFit.ts";
import { subscribe as subscribeChats, listChats, getActiveChatId, getChat } from "../lib/chatStore.ts";
import type { AgentKind } from "../lib/agents.ts";
import { subscribeSessions, liveSessionCount } from "./TerminalPanel.tsx";
import { clock24, subscribeClock24 } from "../lib/clockPref.ts";
import { updateAvailable, subscribeUpdate, updateState } from "../lib/updateStore.ts";
import { IS_MAC_DESKTOP, WINDOW_CONTROLS } from "../lib/desktop.ts";
import { Logo } from "./Logo.tsx";
import { useAmbientNotes, NoteToast, NotifyBell } from "./TopBarNotes.tsx";
import { NeedsPopover, type NeedsItem } from "./NeedsPopover.tsx";
import { ICON } from "../lib/iconSize.ts";
import { appChordFor, chordLabel } from "../lib/keybindings.ts";

export const TOP_BAR_H = 30;

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/** The seven-day window's label, asked of the same function that made it rather
 *  than spelled out here, so the two cannot drift apart. */
const WEEKLY = windowLabel(10080);

/** Anything clickable inside a drag region has to opt out of it, or the window
 *  moves instead of the button firing. */
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

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

/** The window's own clock. A second's resolution is pointless at this size, so
 *  it ticks per minute — and stops when the tab is hidden, because nobody reads
 *  a clock they cannot see and the point of all this is a quiet CPU. */
function useMinuteClock(): string {
  const h24 = useSyncExternalStore(subscribeClock24, clock24, () => true);
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

/** A reading: what it is, then what it says. Inline, on one baseline — see the
 *  note at the top of this file for why that is the whole point. */
function Item({ cap, children, title, dim, hideUnder }: {
  cap?: string; children: React.ReactNode; title?: string; dim?: boolean;
  /** Drop below this breakpoint rather than squeezing the row. A strip that
   *  wraps to two lines on a narrow window is worse than one that says less. */
  hideUnder?: "sm" | "md";
}) {
  const vis = hideUnder === "md" ? "hidden md:flex" : hideUnder === "sm" ? "hidden sm:flex" : "flex";
  return (
    <span className={`${vis} items-center gap-1.5 shrink-0`} title={title} style={{ opacity: dim ? 0.45 : 1, transition: "opacity .15s" }}>
      {cap && <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{cap}</span>}
      {children}
    </span>
  );
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

function Meter({ pct, tint }: { pct: number; tint: string }) {
  return (
    <span className="block rounded-full shrink-0" style={{ width: 26, height: 3, background: "color-mix(in srgb, var(--text) 18%, transparent)" }}>
      <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: tint }} />
    </span>
  );
}

/**
 * THE PLAN STRIP: "18% used 48m · 77% used 2d 1h · 17% used Fable".
 *
 * It was `5H ▬ 17%  WEEKLY ▬ 76%  FABLE ▬ 17%` — a caption, a bar and a number
 * for every window, three times over. That is three of everything and it still
 * did not answer the question you actually have when you look up here, which is
 * not "how much is gone" but "how long until I get it back".
 *
 * So each window is one phrase, and the phrase ends with the thing that was
 * missing. One bar, for the tightest window, because a bar is a shape you read
 * without counting and three of them side by side is a chart nobody asked for.
 *
 * The suffix is the RESET TIME, unless another window already showed that same
 * time — then it is the window's own name. Two windows that come back together
 * are usually a weekly bucket and a per-model bucket inside it, and printing
 * "2d 1h" twice says nothing the first one did not; the name says which of the
 * two you are looking at, which is the part in doubt.
 */
/**
 * The panel behind the strip: every window, spelled out.
 *
 * The strip answers "how much, and how long" in one line and cannot answer
 * anything else — which window is which, when each one actually comes back,
 * whether the reading is current. Those are the questions you have exactly
 * once, at the moment you are deciding whether to keep going, and they were
 * unanswerable without opening Stats.
 *
 * A bar per window, full width, because here there IS room and a row of three
 * short bars is a chart. `resetLabel` rather than the strip's compact form:
 * with the space for it, "Wed 3:00 PM" is more use than "2d 1h" when you are
 * deciding whether to wait.
 */
function PlanPanel({ u, age, at, onClose, onRefresh, busy }: {
  u: ProviderUsage; age: string | null; at: { top: number; right: number };
  onClose: () => void; onRefresh: () => void; busy: boolean;
}) {
  const windows = [...u.windows].sort((a, b) => a.minutes - b.minutes);
  return (
    <Portal z={10050}>
      {/* The scrim is what closes it. A panel this small does not deserve a
          key handler of its own and a click anywhere else is what everybody
          already tries. */}
      <div className="fixed inset-0" onClick={onClose} style={{ background: "transparent" }} />
      <div className="fixed flex flex-col rounded-xl overflow-hidden"
        style={{
          top: at.top, right: at.right, width: 300,
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          boxShadow: "0 22px 48px -20px var(--shadow)",
        }}>
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>{u.label}</span>
          {u.plan && <span className="chip text-[10px] t-dim">{u.plan}</span>}
          <span className="ml-auto text-[10px]" style={{ color: age ? "var(--warning)" : "var(--text4)" }}>
            {age ? `last read ${age} ago` : ageLabel(u.observedAt)}
          </span>
          <button onClick={onRefresh} disabled={busy} title="Read the plan again"
            className="shrink-0 grid place-items-center rounded hover:bg-white/10 disabled:opacity-40"
            style={{ width: 20, height: 20, color: "var(--text3)" }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
              strokeLinecap="round" strokeLinejoin="round"
              style={busy ? { animation: "agx-spin 1s linear infinite" } : undefined}>
              <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-3 px-3 py-3">
          {windows.map((w) => {
            const reset = resetLabel(w.resetsAt);
            return (
              <div key={w.label}>
                <div className="flex items-baseline gap-2">
                  <span className="text-[11.5px]" style={{ color: "var(--text)" }}>{w.label}</span>
                  <span className="ml-auto text-[11px] tabular-nums"
                    style={{ color: usedColor(w.usedPercent) }}>{w.usedPercent}% used</span>
                </div>
                <span className="block rounded-full mt-1.5" style={{ height: 4, background: "color-mix(in srgb, var(--text) 14%, transparent)" }}>
                  <span className="block h-full rounded-full" style={{
                    width: `${Math.max(2, Math.min(100, w.usedPercent))}%`,
                    background: usedColor(w.usedPercent),
                  }} />
                </span>
                {reset && (
                  <span className="block text-[10px] mt-1" style={{ color: "var(--text4)" }}>
                    Resets {reset}
                  </span>
                )}
              </div>
            );
          })}
          {!windows.length && (
            <span className="text-[11.5px]" style={{ color: "var(--text4)" }}>This provider reports no windows.</span>
          )}
        </div>
      </div>
    </Portal>
  );
}

function PlanStrip({ u, age, dim, onOpen, btn }: {
  u: ProviderUsage; age: string | null; dim?: boolean;
  onOpen: () => void; btn: React.MutableRefObject<HTMLButtonElement | null>;
}) {
  const windows = [...u.windows].sort((a, b) => a.minutes - b.minutes);
  if (!windows.length) return null;
  const worst = windows.reduce((w, x) => (x.usedPercent > w.usedPercent ? x : w), windows[0]!);

  const seen = new Set<string>();
  const parts = windows.map((w) => {
    const reset = resetShort(w.resetsAt);
    /* The name wins when the time is a repeat — see the note above. */
    const suffix = reset && !seen.has(reset) ? reset : w.label;
    if (reset) seen.add(reset);
    return { key: w.label, pct: w.usedPercent, suffix, hot: w.usedPercent >= 80 };
  });

  return (
    <button ref={btn} onClick={onOpen}
      className="flex items-center gap-2 shrink-0 rounded hover:bg-white/5"
      style={{ opacity: dim ? 0.45 : 1, transition: "opacity .15s", paddingInline: 4, height: 20, ...NO_DRAG }}
      title={age ? `could not refresh — last read ${age} ago` : `${u.label} plan usage — open for every window`}>
      <Meter pct={worst.usedPercent} tint={worst.usedPercent >= 80 ? "var(--error)" : "var(--warning)"} />
      {parts.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <span className="text-[9.5px] hidden md:inline" style={{ color: "var(--text4)" }}>·</span>}
          <span className={`text-[9.5px] tabular-nums whitespace-nowrap ${i === 0 ? "" : "hidden md:inline"}`}
            style={{ color: "var(--text3)", opacity: age ? 0.55 : 1 }}>
            <b style={{ color: p.hot ? "var(--error)" : "var(--text2)" }}>{p.pct}%</b> used {p.suffix}
          </span>
        </Fragment>
      ))}
      {/* The refresh lives in the panel now rather than here: a button inside
          a button cannot be pressed without pressing both, and the strip had
          to become the trigger for the panel to exist at all. */}
    </button>
  );
}

/**
 * One plan window: how much of it is gone.
 *
 * `age` is set only once the reading has stopped refreshing. It takes over the
 * caption and dims the number, so a stuck meter is legible as stuck at a glance
 * without ever ceasing to answer the question it is there to answer. The
 * alternative — replacing the number with the word "stale" — throws away a true
 * reading half an hour old, which is still the best answer anyone has.
 */
function PlanMeter({ tag, pct, age, dim, hideUnder }: {
  tag: string; pct: number; age: string | null; dim?: boolean; hideUnder?: "sm" | "md";
}) {
  return (
    <Item
      cap={age ? `${tag} · ${age} old` : tag}
      dim={dim}
      hideUnder={hideUnder}
      title={`${pct}% of the ${tag} window${age ? ` — could not refresh, last read ${age} ago` : ""}`}
    >
      <Meter pct={pct} tint={pct >= 80 ? "var(--error)" : "var(--warning)"} />
      <b className="text-[9.5px] tabular-nums" style={{ color: "var(--text2)", opacity: age ? 0.55 : 1 }}>{pct}%</b>
    </Item>
  );
}

export function TopBar({
  workspace, onOpenProject, onOpenPalette, onOpenFiles, quiet, needs,
  needsList, onNeedChat, onNeedApprove, onNeedProject, onNeedTerminal, onNoteGoto,
  filterProvider = "",
}: {
  /** `undefined` means "not asked yet" — distinct from null, which is a real
   *  answer ("the whole machine"). The chip must not claim either while the
   *  server is still coming up underneath it. */
  workspace: string | null | undefined;
  onOpenProject: () => void;
  onOpenPalette: () => void;
  /** Open the file finder. It had a chord and nothing else, which makes it a
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
  needs: { count: number; label: string; because: string } | null;
  /** All of them, with what can honestly be done about each — see NeedsPopover. */
  needsList: NeedsItem[];
  onNeedChat: (chatId: string) => void;
  onNeedApprove: () => void;
  onNeedProject: (root: string) => void;
  onNeedTerminal: () => void;
  /** A notification that knows where it belongs. */
  /** Where a notification points — a pull request, or a checkout with work in
   *  it. See SystemNote["goto"]. */
  onNoteGoto: (g: NonNullable<SystemNote["goto"]>) => void;
  /** The dashboard's provider filter, which decides whose plan the meters
   *  show when no chat is focused. Wired to the focused chat's agent in the
   *  commit after this one. */
  filterProvider?: string;
}) {
  const time = useMinuteClock();
  const win = useWindowState();
  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);
  const waiting = useSyncExternalStore(subscribeChats, () => listChats().reduce((n, c) => n + (c.attention !== "none" ? 1 : 0), 0), () => 0);
  const upd = useSyncExternalStore(subscribeUpdate, updateState, updateState);
  const { note, behind, ahead } = useAmbientNotes();
  const chip = useRef<HTMLButtonElement>(null);
  const [needsOpen, setNeedsOpen] = useState(false);

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
  useLayoutEffect(() => {
    const slot = slotRef.current, right = rightRef.current, bar = barRef.current;
    if (!slot || !right || !bar) return;
    const measure = () => {
      const s = slot.getBoundingClientRect();
      const r = right.getBoundingClientRect();
      const m = metersRef.current?.getBoundingClientRect().width ?? 0;
      if (m > 0) metersWide.current = m;
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

  // One gauge, for the provider in context — the agent whose chat is focused,
  // or failing that whatever the dashboard is filtered to. The strip is a
  // glance, so three providers' meters here would be two too many; the
  // dashboard box and Stats are where all of them are listed side by side.
  //
  // Which chat is focused is read straight from chatStore rather than taken as
  // a prop: that is the one place the live answer exists, kept current by the
  // chat panel's own tab switching. The dashboard's filter is the fallback for
  // when no chat is focused at all — and it is usually empty exactly while you
  // are deep in a chat, which is why the filter alone was not enough.
  const activeId = useSyncExternalStore(subscribeChats, getActiveChatId, () => "");
  const focusedAgent: AgentKind | null = getChat(activeId)?.agent ?? null;
  const [, bumpUsage] = useState(0);
  useEffect(() => subscribeProviderUsage(() => bumpUsage((n) => n + 1)), []);
  const [refreshing, setRefreshing] = useState(false);
  const refreshUsage = useCallback(() => {
    setRefreshing(true);
    void refreshProviderUsage().finally(() => setRefreshing(false));
  }, []);
  /* Anchored off the button's own rect rather than positioned with CSS: the
     strip is inside a flex row whose width changes with the plan text, so a
     panel pinned to it in the layout would move every time a percentage did.
     Same trick the notification panel uses, and for the same reason. */
  const planBtn = useRef<HTMLButtonElement | null>(null);
  const [planAt, setPlanAt] = useState<{ top: number; right: number } | null>(null);
  const openPlan = useCallback(() => {
    setPlanAt((was) => {
      if (was) return null;
      const r = planBtn.current?.getBoundingClientRect();
      return r ? { top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) } : null;
    });
  }, []);
  const ctx = providerInContext(focusedAgent, filterProvider);
  /* No context is not "no quota". `providerInContext` answers null whenever no
     chat is focused and the filter names no provider — on the dashboard, in the
     terminal, in a browser tab — and the meters simply stopped being drawn.
     Reported as "sometimes it does not appear at all"; it was never about the
     plan, it was about where you happened to be standing. */
  const u = (ctx ? usageOf(ctx) : null) ?? (ctx ? null : busiestOf(providerUsage()));
  // A provider that has no reading to give right now — rate-limited, signed
  // out, or one that never reports at all. Worth saying out loud: a meter that
  // silently stops moving reads as "you have used nothing", the opposite of
  // what is true. The reason is the provider's own sentence, in the tooltip.
  const unread = !!u && !u.available;
  // How old the numbers are, and only once that is worth saying. The meters keep
  // their last good reading through a burst of 429s rather than vanishing, which
  // is only honest if they also say when it was taken. The clock beside them
  // re-renders this strip every minute, so this stays current without a timer.
  // Codex's reading only moves when a turn runs, so it can be days old and the
  // age is the whole difference between a number and a lie.
  const age = u?.available && u.observedAt ? stalenessLabel(u.observedAt) : null;

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
        background: alarm ? "color-mix(in srgb, var(--warning) 10%, var(--bg2))" : "var(--bg2)",
        borderBottom: alarm ? "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" : edge(13),
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
          gets instead. */}
      <Logo size={17} className="shrink-0" title="agentglass" style={{ pointerEvents: "none" }} />
      <AppMenuButton />
      {/* The project this cockpit is about, and the way to change it.
          It used to be two spans of plain text with a chevron, and it read as
          a label: nobody who had not been told could tell it was the control
          that switches project. So it is drawn as what it is — a chip with an
          edge, a hover state and a pressable surface — and the open project
          carries the weight, since "which project am I in" is the one thing
          this corner exists to answer. */}
      <button onClick={onOpenProject} className="agx-btn flex items-center gap-1.5 shrink-0 min-w-0 rounded-md pl-1.5 pr-1 py-1"
        title={workspace ? `${workspace}\nClick to switch project` : workspace === null ? "Every repo on this machine — click to open a single project" : "Reading the open project…"}
        style={{
          ...NO_DRAG,
          border: `1px solid color-mix(in srgb, var(--border) ${workspace ? 55 : 40}%, transparent)`,
          background: workspace ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)",
        }}>
        <span className="text-[10px] shrink-0" style={{ color: workspace ? "var(--primary-hover)" : "var(--text4)" }}>▣</span>
        <span className="text-[10.5px] truncate" style={{ color: workspace ? "var(--text)" : "var(--text3)", fontWeight: workspace ? 600 : 400, maxWidth: 190 }}>
          {/* Three states, said differently on purpose: a project, the
              deliberate whole-machine view, and "not known yet" — which used
              to be indistinguishable from the second and had the bar quietly
              claiming "all repos" over a cockpit scoped to one project. */}
          {workspace ? workspace.split("/").filter(Boolean).pop() : workspace === null ? "all repos" : "…"}
        </span>
        <span className="text-[10px] shrink-0" style={{ color: "var(--text4)" }}>▾</span>
      </button>

      {/* The live state belongs with what it is about — this project, these
          shells — not adrift in the middle of the bar. */}
      <Item cap="live" dim={quiet} title={`${shells} shell${shells === 1 ? "" : "s"} running`}>
        <span className="rounded-full" style={{ width: 6, height: 6, background: shells ? "var(--success)" : "color-mix(in srgb, var(--text) 22%, transparent)" }} />
        <b className="text-[10.5px] tabular-nums" style={{ color: "var(--text)" }}>{shells}</b>
      </Item>
      {waiting > 0 && (
        <Item cap="chats" dim={quiet} title="Chats that replied while you were elsewhere">
          <b className="text-[10.5px] tabular-nums" style={{ color: "var(--success)" }}>{waiting}</b>
        </Item>
      )}
      {/* Work that exists only here, and work that exists only there. The first
          had no indicator anywhere: a branch you have committed to and not
          pushed looked exactly like one with nothing outstanding, and that is
          the state where losing a laptop costs you the work. Both leave entirely
          at zero — an idle strip should not spend width saying nothing is
          happening. */}
      {ahead > 0 && (
        <Item cap="to push" dim={quiet} hideUnder="md" title={`${ahead} commit${ahead === 1 ? "" : "s"} committed here and pushed nowhere`}>
          <Arrow up />
          <b className="text-[10.5px] tabular-nums" style={{ color: "var(--success)" }}>{ahead}</b>
        </Item>
      )}
      {behind > 0 && (
        <Item cap="to pull" dim={quiet} hideUnder="md" title={`${behind} commit${behind === 1 ? "" : "s"} on the upstream you have not pulled`}>
          <Arrow />
          <b className="text-[10.5px] tabular-nums" style={{ color: "var(--info)" }}>{behind}</b>
        </Item>
      )}

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
          <button ref={chip} onClick={() => setNeedsOpen((v) => !v)}
            aria-label="What needs you" aria-expanded={needsOpen}
            className="flex items-center gap-2 px-2.5 py-px rounded-full min-w-0"
            style={{
              color: "var(--warning)",
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
            <span className="text-[10px] opacity-75 shrink-0">{needsOpen ? "▴" : "▾"}</span>
          </button>
        ) : (
          <NoteToast note={note} />
        )}
      </div>
      <NeedsPopover
        anchorRef={chip}
        open={needsOpen && alarm}
        items={needsList}
        onClose={() => setNeedsOpen(false)}
        onChat={(id) => { setNeedsOpen(false); onNeedChat(id); }}
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
        {unread ? (
          <Item cap="plan" title={u?.note ?? `No plan reading for ${u?.label ?? "this agent"} right now`}>
            <span className="text-[9.5px]" style={{ color: "var(--warning)" }}>no reading</span>
          </Item>
        ) : (
          <>
            {/* Every window the provider reports, labelled with whatever it
                called them — the five-hour and weekly buckets, and for Anthropic
                the per-model weekly ones too. Not hardcoded to any model name:
                the plan that has one bucket this week can have another next
                week, and a bar that only knows last quarter's models quietly
                stops mentioning your limits. The longest window is the last to
                go on a narrow screen, being the one that matters at a glance. */}
            {u && <PlanStrip u={u} age={age} dim={quiet} btn={planBtn} onOpen={openPlan} />}
          </>
        )}
        <span className="shrink-0" style={{ width: 1, height: 12, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
        </span>
        {/* The ⌘K badge that stood here is gone. It was a label for a
            shortcut, not a control anybody pressed — the palette opens on the
            key it names, and the one person who does not know the key is not
            going to learn it from a 9.5px pill. The strip is 30px tall and
            every millimetre of it is contested. */}
        {/*
          * Find a file — shaped like the thing it opens, not like a chip.
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
        <button onClick={onOpenFiles} title={`Find a file (${chordLabel(appChordFor("files.palette"))})`}
          className="agx-topbar-find group flex items-center gap-1.5 shrink-0 rounded"
          style={{ height: 20, paddingInline: 6, ...NO_DRAG }}>
          {/* 14, not 11. On a narrow window this collapses to the glyph alone,
              and a glyph standing in for a whole control is the one thing on a
              bar that cannot be read at the size of a label. */}
          <span className="leading-none" style={{ color: "var(--primary)", fontSize: 14 }}>⌕</span>
          <span className="hidden md:block text-[10px] whitespace-nowrap leading-none" style={{ color: "var(--text3)" }}>
            Find a file…
          </span>
        </button>
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
        {u && planAt && (
          <PlanPanel u={u} age={age} at={planAt} busy={refreshing}
            onRefresh={refreshUsage} onClose={() => setPlanAt(null)} />
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
