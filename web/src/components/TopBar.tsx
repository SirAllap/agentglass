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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import { subscribeProviderUsage, usageOf } from "../lib/usageStore.ts";
import { providerInContext } from "../lib/providerContext.ts";
import { windowLabel } from "../../../shared/quota.ts";
import { stalenessLabel } from "../lib/usageAge.ts";
import { subscribe as subscribeChats, listChats, getActiveChatId, getChat } from "../lib/chatStore.ts";
import type { AgentKind } from "../lib/agents.ts";
import { subscribeSessions, liveSessionCount } from "./TerminalPanel.tsx";
import { clock24, subscribeClock24 } from "../lib/clockPref.ts";
import { updateAvailable, subscribeUpdate, updateState } from "../lib/updateStore.ts";
import { IS_MAC_DESKTOP, WINDOW_CONTROLS } from "../lib/desktop.ts";
import { Logo } from "./Logo.tsx";
import { useAmbientNotes, NoteToast, NotifyBell } from "./TopBarNotes.tsx";
import { NeedsPopover, type NeedsItem } from "./NeedsPopover.tsx";

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
      <svg viewBox="0 0 16 16" width={13} height={13} fill="currentColor" aria-hidden>
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
      {cap && <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{cap}</span>}
      {children}
    </span>
  );
}

/** Commits moving one way or the other. Direction by shape, so the two readings
 *  are told apart without reading their captions. */
function Arrow({ up }: { up?: boolean }) {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6}
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
  workspace, onOpenProject, onOpenPalette, quiet, needs,
  needsList, onNeedChat, onNeedApprove, onNeedProject, onNeedTerminal, onNoteGoto,
  filterProvider = "",
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
  /** Something wants you: how many, which one, WHAT FOR, and where it lives. */
  needs: { count: number; label: string; because: string } | null;
  /** All of them, with what can honestly be done about each — see NeedsPopover. */
  needsList: NeedsItem[];
  onNeedChat: (chatId: string) => void;
  onNeedApprove: () => void;
  onNeedProject: (root: string) => void;
  onNeedTerminal: () => void;
  /** A notification that knows where it belongs. */
  onNoteGoto: (g: { kind: "pr"; repo: string; number: number }) => void;
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
  const ctx = providerInContext(focusedAgent, filterProvider);
  const u = ctx ? usageOf(ctx) : null;
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
      <button onClick={onOpenProject} className="flex items-center gap-1.5 shrink-0 min-w-0 rounded px-1 -mx-1"
        title={workspace ? `${workspace}\nClick to switch project` : "Open a project — everything here scopes itself to its folder"}
        style={NO_DRAG}>
        <span className="text-[10.5px] truncate" style={{ color: workspace ? "var(--text)" : "var(--text4)", maxWidth: 190 }}>
          {workspace ? workspace.split("/").filter(Boolean).pop() : "all repos"}
        </span>
        <span className="text-[8px]" style={{ color: "var(--text4)" }}>▾</span>
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
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center" style={{ top: 0, bottom: 0 }}>
        {alarm ? (
          <button ref={chip} onClick={() => setNeedsOpen((v) => !v)}
            aria-label="What needs you" aria-expanded={needsOpen}
            className="flex items-center gap-2 px-2.5 py-[1px] rounded-full min-w-0"
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
              <span className="text-[9px] tabular-nums shrink-0 opacity-75" title={`${needs!.count} agents want you`}>+{needs!.count - 1}</span>
            )}
            {/* No key advertised. Enter belongs to whatever has focus — a
                shell, a composer — and binding it globally would take it from
                them; promising it and not binding it is worse. The chip is the
                gesture.

                And no arrow either. It said "go →" while what it did was open a
                screen you could not answer from; the chip opens a panel over
                itself now and moves nothing, so a glyph promising travel would
                be the same lie in a smaller font. */}
            <span className="text-[9px] opacity-75 shrink-0">{needsOpen ? "▴" : "▾"}</span>
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
      <div className="flex items-center gap-2.5 shrink-0">
        {/* No reading is worth saying out loud: a meter that silently stops
            moving reads as "you have used nothing", which is the opposite. The
            word is short because the strip is narrow; the sentence explaining
            which failure it was rides in the tooltip, and both the dashboard
            box and Stats print it in full. */}
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
            {u?.windows.map((w) => (
              <PlanMeter key={w.label} tag={w.label} pct={w.usedPercent} age={age} dim={quiet}
                hideUnder={w.label === WEEKLY ? "sm" : "md"} />
            ))}
          </>
        )}
        <span className="shrink-0" style={{ width: 1, height: 12, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
        <button onClick={onOpenPalette} title="Search anything (⌘K)"
          className="hidden sm:block text-[9.5px] px-1.5 py-[1px] rounded shrink-0"
          style={{ color: "var(--text3)", border: edge(16), ...NO_DRAG }}>⌘K</button>
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
