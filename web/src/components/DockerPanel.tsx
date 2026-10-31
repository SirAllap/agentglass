// Docker as a workspace view: the shell. What it shows is decided in lib/docker*.ts
// and drawn in components/docker/; this owns the state that crosses them (the
// section, the layout, the selection) and the keyboard. Data arrives from Docker's
// event stream (useDockerData), so nothing here runs on a timer.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SCROLLBAR_CSS } from "./diff/DiffLines.tsx";
import { ConsoleStrip, consoleRoot, runInConsole } from "./TerminalPanel.tsx";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { ICON } from "../lib/iconSize.ts";
import { TerminalIcon } from "../lib/glyphIcons.tsx";
import { Detail, type DetailSection } from "./docker/Detail.tsx";
import { Images } from "./docker/Images.tsx";
import { Networks } from "./docker/Networks.tsx";
import { Volumes } from "./docker/Volumes.tsx";
import { ResourceError, ResourceSkeleton } from "./docker/ResourceKit.tsx";
import { RESOURCE_CSS } from "./docker/resourceCss.ts";
import { Disk } from "./docker/Disk.tsx";
import { HAS_BROWSER } from "../lib/desktop.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { requestBrowserNav } from "../lib/browserNav.ts";
import { displayName, type MenuItem, type RowVerb } from "../lib/dockerState.ts";
import type { Answer } from "../lib/dockerTriage.ts";
import {
  freshness, groupsView, LAYOUT_KEY, navCounts, portCell, readLayout, scopeLine, situation, stepOf,
  type GroupBy, type Layout,
} from "../lib/dockerView.ts";
import { useDockerData } from "../lib/useDockerData.ts";
import { useDiskData } from "../lib/useDiskData.ts";
import { api } from "../lib/api.ts";
import { analyzeGate, analyzePrompt, analyzeTitle } from "../lib/dockerAnalyze.ts";
import { askBuilderOnBench } from "../lib/lanternAsk.ts";
import { DOCKER_CSS } from "./docker/dockerCss.ts";
import { DockerHeader } from "./docker/Header.tsx";
import { Navigator, type View } from "./docker/Navigator.tsx";
import { ContainersList } from "./docker/ContainersList.tsx";
import { SplitList } from "./docker/SplitList.tsx";
import { DaemonBanner, DaemonCard, EmptyCard, ListSkeleton, NotInstalled } from "./docker/States.tsx";
import { useDockerActions } from "./docker/useDockerActions.ts";
import { useDetailData } from "./docker/useDetailData.ts";

/** Which stacks you left collapsed. Per machine, not per project. */
const STACKS_OPEN_KEY = "agx.docker.stacksOpen";
/** Stack or worktree: a way of thinking rather than a thing you toggle while you work. */
const GROUP_KEY = "agx.docker.groupBy";
const DENSITY_KEY = "agentglass.docker.dense";
const CONSOLE_KEY = "agentglass.docker.console";
/** The docker command each list view reads, for its error card. */
const LIST_CMD = { images: "image ls", volumes: "volume ls", networks: "network ls", disk: "system df" } as const;

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };

export function DockerView({ active, onOpenBrowser }: {
  active: boolean;
  /** Bring the browser view forward. Absent on the phone and in the web build,
   *  where a port opens in the real browser instead. */
  onOpenBrowser?: () => void;
}) {
  const { ask, dialog } = useDialogs();
  const { ov, good, failed, liveDown, stats, cap, refreshing, refresh, loadCapability, changed } = useDockerData(active);
  const { busy, toast, flash, act, group } = useDockerActions();
  const splitW = useSidebarWidth(300);
  const frameRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View>("containers");
  // Images (worktree gone), Volumes (sizes) and Disk all read the same `system df`.
  const disk = useDiskData(active && (view === "images" || view === "volumes" || view === "disk"), changed.images + changed.volumes);
  const [layout, setLayoutState] = useState<Layout>(() => readLayout(read));
  const [groupBy, setGroupByState] = useState<GroupBy>(() => (read(GROUP_KEY) === "worktree" ? "worktree" : "stack"));
  const [dense, setDense] = useState(() => read(DENSITY_KEY) === "1");
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(read(STACKS_OPEN_KEY) || "{}") as Record<string, boolean>; } catch { return {}; }
  });
  const [selId, setSelId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; verb: "stop" | "rm" } | null>(null);
  const [sections, setSections] = useState<Record<DetailSection, boolean>>({ env: false, config: false, top: false, compare: false });
  const [tail, setTail] = useState(200);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleH, setConsoleH] = useState<number>(() => Math.min(0.85, Math.max(0.08, Number(read(CONSOLE_KEY)) || 0.1)));
  useEffect(() => write(CONSOLE_KEY, String(consoleH)), [consoleH]);
  useEffect(() => write(DENSITY_KEY, dense ? "1" : "0"), [dense]);
  useEffect(() => { if (active) requestAnimationFrame(() => frameRef.current?.focus()); }, [active]);

  const sit = situation({ cap, ov, good, liveDown, failed });
  const all = good?.containers ?? [];
  const readOnly = good ? !good.writeEnabled : false;
  const groups = useMemo(() => groupsView(all, { groupBy, q, answer, open: openMap }), [all, groupBy, q, answer, openMap]);
  const split = layout === "split";
  // What j/k walks: what is on screen, so a folded stack is skipped.
  const order = useMemo(() => groups.flatMap((g) => (split || !g.folded ? g.containers : [])).map((c) => c.id), [groups, split]);
  const selected = all.find((c) => c.id === selId) ?? (split ? all.find((c) => c.id === order[0]) : undefined) ?? null;
  const detailShown = view === "containers" && !!selected && (split || detailOpen);
  const step = stepOf(order, selected?.id ?? null);
  const detail = useDetailData(selected?.id, sections);
  const down = sit === "down";

  // Which agent "Analyze with agent" will run, for its tooltip. Read when the view opens; the setting does not change under it.
  const [agentName, setAgentName] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  useEffect(() => {
    if (!active) return;
    void api.workerRoles().then((w) => setAgentName(w.providers?.find((p) => p.id === w.roles?.builder?.provider)?.title ?? null)).catch(() => {});
  }, [active]);
  const gate = analyzeGate({ readOnly, situation: sit });
  const analyze = async () => {
    const cwd = good?.scope?.workspace;
    if (!good || !cwd) { flash(false, "No project is open to analyze"); return; }
    setAnalyzing(true);
    const r = await askBuilderOnBench(cwd, analyzePrompt({
      project: good.scope?.project ?? "", workspace: cwd, containers: good.containers, images: good.images,
      volumes: good.volumes, networks: good.networks.length, disk: disk.d,
    }), "docker cleanup").catch((e) => ({ ok: false, error: String(e) }));
    setAnalyzing(false);
    flash(r.ok, r.ok ? "Opened in a new tab" : r.error ?? "Could not open the agent");
  };

  const setLayout = (l: Layout) => { setLayoutState(l); write(LAYOUT_KEY, l); setDetailOpen(false); };
  const setGroupBy = (g: GroupBy) => { setGroupByState(g); write(GROUP_KEY, g); };
  const toggleGroup = useCallback((key: string, folded: boolean) => {
    setOpenMap((cur) => { const next = { ...cur, [key]: folded }; write(STACKS_OPEN_KEY, JSON.stringify(next)); return next; });
  }, []);
  const open = (id: string) => { setSelId(id); setDetailOpen(true); };
  const close = () => { setDetailOpen(false); requestAnimationFrame(() => frameRef.current?.focus()); };
  const closeConsole = useCallback(() => { setConsoleOpen(false); requestAnimationFrame(() => frameRef.current?.focus()); }, []);

  // In a port's own tab when this app has one, else the real browser.
  const openPort = useCallback((url: string) => {
    if (HAS_BROWSER && onOpenBrowser) { requestBrowserNav(url); onOpenBrowser(); return; }
    openExternal(url);
  }, [onOpenBrowser]);

  // Stop and Remove ask first. Under the row when the row is on screen; in a dialog when it is not.
  const request = async (c: (typeof all)[number], verb: "start" | "stop" | "restart" | "unpause" | "rm") => {
    if (readOnly || down) return;
    if (verb === "stop" || verb === "rm") {
      if (view === "containers" && !split && !detailShown) { setConfirm({ id: c.id, verb }); return; }
      const sure = await ask({
        title: `${verb === "rm" ? "Remove" : "Stop"} ${displayName(c)}?`, danger: verb === "rm", confirmLabel: verb === "rm" ? "Remove" : "Stop",
        ...(verb === "rm" ? { body: "Its volumes stay." } : {}),
      });
      if (!sure) return;
    }
    await act(c, verb);
    if (verb === "rm" && selId === c.id) { setSelId(null); setDetailOpen(false); }
  };
  const onRowConfirm = (yes: boolean) => {
    const c = confirm && all.find((x) => x.id === confirm.id);
    const verb = confirm?.verb;
    setConfirm(null);
    if (yes && c && verb) void act(c, verb).then(() => { if (verb === "rm" && selId === c.id) setSelId(null); });
  };
  const onMenuPick = (c: (typeof all)[number], verb: MenuItem["verb"]) => {
    if (verb === "logs") open(c.id);
    else if (verb === "insp") { setSelId(c.id); setDetailOpen(true); setSections((s) => ({ ...s, config: true })); }
    else if (verb === "shell") {
      setConsoleOpen(true);
      runInConsole(consoleRoot(), `docker exec -it ${c.id.slice(0, 12)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`);
    } else if (verb === "open") { const url = portCell(c).url; if (url) openPort(url); }
    else if (verb === "unpause" || verb === "stop" || verb === "rm") void request(c, verb);
  };

  const move = (dir: 1 | -1) => {
    if (!order.length) return;
    const at = order.indexOf(selected?.id ?? "");
    const next = order[at < 0 ? (dir === 1 ? 0 : order.length - 1) : (at + dir + order.length) % order.length];
    if (next) {
      setSelId(next);
      requestAnimationFrame(() => frameRef.current?.querySelector('[aria-selected="true"], [data-sel="true"]')?.scrollIntoView({ block: "nearest" }));
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (/input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "") || view !== "containers" || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      if (confirm) { e.preventDefault(); setConfirm(null); } else if (detailOpen) { e.preventDefault(); close(); }
    } else if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && e.target === e.currentTarget && selected && !split) { e.preventDefault(); setDetailOpen(true); }
    else if (selected && (k === "r" || k === "s")) {
      const running = (selected.state || "").toLowerCase() === "running";
      if (k === "r" && running) { e.preventDefault(); void request(selected, "restart"); }
      else if (k === "s") { e.preventDefault(); void request(selected, running ? "stop" : "start"); }
    }
  };

  // The pill on an image or a network is a container: show it in Containers.
  const goContainer = (id: string) => { setView("containers"); setQ(""); setAnswer(null); setSelId(id); setDetailOpen(true); };
  const sizes = useMemo(() => (disk.d ? Object.fromEntries(disk.d.volumes_.map((v) => [v.name, v.bytes])) : null), [disk.d]);
  const onTry = () => { loadCapability(); void refresh(); };
  const lead = (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {sit === "loading" ? (view === "containers" ? <ListSkeleton /> : <ResourceSkeleton what={view} />)
        : down && !good ? (view === "containers" ? <DaemonCard error={ov?.error} onTry={onTry} />
          : <ResourceError what={view} cmd={LIST_CMD[view]} error={ov?.error} onTry={onTry} />)
        : !good ? null
        : view === "containers" ? (sit === "empty"
          ? <EmptyCard all={!!good.scope?.showingAll} project={good.scope?.project} onConsole={() => setConsoleOpen(true)} />
          : split ? splitPane() : detailShown && selected ? detailPane() : listPane())
        : <>
          {down && <div style={{ padding: "12px 18px 0" }}><DaemonBanner error={ov?.error} onTry={onTry} /></div>}
          {view === "disk" ? <Disk state={disk} images={good.images} writeEnabled={!readOnly} flash={flash} />
            : view === "images" ? <Images images={good.images} containers={all} orphans={disk.d?.orphans ?? []} q={q} readOnly={readOnly || down}
                flash={flash} onClear={() => setQ("")} onGoContainer={goContainer} onShowDisk={() => setView("disk")} />
            : view === "volumes" ? <Volumes volumes={good.volumes} containers={all} sizes={sizes} sizeError={disk.error} q={q} readOnly={readOnly || down}
                flash={flash} onClear={() => setQ("")} onGoContainer={goContainer} />
            : <Networks networks={good.networks} containers={all} q={q} readOnly={readOnly || down} flash={flash} onClear={() => setQ("")} onGoContainer={goContainer} />}
        </>}
    </div>
  );

  function listPane() {
    return (
      <ContainersList all={all} groups={groups} stats={stats} readOnly={readOnly} busy={busy} dense={dense} selected={selected?.id ?? null}
        answer={answer} onAnswer={setAnswer} groupBy={groupBy} q={q} onClearQ={() => setQ("")}
        confirm={confirm} onRowConfirm={onRowConfirm} onOpen={open} onVerb={(c, v: RowVerb) => void request(c, v)}
        onMenuPick={onMenuPick} onGroup={(verb, ids) => void group(all.filter((c) => ids.includes(c.id)), verb)}
        onToggleGroup={toggleGroup} onOpenPort={openPort}
        down={down ? { error: ov?.error, at: good?.at } : null} onTry={onTry} />
    );
  }
  function detailPane() {
    const c = selected!;
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <Detail c={c} stat={stats[c.id]} env={detail.env} config={detail.config} top={detail.top} error={detail.error}
          readOnly={readOnly || down} tail={tail} onTail={setTail} onOpenPort={openPort}
          open={sections} onToggle={(id) => setSections((s) => ({ ...s, [id]: !s[id] }))} others={all}
          bar={{
            step, showStep: !split, readOnly: readOnly || down, busy: busy === c.id, onStep: (id) => setSelId(id),
            onVerb: (v) => void request(c, v), onMenuPick: (v) => onMenuPick(c, v),
          }} />
      </div>
    );
  }
  function splitPane() {
    return (
      <div className={`flex-1 min-h-0 flex${down ? " dk-dimmed" : ""}`}>
        <div className="shrink-0 flex flex-col" style={{ width: splitW }}>
          <SplitList groups={groups} stats={stats} selected={selected?.id ?? null} answer={answer} onSelect={setSelId} onClearAnswer={() => setAnswer(null)} />
        </div>
        <SidebarGrip />
        {selected ? detailPane() : <div className="flex-1 grid place-items-center t-dim2 text-[12px]">No container selected</div>}
      </div>
    );
  }

  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey} className="dk-root flex-1 min-h-0 flex flex-col outline-none overflow-hidden relative">
      <style>{SCROLLBAR_CSS}</style>
      <style>{DOCKER_CSS}</style>
      <style>{RESOURCE_CSS}</style>
      <DockerHeader situation={sit} version={good?.version ?? null}
        fresh={freshness({ situation: sit, at: good?.at, lastGoodAt: good?.at, now: Date.now() })}
        scope={scopeLine(good?.scope, all.length)} q={q} onQ={setQ} groupBy={groupBy} onGroupBy={setGroupBy}
        layout={layout} onLayout={setLayout} dense={dense} onDense={() => setDense((v) => !v)}
        readOnly={readOnly} onRefresh={() => void refresh()} refreshing={view === "disk" ? disk.measuring : refreshing} section={view}
        onMeasure={() => void disk.measure(true)}
        analyze={{ onClick: () => void analyze(), disabled: gate.disabled, pending: analyzing, title: gate.disabled ? gate.reason : analyzeTitle(agentName) }}
        showFilter={view !== "disk"} showView={view === "containers"} back={detailOpen && !split && view === "containers" ? close : null} />
      {sit === "notinstalled" ? <NotInstalled reason={cap?.reason} onCheck={loadCapability} /> : (
        <div className="flex-1 min-h-0 flex">
          <Navigator section={view} counts={navCounts(good)} onPick={(v) => { setView(v); setDetailOpen(false); }} />
          {lead}
        </div>
      )}
      <ConsoleStrip root={consoleRoot()} open={consoleOpen} height={consoleH} onHeight={setConsoleH} onClose={closeConsole} />
      {good && view === "containers" && (
        <div className="dk-dock">
          <button type="button" className="dk-chip sm" onClick={() => (consoleOpen ? closeConsole() : setConsoleOpen(true))}
            title="A shell in this project, docked under the logs. It keeps running while you look around.">
            <TerminalIcon size={ICON.xs} />Console
          </button>
          <span className="mut">A shell in this project, docked under the view. It keeps running while you look around.</span>
          <span className="cr"><i className="dk-live" />Live: changes arrive from Docker's event stream</span>
        </div>
      )}
      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg text-[11px] shadow-xl" style={{ zIndex: 40, background: "var(--bg3)", border: `1px solid ${toast.ok ? "color-mix(in srgb, var(--success) 50%, transparent)" : "color-mix(in srgb, var(--error) 50%, transparent)"}`, color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</div>
      )}
      {dialog}
    </div>
  );
}
