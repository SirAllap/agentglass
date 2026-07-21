import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WatchEvent, SessionRollup } from "../../shared/types.ts";
import { useLive } from "./lib/useLive.ts";
import { useStats } from "./lib/useStats.ts";
import { deriveAgents, deriveAlerts, buildTitles } from "./lib/derive.ts";
import { providerOf } from "./lib/format.ts";
import { api, IS_DEMO } from "./lib/api.ts";
import { initialTheme, applyTheme } from "./lib/themes.ts";
import { actionFor } from "./lib/keybindings.ts";
import { currentScale, nudgeScale, resetScale } from "./lib/uiScale.ts";
import { toggleFullscreen } from "./lib/desktop.ts";
import { useAlertSound } from "./lib/useSound.ts";
import { Header } from "./components/Header.tsx";
import { Kpis } from "./components/Kpis.tsx";
import { Throughput } from "./components/Throughput.tsx";
import { ToolMix } from "./components/ToolMix.tsx";
import { Radar } from "./components/Radar.tsx";
import { Alerts } from "./components/Alerts.tsx";
import { Fleet } from "./components/Fleet.tsx";
import { Feed } from "./components/Feed.tsx";
import { CostByModel } from "./components/CostByModel.tsx";
import { Latency } from "./components/Latency.tsx";
import { Sessions } from "./components/Sessions.tsx";
import { MissionTimeline } from "./components/MissionTimeline.tsx";
import { EventModal } from "./components/EventModal.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { HelpLegend } from "./components/HelpLegend.tsx";
import { StatsModal } from "./components/StatsModal.tsx";
import { SkillsModal } from "./components/SkillsModal.tsx";
import { Workspace } from "./components/workspace/Workspace.tsx";
import { VIEW_IDS, loadViewOrder, loadLastView, type ViewId } from "./components/workspace/views.ts";
import { chordFromEvent, viewForChord } from "./lib/keybindings.ts";
import { newChat, chatResuming, applyLiveEvent } from "./lib/chatStore.ts";
import { sessionCwd } from "./lib/worktree.ts";
import { SearchModal } from "./components/SearchModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { SessionModal } from "./components/SessionModal.tsx";
import { ProjectPicker, PICKER_ANSWERED_KEY } from "./components/ProjectPicker.tsx";

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
  const { events, conn, lastEvent, openTools } = useLive();
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

  const [windowMs, setWindowMs] = useState(3_600_000);
  const [filter, setFilter] = useState({ app: "", type: "", provider: "" });
  const [theme, setTheme] = useState(initialTheme());
  const [opts, setOpts] = useState<{ source_apps: string[]; hook_event_types: string[] }>({ source_apps: [], hook_event_types: [] });
  const [selected, setSelected] = useState<WatchEvent | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // One overlay replaced five modals. `wsView` is which view it shows, and it
  // survives closing — reopening lands you where you left off, because
  // switching views is the thing you do constantly.
  const [wsOpen, setWsOpen] = useState(false);
  const [wsView, setWsView] = useState<ViewId>(loadLastView);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatFocus, setChatFocus] = useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionView, setSessionView] = useState<{ id: string; app: string } | null>(null);
  const [sound, setSound] = useState(false);
  // Mirrors the window's zoom for the settings row to read. The scale itself
  // lives in lib/uiScale.ts, applied before this component ever mounts.
  const [scale, setScale] = useState(currentScale);
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
  const wsOpenRef = useRef(wsOpen);
  wsOpenRef.current = wsOpen;
  const wsViewRef = useRef(wsView);
  wsViewRef.current = wsView;

  // The workspace covers the dashboard, so the dashboard's ambient loops are
  // animating for nobody. The stylesheet freezes them on `data-ws`, the same way
  // it already does for a backgrounded tab. It is a play-state flip rather than
  // an unmount, so closing the workspace resumes them instantly and switching
  // between the two stays immediate.
  useEffect(() => {
    document.documentElement.dataset.ws = wsOpen ? "1" : "0";
  }, [wsOpen]);

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
  const { stats } = useStats(windowMs, undefined, filter.provider);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Filter options change rarely (a new app/event type) — poll slowly, and only
  // take the new object when it actually differs. Setting state to a fresh copy
  // of the same data still commits the whole tree; on a poll that answers
  // identically almost every time, that is a free re-render of the cockpit.
  useEffect(() => {
    const take = keepIfSame(setOpts); // once per effect — inside load() its memory would reset each call
    const load = () => api.filterOptions().then(take).catch(() => {});
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, []);

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
  const agentsAll = useMemo(() => deriveAgents(events, openTools, titles), [events, openTools, titles, tick]);
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
    const sig = [...map].map(([k, v]) => k + " " + v).join("");
    if (sig === providerSig.current) return providerRef.current;
    providerSig.current = sig;
    providerRef.current = map;
    return map;
  }, [agentsAll]);
  const providers = useMemo(
    () => [...new Set([...sessionProvider.values()].filter((p) => p !== "unknown"))].sort(),
    [sessionProvider]
  );
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
        ? deriveAgents(visibleEvents, openTools.filter((s) => sessionProvider.get(s.session_id) === filter.provider), titles)
        : agentsAll,
    [filter.provider, visibleEvents, agentsAll, openTools, sessionProvider, titles]
  );
  const alerts = useMemo(() => deriveAlerts(agents), [agents]);
  useAlertSound(alerts.length, sound);

  const clearFilters = useCallback(() => setFilter({ app: "", type: "", provider: "" }), []);

  // Zoom steps through a fixed ladder rather than taking a target, so every
  // caller (keys, settings, palette) lands on the same rungs. uiScale owns the
  // real value; this only echoes it back for display.
  const zoom = useCallback((dir: 1 | -1 | 0) => {
    setScale(dir === 0 ? resetScale() : nudgeScale(dir));
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
        const target = viewForChord(chord, loadViewOrder().map((v) => v.id));
        if (target) {
          e.preventDefault();
          setWsView(target);
          setWsOpen(true);
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key;
        if (k === "=" || k === "+") { e.preventDefault(); setScale(nudgeScale(1)); return; }
        if (k === "-" || k === "_") { e.preventDefault(); setScale(nudgeScale(-1)); return; }
        if (k === "0") { e.preventDefault(); setScale(resetScale()); return; }

        // Workspace navigation, and the reason it carries a modifier: these
        // have to work while the caret sits in the chat composer or a commit
        // message, where a bare letter is just a letter.
        // The user's rail order, not the shipped one: the rail labels each
        // icon with the number that reaches it, and a tooltip that stops being
        // true after a reorder is worse than no tooltip.
        const railIds = loadViewOrder().map((v) => v.id);
        if (k === "[" || k === "]") {
          e.preventDefault();
          setWsView((cur) => {
            const i = railIds.indexOf(cur);
            return railIds[(i + (k === "]" ? 1 : railIds.length - 1)) % railIds.length]!;
          });
          setWsOpen(true);
          return;
        }
        if (k === "\\") { e.preventDefault(); setWsOpen((o) => !o); return; }
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
        setSelected(null);
        setPaletteOpen(false);
        setHelpOpen(false);
        setStatsOpen(false);
        setSkillsOpen(false);
        setWsOpen(false);
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
      // instead of behavioural. Inside the workspace, navigation carries a
      // modifier — ⌘1..5, ⌘\, ⌘[/] — which no shell will ever consume, and the
      // rail is a click away.
      const canNavigate = focusFree && !anyPanelOpenRef.current && !wsOpenRef.current;
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
        setWsView(view);
        setWsOpen(true);
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

      <Header
        conn={conn}
        windowMs={windowMs}
        onWindow={setWindowMs}
        apps={opts.source_apps}
        types={opts.hook_event_types}
        providers={providers}
        filter={filter}
        onFilter={setFilter}
        theme={theme}
        onTheme={setTheme}
        sound={sound}
        onSound={() => setSound((s) => !s)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenStats={() => setStatsOpen(true)}
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenWorkspace={() => setWsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onClear={clearFilters}
        showUsage={showUsage}
        workspace={workspace}
        onOpenProject={() => setProjectOpen(true)}
      />

      <main className="flex-1 min-h-0 p-3 flex flex-col gap-3 overflow-auto tall:overflow-hidden">
        <div className="shrink-0">
          <Kpis stats={stats} agents={agents} startedAt={startedAt} epm={epm} />
        </div>

        {/* Cockpit — fills the viewport on a tall screen; on short laptops it
            keeps readable panel heights and the page scrolls instead. */}
        <div className="shrink-0 min-h-0 tall:flex-1 grid grid-cols-1 xl:grid-cols-12 gap-3">
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[420px] xl:h-[520px] tall:h-auto">
            <Fleet agents={agents} activeApp={filter.app} onSelect={(a) => setSessionView({ id: a.session_id, app: a.source_app })} />
          </div>

          {/* Phones: auto-height rows with fixed chart/feed heights — the
              desktop 520px box clipped Throughput/ToolMix to slivers. */}
          <div className="xl:col-span-6 min-w-0 min-h-0 grid grid-rows-[auto_400px] sm:grid-rows-[minmax(0,150px)_minmax(0,1fr)] gap-3 h-auto sm:h-[520px] tall:h-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 auto-rows-[150px] sm:auto-rows-auto gap-3 min-w-0 min-h-0">
              <Throughput events={visibleEvents} />
              <ToolMix events={visibleEvents} />
            </div>
            <div className="min-w-0 min-h-0">
              <Feed events={events} filter={filter} sessionProvider={sessionProvider} onSelect={setSelected} onClearFilter={clearFilters} />
            </div>
          </div>

          <div className="xl:col-span-3 min-w-0 min-h-0 grid grid-rows-[3fr_2fr] gap-3 h-[420px] xl:h-[520px] tall:h-auto">
            <Radar agents={agents} onSelect={(a) => setFilter((f) => ({ ...f, app: a.source_app }))} />
            <Alerts alerts={alerts} agents={agents} onSelectApp={(app) => setFilter((f) => ({ ...f, app }))} />
          </div>
        </div>

        {/* Money row — pinned */}
        <div className="shrink-0 grid grid-cols-1 xl:grid-cols-3 gap-3 h-auto xl:h-[196px]">
          <CostByModel stats={stats} />
          <Latency stats={stats} />
          <Sessions provider={filter.provider} />
        </div>

        {/* Mission timeline — pinned */}
        <div className="shrink-0 h-[140px]">
          <MissionTimeline stats={stats} />
        </div>
      </main>

      <EventModal event={selected} onClose={() => setSelected(null)} />
      <StatsModal open={statsOpen} onClose={() => setStatsOpen(false)} stats={stats} windowMs={windowMs} />
      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      <Workspace open={wsOpen} view={wsView} onView={setWsView} onClose={() => setWsOpen(false)} chatFocusId={chatFocus} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onSelectApp={(app) => setFilter((f) => ({ ...f, app }))} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sound={sound}
        onSound={() => setSound((s) => !s)}
        scale={scale}
        onZoom={zoom}
        onOpenStats={() => setStatsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
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
          setWsView("chat");
          setWsOpen(true);
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
        onChanges={() => { setWsView("diff"); setWsOpen(true); }}
        onGit={() => { setWsView("git"); setWsOpen(true); }}
        onDocker={() => { setWsView("docker"); setWsOpen(true); }}
        onTerminal={() => { setWsView("term"); setWsOpen(true); }}
        onChat={() => { setWsView("chat"); setWsOpen(true); }}
        onSearch={() => setSearchOpen(true)}
        onClear={clearFilters}
        onZoom={zoom}
      />
      <HelpLegend open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ProjectPicker open={projectOpen} workspace={workspace} onClose={() => setProjectOpen(false)} />
    </div>
  );
}
