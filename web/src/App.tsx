import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WatchEvent } from "../../shared/types.ts";
import { useLive } from "./lib/useLive.ts";
import { useStats } from "./lib/useStats.ts";
import { deriveAgents, deriveAlerts } from "./lib/derive.ts";
import { providerOf } from "./lib/format.ts";
import { api, IS_DEMO } from "./lib/api.ts";
import { initialTheme, applyTheme } from "./lib/themes.ts";
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
import { ChangesModal } from "./components/ChangesModal.tsx";
import { GitPanel } from "./components/GitPanel.tsx";
import { DockerPanel } from "./components/DockerPanel.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { newChat, chatResuming } from "./lib/chatStore.ts";
import { SearchModal } from "./components/SearchModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { SessionModal } from "./components/SessionModal.tsx";
import { ProjectPicker, PICKER_ANSWERED_KEY } from "./components/ProjectPicker.tsx";

export default function App() {
  const { events, conn, lastEvent, openTools } = useLive();
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [filter, setFilter] = useState({ app: "", type: "", provider: "" });
  const [theme, setTheme] = useState(initialTheme());
  const [opts, setOpts] = useState<{ source_apps: string[]; hook_event_types: string[] }>({ source_apps: [], hook_event_types: [] });
  const [selected, setSelected] = useState<WatchEvent | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [dockerOpen, setDockerOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatFocus, setChatFocus] = useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionView, setSessionView] = useState<{ id: string; app: string } | null>(null);
  const [sound, setSound] = useState(false);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const mountedAt = useRef(Date.now());

  // A live snapshot of "is any panel/overlay open", read by the global key
  // handler so single-letter shortcuts can't stack a second panel on top of an
  // open one. Kept in a ref so the handler needn't re-subscribe on every toggle.
  const anyPanelOpen =
    paletteOpen || helpOpen || statsOpen || skillsOpen || changesOpen ||
    gitOpen || dockerOpen || terminalOpen || chatOpen || searchOpen ||
    projectOpen || sessionView !== null || selected !== null;
  const anyPanelOpenRef = useRef(anyPanelOpen);
  anyPanelOpenRef.current = anyPanelOpen;

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

  // Filter options change rarely (a new app/event type) — poll slowly.
  useEffect(() => {
    const load = () => api.filterOptions().then(setOpts).catch(() => {});
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
  const agentsAll = useMemo(() => deriveAgents(events, openTools), [events, openTools, tick]);
  const sessionProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentsAll) if (a.model_name) map.set(a.session_id, providerOf(a.model_name));
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
        ? deriveAgents(visibleEvents, openTools.filter((s) => sessionProvider.get(s.session_id) === filter.provider))
        : agentsAll,
    [filter.provider, visibleEvents, agentsAll, openTools, sessionProvider]
  );
  const alerts = useMemo(() => deriveAlerts(agents), [agents]);
  useAlertSound(alerts.length, sound);

  const clearFilters = useCallback(() => setFilter({ app: "", type: "", provider: "" }), []);

  // Keyboard shortcuts: ⌘K / Ctrl-K palette, ? help, single-letter panels, Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl-K palette — always available, even inside a field or panel.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
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
        setChangesOpen(false);
        setGitOpen(false);
        setDockerOpen(false);
        setTerminalOpen(false);
        setChatOpen(false);
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
      if (!focusFree || anyPanelOpenRef.current) return;

      switch (e.key) {
        case "?": setHelpOpen((o) => !o); break;
        case "s": e.preventDefault(); setStatsOpen((o) => !o); break;
        case "k": e.preventDefault(); setSkillsOpen((o) => !o); break;
        case "d": e.preventDefault(); setChangesOpen((o) => !o); break;
        case "g": e.preventDefault(); setGitOpen((o) => !o); break;
        case "o": e.preventDefault(); setDockerOpen((o) => !o); break;
        case "t": e.preventDefault(); setTerminalOpen((o) => !o); break;
        case "c": e.preventDefault(); setChatOpen((o) => !o); break;
        case "/": e.preventDefault(); setSearchOpen((o) => !o); break;
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
        onOpenChanges={() => setChangesOpen(true)}
        onOpenGit={() => setGitOpen(true)}
        onOpenDocker={() => setDockerOpen(true)}
        onOpenTerminal={() => setTerminalOpen(true)}
        onOpenChat={() => setChatOpen(true)}
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
            <Alerts alerts={alerts} onSelectApp={(app) => setFilter((f) => ({ ...f, app }))} />
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
      <ChangesModal open={changesOpen} onClose={() => setChangesOpen(false)} />
      <GitPanel open={gitOpen} onClose={() => setGitOpen(false)} />
      <DockerPanel open={dockerOpen} onClose={() => setDockerOpen(false)} />
      <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} />
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} focusId={chatFocus} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onSelectApp={(app) => setFilter((f) => ({ ...f, app }))} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sound={sound}
        onSound={() => setSound((s) => !s)}
        onOpenStats={() => setStatsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
      />
      <SessionModal
        sessionId={sessionView?.id ?? null}
        sourceApp={sessionView?.app}
        onClose={() => setSessionView(null)}
        onFilter={(app) => setFilter((f) => ({ ...f, app }))}
        onResume={(s) => {
          if (!s.project_path) return;
          // Reuse an open tab for the same session rather than starting a
          // second one: two chats resuming one id would both write to it.
          const existing = chatResuming(s.session_id);
          const chat = existing ?? newChat(s.project_path, s.model_name || undefined, undefined, {
            sessionId: s.session_id,
            title: s.summary?.slice(0, 40) || `${s.source_app}:${s.session_id.slice(0, 8)}`,
          });
          setChatFocus(chat.id);
          setChatOpen(true);
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
        onChanges={() => setChangesOpen(true)}
        onGit={() => setGitOpen(true)}
        onDocker={() => setDockerOpen(true)}
        onTerminal={() => setTerminalOpen(true)}
        onChat={() => setChatOpen(true)}
        onSearch={() => setSearchOpen(true)}
        onClear={clearFilters}
      />
      <HelpLegend open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ProjectPicker open={projectOpen} workspace={workspace} onClose={() => setProjectOpen(false)} />
    </div>
  );
}
