import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WatchEvent, SessionRollup } from "../../shared/types.ts";
import { useLive } from "./lib/useLive.ts";
import { subscribeWorktreeJump, worktreeJump } from "./lib/worktreeJump.ts";
import { useStats } from "./lib/useStats.ts";
import { deriveAgents, deriveAlerts, buildTitles, buildRollups } from "./lib/derive.ts";
import { publishFleet } from "./lib/demoBridge.ts";
import { providerOf } from "./lib/format.ts";
import { api, IS_DEMO } from "./lib/api.ts";
import { initialTheme, applyTheme, THEMES } from "./lib/themes.ts";
import { subscribeControl } from "./lib/controlBus.ts";
import { latchChatIntent } from "./lib/chatIntent.ts";
import type { ControlCmd } from "../../shared/types.ts";
import { actionFor } from "./lib/keybindings.ts";
import { currentScale } from "./lib/uiScale.ts";
import { zoomAtPointer, type ZoomResult } from "./lib/zoomTarget.ts";
import { toggleFullscreen } from "./lib/desktop.ts";
import { useAlertSound } from "./lib/useSound.ts";
import { TopBar } from "./components/TopBar.tsx";
import { DashboardView } from "./components/DashboardView.tsx";
import { EventModal } from "./components/EventModal.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { HelpLegend } from "./components/HelpLegend.tsx";
import { StatsModal } from "./components/StatsModal.tsx";
import { SkillsModal } from "./components/SkillsModal.tsx";
import { Workspace } from "./components/workspace/Workspace.tsx";
import { VIEW_IDS, visibleIds, isVisibleView, moveView, loadRail, subscribeRail, SHIPPED_RAIL, loadLastView, type ViewId } from "./components/workspace/views.ts";
import ServerBanner from "./components/ServerBanner.tsx";
import GitMissingBanner from "./components/GitMissingBanner.tsx";
import { chordFromEvent, viewForChord } from "./lib/keybindings.ts";
import { onOpenSettings } from "./lib/openSettings.ts";
import { onOpenPrs } from "./lib/openPrs.ts";
import { newChat, chatResuming, applyLiveEvent } from "./lib/chatStore.ts";
import { sessionCwd } from "./lib/worktree.ts";
import { SearchModal } from "./components/SearchModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { MachinePanel, type MachineTab } from "./components/MachinePanel.tsx";
import { ZoomToast } from "./components/ZoomToast.tsx";
import { NoteToasts } from "./components/NoteToasts.tsx";
import { WhatsNew } from "./components/WhatsNew.tsx";
import { SessionModal } from "./components/SessionModal.tsx";
import { ProjectPicker, PICKER_ANSWERED_KEY } from "./components/ProjectPicker.tsx";
import { NeedsPopover, type NeedsItem } from "./components/NeedsPopover.tsx";
import { requestPrJump } from "./lib/prJump.ts";
import { subscribeGates, listGates } from "./lib/gateStore.ts";

/** The last segment of a path — a project's name as anyone says it out loud. */
const leafOf = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/**
 * Wrap a setState so a poll that answers the same thing twice doesn't commit.
 *
 * These endpoints return a fresh object every time, so `setX(result)` always
 * changed identity and always re-rendered the whole cockpit — several times a
 * minute, for data that had not moved. Comparing serialized form is far cheaper
 * than the render it avoids.
 */
const keepIfSame = <T,>(set: (v: T) => void) => {
  let last = "";
  return (next: T) => {
    const sig = JSON.stringify(next);
    if (sig === last) return;
    last = sig;
    set(next);
  };
};

export default function App() {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [filter, setFilter] = useState({ app: "", type: "", provider: "" });
  const [theme, setTheme] = useState(initialTheme());
  const [opts, setOpts] = useState<{ source_apps: string[]; hook_event_types: string[] }>({ source_apps: [], hook_event_types: [] });
  const [selected, setSelected] = useState<WatchEvent | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  /**
   * Which view the shell is showing.
   *
   * There is no `wsOpen` any more. The workspace was a modal you opened over a
   * dashboard nobody used; it is the window now, so the only state left is
   * WHICH view — and that is remembered across restarts, because landing where
   * you left off is the whole point of not having a front door.
   */
  const [wsView, setWsView] = useState<ViewId>(loadLastView);
  /** The dashboard is a view like any other, and this is what makes it free
   *  when it is not the one on screen. */
  const dashActive = wsView === "dash";
  /** Where ⌘\ goes back to. Without it, toggling off the dashboard would have
   *  to pick a view, and picking one for you is how you lose your place. */
  const lastNonDash = useRef<ViewId>(wsView === "dash" ? "term" : wsView);
  if (wsView !== "dash") lastNonDash.current = wsView;
  /** Hiding the view you are standing in cannot leave you standing in it.
   *
   *  It is the one rail edit with nowhere to go afterwards: no tab is
   *  highlighted, ⌘[ has no position to count from, and the only way back is a
   *  menu two clicks away. Step to the first tab that is still there instead —
   *  and to ⌘\'s fallback if the whole rail has been emptied, which is a
   *  layout the user is allowed to make and the app still has to survive. */
  const rail = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  /**
   * Go to a view, putting it back on the rail if it is not on one.
   *
   * Every route to a view that is not the rail itself — a dashboard card, "open
   * this in the browser", a chord somebody bound by hand, a command from the
   * phone. Hiding a view says "stop showing me this tab", and the honest
   * reading of asking for it by name afterwards is that you changed your mind.
   * The alternative is a button that does nothing, which is indistinguishable
   * from a broken one, and a workspace showing a view with no tab lit is how
   * you end up unable to get back.
   */
  const goView = useCallback((v: ViewId) => {
    if (!isVisibleView(v)) moveView(v, "work");
    setWsView(v);
  }, []);

  // A worktree jump from the Terminal chrome switches to the view it targets;
  // the git / file-changes panel reads the scope or filter from the same store.
  // goView, not a bare setWsView, so a view hidden from the rail comes back
  // rather than switching to a tab that is not there.
  const wtJump = useSyncExternalStore(subscribeWorktreeJump, worktreeJump);
  const wtJumpServed = useRef(0);
  useEffect(() => {
    if (wtJump && wtJump.n !== wtJumpServed.current) { wtJumpServed.current = wtJump.n; goView(wtJump.view); }
  }, [wtJump, goView]);
  useEffect(() => {
    const visible = visibleIds();
    // ⌘\'s way back, checked whether or not it is where you are: hiding the
    // view it points at is silent until the day you press it.
    if (!visible.includes(lastNonDash.current)) {
      lastNonDash.current = visible.find((v) => v !== "dash") ?? "term";
    }
    if (!visible.includes(wsView) && visible[0]) setWsView(visible[0]);
  }, [rail, wsView]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A pane a panel elsewhere asked us to land on — see lib/openSettings.ts.
  const [settingsPane, setSettingsPane] = useState<string | null>(null);
  const [prQuery, setPrQuery] = useState<string | null>(null);
  useEffect(() => onOpenSettings((pane) => { setSettingsPane(pane ?? null); setSettingsOpen(true); }), []);
  useEffect(() => onOpenPrs((q) => { setPrQuery(q); goView("pr"); }), [goView]);
  /** Which machine tab is open, or none. One piece of state for both surfaces:
   *  the dashboard header and the workspace rail open the same panel, and a
   *  second copy would be a second poll of /proc. */
  const [machine, setMachine] = useState<MachineTab | null>(null);
  const [chatFocus, setChatFocus] = useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionView, setSessionView] = useState<{ id: string; app: string } | null>(null);
  const [sound, setSound] = useState(false);
  // Mirrors the window's zoom for the settings row to read. The scale itself
  // lives in lib/uiScale.ts, applied before this component ever mounts.
  const [scale, setScale] = useState(currentScale);
  /** The last zoom, for the pill that says what changed and how big it is. */
  const [zoomed, setZoomed] = useState<(ZoomResult & { n: number }) | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);

  const [projectOpen, setProjectOpen] = useState(false);
  const mountedAt = useRef(Date.now());

  // A live snapshot of "is any panel/overlay open", read by the global key
  // handler so single-letter shortcuts can't stack a second panel on top of an
  // open one. Kept in a ref so the handler needn't re-subscribe on every toggle.
  // NB: the workspace is deliberately NOT in this list. It used to be, back
  // when it was five separate panels, and that guard is exactly what made the
  // app unusable: with git open, `d` did nothing, so reaching the diff meant
  // Escape, then `d`, losing the git panel's state on the way. Inside the
  // workspace the letters now *switch views* instead of being swallowed.
  const anyPanelOpen =
    paletteOpen || helpOpen || statsOpen || skillsOpen || searchOpen ||
    projectOpen || sessionView !== null || selected !== null;
  const anyPanelOpenRef = useRef(anyPanelOpen);
  anyPanelOpenRef.current = anyPanelOpen;
  const wsViewRef = useRef(wsView);
  wsViewRef.current = wsView;
  // The catalog is the one panel that can open *over* the workspace, from the
  // rail. Escape has to be able to tell the two apart, or one keystroke closes
  // both and you lose the shell you were looking at to read a description.
  const skillsOpenRef = useRef(skillsOpen);
  skillsOpenRef.current = skillsOpen;

  // The workspace covers the dashboard, so the dashboard's ambient loops are
  // animating for nobody. The stylesheet freezes them on `data-ws`, the same way
  // it already does for a backgrounded tab. It is a play-state flip rather than
  // an unmount, so closing the workspace resumes them instantly and switching
  // between the two stays immediate.
  //
  // A full-screen modal covers it just as completely, and that case was missed:
  // reading a session meant scrolling a few hundred rows on the same CPU that
  // was still sweeping a radar and pulsing a ring per live agent behind the
  // dim. Same treatment, same attribute.
  //
  // The workspace is no longer one of the cases: it does not cover the
  // dashboard any more, it REPLACES it — a view that is not on screen is not
  // mounted, so there is nothing left of it to freeze.
  const covered = anyPanelOpen || !dashActive;
  useEffect(() => {
    document.documentElement.dataset.ws = covered ? "1" : "0";
  }, [covered]);

  // Same argument, one level deeper: freezing the animations still left the
  // dashboard re-rendering five times a second — a two-thousand-event feed, two
  // charts and a fleet grid — behind whatever is on top of it. Holding the
  // socket's buffer instead gives the panel you are actually reading the main
  // thread to itself, and uncovering flushes it in one go.
  //
  // Only for a modal, and never merely because the dashboard is not the view
  // on screen: the chat panel is a live view fed by these very events, the
  // fleet spine reads them in every view, and holding them would freeze a
  // streaming answer mid-word.
  const { events, conn, lastEvent, openTools } = useLive(anyPanelOpen);
  // The live socket is the app's only real-time source, and until now the chat
  // panel was the one view that never saw it — a resumed session sat frozen on
  // whatever had been true when you opened it while the agent kept working.
  // This is the whole subscription: the store decides which chat, if any, each
  // event belongs to, and ignores everything else.
  //
  // Only the events past the high-water mark. `events` is a rolling buffer of
  // two thousand and every socket flush replaces the array, so handing the
  // whole thing to the store each time meant re-walking all of it — and the
  // store's own "seen" guard doesn't help, because it only records events that
  // matched an open chat. With no chat open, which is most of the time, nothing
  // was ever marked and every flush paid for all two thousand. That work lands
  // on the same thread that draws the terminal, which is where it showed up:
  // sluggish output and dropped keystrokes.
  const appliedThrough = useRef(0);
  useEffect(() => {
    let high = appliedThrough.current;
    for (const e of events) {
      if (e.id <= appliedThrough.current) continue;
      applyLiveEvent(e);
      if (e.id > high) high = e.id;
    }
    appliedThrough.current = high;
  }, [events]);

  // Which folder is this cockpit about? Ask once on first open when nothing is
  // scoped yet — picking a project up front is what gives the terminal, git
  // panel and command list their directory. Answering "whole machine" (or just
  // closing) is remembered, so an unscoped instance doesn't nag on each load.
  useEffect(() => {
    if (IS_DEMO) return;
    api.projects().then((p) => {
      setWorkspace(p.workspace);
      // The app filter is hidden while a project is open (the scope already
      // says whose data this is). Clear it on the way in, or a filter set in
      // the whole-machine view would keep narrowing the panels from behind a
      // control that is no longer on screen to undo it.
      if (p.workspace) setFilter((f) => (f.app ? { ...f, app: "" } : f));
      let answered = false;
      try { answered = localStorage.getItem(PICKER_ANSWERED_KEY) === "1"; } catch { /* ignore */ }
      if (!p.workspace && !answered) setProjectOpen(true);
    }).catch(() => {});
  }, []);

  // Poll on an interval — NOT on every event. Passing lastEvent.id as `bump`
  // used to refetch /stats on every single event (a per-event server query +
  // full chart re-render). The 4s interval is plenty for a summary.
  // Only while the dashboard is the view on screen. It is the app's dearest
  // poll and it feeds nothing else — see useStats for the numbers.
  const { stats } = useStats(windowMs, undefined, filter.provider, dashActive);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /**
   * The facet lists, for the command palette — fetched when it opens.
   *
   * This used to be a 20-second poll for the life of the process, feeding two
   * dropdowns in the app header. The header is gone and those dropdowns live
   * inside the dashboard now, which fetches its own; all that is left here is
   * the palette, which is shut almost always and stale never — a list of source
   * apps changes when somebody installs a new agent, not between two ticks.
   *
   * `keepIfSame` still guards the write: the palette can be opened repeatedly,
   * and a fresh object with identical contents re-renders the whole tree.
   */
  useEffect(() => {
    if (!paletteOpen) return;
    const take = keepIfSame(setOpts);
    api.filterOptions().then(take).catch(() => {});
  }, [paletteOpen]);

  // Statuses are functions of the clock, not only of the buffer: a session
  // mid-build emits nothing for minutes, and without a tick its card would
  // freeze on whatever was derived at the last event — never demoting to
  // idle, never advancing the "running Bash · 4m" duration.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Every session's provider, from the FULL buffer (so the list is stable and
  // never collapses when one provider is selected).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  /**
   * Session names, for the fleet cards.
   *
   * Cards are derived from the live event stream, which carries no title — it's
   * session-level and only the sessions endpoint has it. Polled slowly on
   * purpose: a session is renamed by hand once, if ever, so this is the one
   * piece of the dashboard that genuinely doesn't need to be live.
   */
  const [sessions, setSessions] = useState<SessionRollup[]>([]);
  useEffect(() => {
    const take = keepIfSame(setSessions); // once per effect, not once per poll
    const load = () => api.sessions(200).then(take).catch(() => { /* labels fall back to the uuid */ });
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);
  const titles = useMemo(() => buildTitles(sessions), [sessions]);
  // Same rows, second question: the buffer the cards sum over is a capped
  // window, so cost/tokens/tools come from the session roll-up where there is
  // one. See buildRollups.
  const rollups = useMemo(() => buildRollups(sessions), [sessions]);
  const agentsAll = useMemo(() => deriveAgents(events, openTools, titles, rollups), [events, openTools, titles, rollups, tick]);
  // Kept identical across renders while its *contents* are. `agentsAll` is
  // rebuilt on every socket flush and every tick, so a plain useMemo handed out
  // a new Map several times a second — and everything downstream that depends
  // on it, most expensively the feed's 120 rows, re-rendered for a value that
  // had not actually changed. The signature is cheap; the re-render was not.
  const providerRef = useRef(new Map<string, string>());
  const providerSig = useRef("");
  const sessionProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentsAll) if (a.model_name) map.set(a.session_id, providerOf(a.model_name));
    const sig = [...map].map(([k, v]) => k + "\u0000" + v).join("\u0001");
    if (sig === providerSig.current) return providerRef.current;
    providerSig.current = sig;
    providerRef.current = map;
    return map;
  }, [agentsAll]);
  // "unknown" (sessions whose model never resolved) is kept as a real bucket so
  // it can be filtered to and the per-provider views reconcile with the total,
  // but sorted to the end so it never leads the list. Header renders it as
  // "Unknown".
  const providers = useMemo(() => {
    const seen = new Set(sessionProvider.values());
    const known = [...seen].filter((p) => p !== "unknown").sort();
    return seen.has("unknown") ? [...known, "unknown"] : known;
  }, [sessionProvider]);
  // The Anthropic plan meters only make sense when Anthropic is what you're
  // looking at (no filter + Anthropic present, or explicitly filtered to it).
  const showUsage = (!filter.provider && providers.includes("Anthropic")) || filter.provider === "Anthropic";
  // Selecting a provider scopes EVERYTHING the client derives from the event
  // buffer — feed, tool-mix, throughput, radar, fleet, KPIs. /stats (cost,
  // latency, timeline) is scoped in parallel on the server via useStats(provider).
  const visibleEvents = useMemo(
    () => (filter.provider ? events.filter((e) => sessionProvider.get(e.session_id) === filter.provider) : events),
    [events, filter.provider, sessionProvider]
  );
  const agents = useMemo(
    () =>
      filter.provider
        ? deriveAgents(visibleEvents, openTools.filter((s) => sessionProvider.get(s.session_id) === filter.provider), titles, rollups)
        : agentsAll,
    [filter.provider, visibleEvents, agentsAll, openTools, sessionProvider, titles]
  );
  const alerts = useMemo(() => deriveAlerts(agents), [agents]);
  /** Held tool calls. Read here as well as on the dashboard so the bar can tell
   *  "an agent asked a question" from "an agent is stopped at a gate you can
   *  let through" — only the second has a button anywhere in this app. */
  const gates = useSyncExternalStore(subscribeGates, listGates, listGates);
  /**
   * The one thing the top bar interrupts for.
   *
   * An alert used to live in a panel on a screen nobody opened, which is an
   * archive rather than an alert. Here it takes the middle of the strip and
   * carries its own way in, so "an agent is waiting on you" cannot be missed
   * from any view — and says nothing at all when there is nothing to say.
   */
  const needs = useMemo(() => {
    if (!alerts.length) return null;
    const first = alerts[0]!;
    // `agent` is the card key the alert was raised from, so the name shown is
    // the session's own rather than a uuid the reader has never seen.
    const who = agents.find((a) => a.key === first.agent);
    const label = who?.title || who?.source_app || first.agent;
    return {
      count: alerts.length,
      // The name alone. It used to carry "needs you" as well, which spends the
      // width the reason needs to say something you can already see from the
      // amber strip it is sitting in.
      label,
      // WHAT it wants. The alert has always known — a permission request names
      // its tool, a notification carries its message — and deriveAlerts used to
      // replace all of it with one constant string. See becauseOf().
      because: first.text,
      // Where it is, and what can be done about it, live on `needsList` — the
      // chip is only the headline now, and the panel it opens is the thing that
      // has to know how to act.
    };
  }, [alerts, agents]);

  /**
   * Everything that is waiting on you, with what can honestly be done about it.
   *
   * The chip used to be a button that went somewhere: first the dashboard, then
   * the session — a chat when one existed, and SessionModal otherwise. That last
   * fallback is the one that had to go. SessionModal is a post-mortem headed
   * WHAT IT DID; it cannot answer "waiting for your input", so clicking an alarm
   * covered the terminal you were working in with a read-only summary and left
   * you no better off.
   *
   * So the chip opens a panel instead, and this is what it reads. An action is
   * listed only when it exists: a chat that can carry the reply, a gate the
   * dashboard can approve, a project this alert belongs to that is not the one
   * you have open. When none of them do, the panel says so and names the
   * directory, which is the useful half of what a destination would have done.
   */
  const needsList = useMemo((): NeedsItem[] => {
    const homeless = alerts.slice(0, 8);
    return homeless.map((al) => {
      const who = agents.find((a) => a.key === al.agent);
      const sessionId = who?.session_id ?? "";
      const project = who?.project ?? null;
      // A cockpit watches every project at once, so an alert from another one is
      // legitimate — but it must say which, or you go looking in the wrong tree.
      const other = project && workspace && project !== workspace ? leafOf(project) : null;
      return {
        key: al.id,
        sessionId,
        label: who?.title || who?.source_app || al.agent,
        because: al.text,
        level: al.level === "error" ? "error" : "warn",
        cwd: who?.cwd ?? project,
        project,
        otherProject: other,
        chatId: sessionId ? (chatResuming(sessionId)?.id ?? null) : null,
        gated: !!sessionId && gates.some((g) => g.session_id === sessionId),
      };
    });
  }, [alerts, agents, workspace, gates]);

  const openChatFor = useCallback((chatId: string) => {
    setChatFocus(chatId);
    goView("chat");
  }, [goView]);
  /** The Approve buttons live on the dashboard's "What needs you" — the one
   *  place in the app that can actually let a held tool call through. */
  const approveOnDash = useCallback(() => { goView("dash"); }, [goView]);
  const switchProject = useCallback((root: string) => {
    void api.setWorkspace(root).then((r) => { if (r.ok) setWorkspace(r.workspace); }).catch(() => {});
  }, []);
  useAlertSound(alerts.length, sound);

  // Demo builds only: hand the fleet to whoever is showing this build inside a
  // frame. Today that is the landing page's head-up display, which draws the
  // same eight sessions over the top of this dashboard and has to agree with it
  // to the cent. A no-op in every other build — see lib/demoBridge.ts.
  useEffect(() => {
    publishFleet(agentsAll, stats?.totals.cost_usd ?? 0);
  }, [agentsAll, stats]);

  const clearFilters = useCallback(() => setFilter({ app: "", type: "", provider: "" }), []);

  // Zoom steps through a fixed ladder rather than taking a target, so every
  // caller (keys, settings, palette) lands on the same rungs. uiScale owns the
  // real value; this only echoes it back for display.
  /**
   * Zoom whatever the pointer is over: the terminal's font over a terminal, the
   * window everywhere else.
   *
   * One gesture for what used to be two unrelated ones — Ctrl+/Ctrl− scaled the
   * window, and the terminal's size was a stepper in Settings → Terminal. So
   * making the shell readable also blew up the UI, and making the UI readable
   * shrank nothing you were reading. There is no mode to be in: you are already
   * pointing at the thing you want bigger.
   */
  const zoom = useCallback((dir: 1 | -1 | 0) => {
    const r = zoomAtPointer(dir);
    // `n` increments so holding the key reads as one adjustment rather than a
    // stack of identical toasts — see ZoomToast.
    setZoomed((cur) => ({ ...r, n: (cur?.n ?? 0) + 1 }));
    if (r.what === "app") setScale(currentScale());
  }, []);

  // Keyboard shortcuts: ⌘K / Ctrl-K palette, ? help, single-letter panels, Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl-K palette — always available, even inside a field or panel.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }

      // Zoom, on the usual browser keys — and like ⌘K, live everywhere: you
      // want to size the window up while reading a diff, not only from an empty
      // dashboard. Has to sit above the modifier bailout below, which would
      // otherwise swallow it. `+`/`_` cover shifted layouts, and `=`/`-` the
      // bare keys; a Spanish keyboard sends `+` and `-` directly.
      // Calls uiScale directly rather than the `zoom` callback so this effect
      // can keep its empty dep array and never re-subscribe.
      // Before the fixed bindings below, because a view chord may carry Alt and
      // that block deliberately ignores anything Alt-modified. Reserved chords
      // cannot be bound, so nothing here can shadow zoom or the palette.
      const chord = chordFromEvent(e);
      if (chord) {
        const target = viewForChord(chord);
        if (target) {
          e.preventDefault();
          goView(target);
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key;
        if (k === "=" || k === "+") { e.preventDefault(); zoom(1); return; }
        if (k === "-" || k === "_") { e.preventDefault(); zoom(-1); return; }
        if (k === "0") { e.preventDefault(); zoom(0); return; }

        // Workspace navigation, and the reason it carries a modifier: these
        // have to work while the caret sits in the chat composer or a commit
        // message, where a bare letter is just a letter.
        // The user's rail, not the shipped one: the rail labels each icon with
        // the number that reaches it, and a tooltip that stops being true after
        // a reorder is worse than no tooltip. Both drawers, since cycling is
        // "the next tab along" — but nothing they have hidden, which is not a
        // tab any more.
        const cycle = visibleIds();
        if (k === "[" || k === "]") {
          e.preventDefault();
          if (!cycle.length) return;
          setWsView((cur) => {
            const i = cycle.indexOf(cur);
            return cycle[(i + (k === "]" ? 1 : cycle.length - 1) + cycle.length) % cycle.length]!;
          });
          return;
        }
        // ⌘\ used to open and close the workspace. There is nothing to open —
        // it goes to the dashboard and back instead, which is the closest thing
        // left to "show me the app rather than the work".
        if (k === "\\") {
          e.preventDefault();
          // The ref, not `dashActive`: this handler is subscribed once with an
          // empty dep array, so a render value read here would be the one from
          // the mount and ⌘\ would toggle against a view you left long ago.
          goView(wsViewRef.current === "dash" ? lastNonDash.current : "dash");
          return;
        }
      }
      // F11, the way every desktop app binds it. Outside the modifier block —
      // it carries none — and before the bailout below, which would otherwise
      // swallow it along with the rest of the plain function keys.
      if (e.key === "F11") { e.preventDefault(); void toggleFullscreen(); return;
      }

      // Escape closes open panels, regardless of where focus rests. The real
      // terminal owns Escape while its shell is focused (vim, fzf, Ctrl+R…), so
      // leave xterm alone. Chat handles its own Escape locally (see ChatPanel)
      // because a focused textarea can swallow it before it reaches here.
      if (e.key === "Escape") {
        if ((e.target as HTMLElement)?.closest?.(".xterm")) return;
        // Escape closes whatever is ON the shell. It never closes the shell —
        // there is nothing behind it to go back to any more.
        setSelected(null);
        setPaletteOpen(false);
        setHelpOpen(false);
        setStatsOpen(false);
        setSkillsOpen(false);
        setSearchOpen(false);
        setSessionView(null);
        return;
      }

      // Single-letter globals below. Two guards, both required:
      //  * focus must rest on nothing (the <body>) — never a button (a mouse
      //    click parks focus there), an input, or a textarea. Without this a
      //    letter fires right after any click, and leaks into a field's draft.
      //  * no panel may already be open — otherwise a letter stacks a second
      //    panel on top of the first. Close with Escape, then open with a letter.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const a = document.activeElement;
      const focusFree = !a || a === document.body || a === document.documentElement;

      // Bare letters belong to the dashboard, and only to it.
      //
      // They used to switch views inside the workspace too, guarded by asking
      // `document.activeElement` whether the keystroke was going into a field
      // or a shell. That guard could not hold: focus inside the workspace falls
      // back to <body> constantly — xterm losing it, a click landing on padding
      // — and a body-focused keystroke read as "not typing", so a `g` typed
      // into the terminal jumped to git. Intermittently, which is the worst
      // way for a keyboard to be wrong: you stop trusting every key you press.
      //
      // There is no version of "is this keystroke meant for the app or for the
      // shell" that a heuristic answers reliably, so the rule is positional
      // instead of behavioural. Navigation carries a modifier — ⌘1..N, ⌘[/] —
      // which no shell will ever consume, and the rail is a click away.
      const canNavigate = focusFree && !anyPanelOpenRef.current;
      if (!canNavigate) return;

      // Which action owns this letter, according to the user's bindings —
      // which default to the shipped ones, so nothing changes until they say
      // so. Read per keystroke rather than captured in this effect's closure:
      // the effect has an empty dep array on purpose (it must not re-subscribe
      // on every render), and a rebind has to take effect immediately, not
      // after the next remount.
      const action = actionFor(e.key);

      // A workspace letter opens the workspace on that view. Only from the
      // dashboard now — the guard above has already established that — so it
      // opens rather than toggles: there is no open workspace to close from
      // here, and ⌘\ is the key that puts it away from inside.
      if (action?.startsWith("view.")) {
        const view = action.slice(5) as ViewId;
        e.preventDefault();
        goView(view);
        return;
      }

      switch (action) {
        case "open.help": setHelpOpen((o) => !o); break;
        case "open.stats": e.preventDefault(); setStatsOpen((o) => !o); break;
        case "open.skills": e.preventDefault(); setSkillsOpen((o) => !o); break;
        case "open.search": e.preventDefault(); setSearchOpen((o) => !o); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // External control (a Stream Deck, a phone): the live socket relays a command
  // from POST /control and we run it here — through the very setters the keyboard
  // handler above uses, so there is one navigation path, not two. Subscribes once
  // (empty deps) and reads nothing from render scope but the state setters, which
  // React guarantees stable; theme/zoom use functional updates so the current
  // value is read at apply time, not captured in this closure.
  useEffect(() => {
    const nextThemeId = (cur: string, cmd: Extract<ControlCmd, { cmd: "theme" }>): string => {
      if (cmd.name) return THEMES.some((t) => t.id === cmd.name) ? cmd.name : cur;
      const i = THEMES.findIndex((t) => t.id === cur);
      const n = THEMES.length;
      return THEMES[(((i < 0 ? 0 : i) + (cmd.dir ?? 1)) % n + n) % n]!.id;
    };
    return subscribeControl((cmd) => {
      switch (cmd.cmd) {
        case "view":
          goView(cmd.to);
          break;
        case "workspace":
          // No overlay to toggle any more: an external controller asking for
          // "the workspace" gets the last view that was not the dashboard,
          // which is what it was asking to see.
          setWsView((cur) => (cur === "dash" ? lastNonDash.current : cur));
          break;
        case "esc":
          // The same peel Escape does, minus the focus guards — a remote command
          // isn't typed into a field or a shell, so nothing has to be spared.
          setSelected(null);
          setPaletteOpen(false);
          setHelpOpen(false);
          setStatsOpen(false);
          setSkillsOpen(false);
          setSearchOpen(false);
          setSessionView(null);
          break;
        case "open":
          if (cmd.what === "stats") setStatsOpen(true);
          else if (cmd.what === "skills") setSkillsOpen(true);
          else if (cmd.what === "search") setSearchOpen(true);
          else if (cmd.what === "help") setHelpOpen(true);
          else if (cmd.what === "palette") setPaletteOpen(true);
          break;
        case "theme":
          setTheme((cur) => nextThemeId(cur, cmd));
          break;
        case "zoom":
          // Through the same door as the keys, so a remote controller and a
          // keystroke cannot disagree about what "zoom" means. There is no
          // pointer in a remote command, so it lands on the window — which is
          // what an external controller can sensibly mean by it.
          zoom(cmd.dir);
          break;
        case "chat":
          // Latch before opening: the panel drains the mailbox on mount, so
          // this works whether or not the chat view is already up.
          latchChatIntent(cmd.do);
          goView("chat");
          break;
      }
    });
  }, []);

  // /stats carries the server's process start; fall back to page mount for
  // demo mode and the beat before the first poll lands.
  const startedAt = stats?.server_started_at ?? mountedAt.current;
  const epm = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    return visibleEvents.filter((e) => e.timestamp >= cutoff).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEvents, lastEvent?.id]);

  return (
    <div className="h-screen overflow-hidden flex flex-col relative">
      <div className="aurora" />
      <div className="aurora-grid" />

      {/* Above everything, because when it shows, nothing below it is real. */}
      <ServerBanner />
      <GitMissingBanner />

      <TopBar
        workspace={workspace}
        onOpenProject={() => setProjectOpen(true)}
        onOpenPalette={() => setPaletteOpen(true)}
        // On the dashboard the readings step back: the screen below is already
        // saying all of it, and a strip repeating it is what made the old notch
        // feel like decoration.
        quiet={dashActive}
        needs={needs}
        needsList={needsList}
        onNeedChat={openChatFor}
        onNeedApprove={approveOnDash}
        onNeedProject={switchProject}
        onNeedTerminal={() => goView("term")}
        // A notification that knows what it is about. The panel may be open
        // over any view and the PR panel may not be mounted at all, so the
        // request is left in a slot and the view switched — the same shape the
        // issues panel uses to start a terminal it cannot reach.
        onNoteGoto={(g) => { requestPrJump(g.repo, g.number); goView("pr"); }}
      />

      <Workspace
        prQuery={prQuery}
        view={wsView} onView={setWsView}
        onSkills={() => setSkillsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onMachine={setMachine}
        chatFocusId={chatFocus}
        dashboard={(active) => (
          <DashboardView
            active={active}
            events={events} visibleEvents={visibleEvents}
            agents={agents} alerts={alerts} stats={stats}
            sessionProvider={sessionProvider} providers={providers}
            windowMs={windowMs} onWindow={setWindowMs}
            filter={filter} onFilter={setFilter} onClearFilter={clearFilters}
            retentionDays={stats?.retention_days}
            startedAt={startedAt} epm={epm}
            onSelectEvent={setSelected}
            onSelectSession={setSessionView}
          />
        )}
      />

      <EventModal event={selected} onClose={() => setSelected(null)} />
      <StatsModal open={statsOpen} onClose={() => setStatsOpen(false)} stats={stats} windowMs={windowMs} />
      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      {/* App-level, not inside a view: it is about the machine, not about
          whatever you happen to be looking at. */}
      {machine && (
        <MachinePanel tab={machine} onTab={setMachine} onClose={() => setMachine(null)}
          onOpenBrowser={() => { setMachine(null); goView("browser"); }} />
      )}
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onSelectApp={(app) => setFilter((f) => ({ ...f, app }))} />
      {/* Shows once when the app first runs a version it has not run before —
          the update button restarts into a new build and otherwise says nothing
          about what changed. */}
      <WhatsNew />
      {/* This machine's own notifications, over whatever is on screen — the
          point of mirroring them at all is that agentglass is what is covering
          the banner your desktop just drew. App-level and not inside a view, for
          the same reason MachinePanel is: a Slack ping is not about the panel
          you happen to be looking at. */}
      <NoteToasts onGoto={(g) => { requestPrJump(g.repo, g.number); goView("pr"); }} />
      <ZoomToast zoom={zoomed} />
      <SettingsModal
        open={settingsOpen}
        jumpTo={settingsPane}
        onClose={() => { setSettingsOpen(false); setSettingsPane(null); }}
        sound={sound}
        onSound={() => setSound((s) => !s)}
        scale={scale}
        onZoom={zoom}
        onOpenStats={() => setStatsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        theme={theme}
        onTheme={setTheme}
      />
      <SessionModal
        sessionId={sessionView?.id ?? null}
        sourceApp={sessionView?.app}
        onClose={() => setSessionView(null)}
        onFilter={(app) => setFilter((f) => ({ ...f, app }))}
        onResume={(s) => {
          // The checkout it actually ran in — a worktree session resumed at the
          // repo root would land on the wrong branch with none of its work.
          const cwd = sessionCwd(s);
          if (!cwd) return;
          // Reuse an open tab for the same session rather than starting a
          // second one: two chats resuming one id would both write to it.
          const existing = chatResuming(s.session_id);
          const chat = existing ?? newChat(cwd, s.model_name || undefined, undefined, {
            sessionId: s.session_id,
            title: s.summary?.slice(0, 40) || `${s.source_app}:${s.session_id.slice(0, 8)}`,
          });
          setChatFocus(chat.id);
          goView("chat");
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        apps={opts.source_apps}
        types={opts.hook_event_types}
        onFilter={(f) => setFilter((cur) => ({ ...cur, ...f }))}
        onWindow={setWindowMs}
        onTheme={setTheme}
        onStats={() => setStatsOpen(true)}
        onSkills={() => setSkillsOpen(true)}
        onChanges={() => goView("diff")}
        onGit={() => goView("git")}
        onPr={() => goView("pr")}
        onDocker={() => goView("docker")}
        onTerminal={() => goView("term")}
        onChat={() => goView("chat")}
        onSearch={() => setSearchOpen(true)}
        onClear={clearFilters}
        onZoom={zoom}
      />
      <HelpLegend open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ProjectPicker open={projectOpen} workspace={workspace} onClose={() => setProjectOpen(false)} />
    </div>
  );
}
