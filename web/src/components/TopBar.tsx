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
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type UsagePayload } from "../lib/api.ts";
import { subscribeUsage, usageError } from "./UsageWidget.tsx";
import { subscribe as subscribeChats, listChats } from "../lib/chatStore.ts";
import { subscribeSessions, liveSessionCount } from "./TerminalPanel.tsx";
import { clock24, subscribeClock24 } from "../lib/clockPref.ts";
import { updateAvailable, subscribeUpdate, updateState } from "../lib/updateStore.ts";
import { IS_MAC_DESKTOP, WINDOW_CONTROLS } from "../lib/desktop.ts";

export const TOP_BAR_H = 30;

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

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
function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!WINDOW_CONTROLS) return;
    void WINDOW_CONTROLS.isMaximized().then(setMax).catch(() => {});
    return WINDOW_CONTROLS.subscribe(setMax);
  }, []);
  if (!WINDOW_CONTROLS || IS_MAC_DESKTOP) return null;

  const btn = "grid place-items-center rounded transition-colors";
  const box = { width: 26, height: 20, color: "var(--text3)", ...NO_DRAG } as React.CSSProperties;
  return (
    <span className="flex items-center gap-0.5 shrink-0 ml-1 -mr-1.5">
      <button onClick={WINDOW_CONTROLS.minimize} aria-label="Minimise" title="Minimise"
        className={`${btn} hover:bg-white/10 hover:text-[var(--text)]`} style={box}>
        <svg viewBox="0 0 12 12" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={1.1}><path d="M2.5 6h7" /></svg>
      </button>
      <button onClick={WINDOW_CONTROLS.toggleMaximize} aria-label={max ? "Restore" : "Maximise"} title={max ? "Restore" : "Maximise"}
        className={`${btn} hover:bg-white/10 hover:text-[var(--text)]`} style={box}>
        {max ? (
          // Two offset squares: the window comes back OUT of full width, which
          // one square cannot say.
          <svg viewBox="0 0 12 12" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={1.1}>
            <rect x="2" y="4" width="6" height="6" rx="1" /><path d="M4.4 4V3a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1H8" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={1.1}>
            <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
          </svg>
        )}
      </button>
      <button onClick={WINDOW_CONTROLS.close} aria-label="Close" title="Close"
        className={`${btn} hover:text-white`} style={box}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--error)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
        <svg viewBox="0 0 12 12" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={1.1}><path d="M3 3l6 6M9 3l-6 6" /></svg>
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
  return `${hh}:${String(now.getMinutes()).padStart(2, "0")}`;
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
      {cap && <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{cap}</span>}
      {children}
    </span>
  );
}

function Meter({ pct, tint }: { pct: number; tint: string }) {
  return (
    <span className="block rounded-full shrink-0" style={{ width: 26, height: 3, background: "color-mix(in srgb, var(--text) 18%, transparent)" }}>
      <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: tint }} />
    </span>
  );
}

export function TopBar({
  workspace, onOpenProject, onOpenPalette, quiet, needs, onGoNeeds,
}: {
  workspace: string | null;
  onOpenProject: () => void;
  onOpenPalette: () => void;
  /**
   * Step back — the view below is already saying all of this.
   *
   * On the dashboard the readings dim rather than disappear: the bar must not
   * change height or the whole app would jump a row every time you switch to
   * it, and a strip that says the same thing as the screen underneath is
   * exactly what made the old notch feel decorative.
   */
  quiet?: boolean;
  /** Something wants you: how many, and the one to jump to. */
  needs: { count: number; label: string } | null;
  onGoNeeds: () => void;
}) {
  const time = useMinuteClock();
  const shells = useSyncExternalStore(subscribeSessions, liveSessionCount, liveSessionCount);
  const waiting = useSyncExternalStore(subscribeChats, () => listChats().reduce((n, c) => n + (c.attention !== "none" ? 1 : 0), 0), () => 0);
  const upd = useSyncExternalStore(subscribeUpdate, updateState, updateState);

  const [u, setU] = useState<UsagePayload | null>(null);
  useEffect(() => subscribeUsage(setU), []);
  const rateLimited = !u?.available && usageError()?.includes("429");
  const five = u?.five_hour;
  const week = u?.seven_day;

  const alarm = !!needs?.count;

  return (
    <div
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
      <button onClick={onOpenProject} className="flex items-center gap-1.5 shrink-0 min-w-0 rounded px-1 -mx-1"
        title={workspace ? `${workspace}\nClick to switch project` : "Open a project — everything here scopes itself to its folder"}
        style={NO_DRAG}>
        <span className="text-[10.5px] font-bold" style={{ color: "var(--text)" }}>agent<span style={{ color: "var(--primary)" }}>glass</span></span>
        <span className="shrink-0" style={{ width: 1, height: 12, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
        <span className="text-[10px] truncate" style={{ color: workspace ? "var(--text2)" : "var(--text4)", maxWidth: 170 }}>
          {workspace ? workspace.split("/").filter(Boolean).pop() : "all repos"}
        </span>
        <span className="text-[8px]" style={{ color: "var(--text4)" }}>▾</span>
      </button>

      {/* ── the middle: state, or the thing that wants you ────────── */}
      <div className="flex-1 min-w-0 flex items-center justify-center gap-3 overflow-hidden">
        {alarm ? (
          <button onClick={onGoNeeds} className="flex items-center gap-2 px-2.5 py-[1px] rounded-full shrink-0"
            style={{
              color: "var(--warning)",
              border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)",
              background: "color-mix(in srgb, var(--warning) 14%, transparent)",
              ...NO_DRAG,
            }}>
            <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--warning)" }} />
            <span className="text-[10px] font-semibold truncate" style={{ maxWidth: 260 }}>{needs!.label}</span>
            <span className="text-[9px] opacity-75">ir ⏎</span>
          </button>
        ) : (
          <>
            <Item cap="live" dim={quiet} title={`${shells} shell${shells === 1 ? "" : "s"} running`}>
              <span className="rounded-full" style={{ width: 6, height: 6, background: shells ? "var(--success)" : "color-mix(in srgb, var(--text) 22%, transparent)" }} />
              <b className="text-[10.5px] tabular-nums" style={{ color: "var(--text)" }}>{shells}</b>
            </Item>
            {waiting > 0 && (
              <Item cap="chats" dim={quiet} title="Chats that replied while you were elsewhere">
                <b className="text-[10.5px] tabular-nums" style={{ color: "var(--success)" }}>{waiting}</b>
              </Item>
            )}
          </>
        )}
      </div>

      {/* ── the plan, the clock, the way in ───────────────────────── */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Rate-limited is worth saying out loud: a meter that silently stops
            moving reads as "you have used nothing", which is the opposite. */}
        {rateLimited ? (
          <Item cap="plan" title="The usage endpoint answered 429 — the meters are the last good reading">
            <span className="text-[9.5px]" style={{ color: "var(--warning)" }}>rate-limited</span>
          </Item>
        ) : (
          <>
            {five && (
              <Item cap="5h" dim={quiet} hideUnder="md" title={`${five.utilization}% of the 5-hour window`}>
                <Meter pct={five.utilization} tint={five.utilization >= 80 ? "var(--error)" : "var(--warning)"} />
                <b className="text-[9.5px] tabular-nums" style={{ color: "var(--text2)" }}>{five.utilization}%</b>
              </Item>
            )}
            {week && (
              <Item cap="week" dim={quiet} hideUnder="sm" title={`${week.utilization}% of the weekly window`}>
                <Meter pct={week.utilization} tint={week.utilization >= 80 ? "var(--error)" : "var(--warning)"} />
                <b className="text-[9.5px] tabular-nums" style={{ color: "var(--text2)" }}>{week.utilization}%</b>
              </Item>
            )}
          </>
        )}
        <span className="shrink-0" style={{ width: 1, height: 12, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
        <button onClick={onOpenPalette} title="Search anything (⌘K)"
          className="hidden sm:block text-[9.5px] px-1.5 py-[1px] rounded shrink-0"
          style={{ color: "var(--text3)", border: edge(16), ...NO_DRAG }}>⌘K</button>
        <b className="text-[11px] tabular-nums tracking-[0.03em] shrink-0" style={{ color: "var(--text)" }}>{time}</b>
        {/* An update is worth noticing on the way past, never worth pulling the
            eye off a running fleet. */}
        {updateAvailable() && (
          <span title={`${upd?.branch} is available to install — Settings → About`} className="rounded-full shrink-0"
            style={{ width: 6, height: 6, background: "var(--success)" }} />
        )}
        <WindowControls />
      </div>
    </div>
  );
}
