// Live Docker — agentglass's lazydocker replacement. Containers grouped by
// compose project with live CPU/mem, a streaming-ish log viewer, and start/
// stop/restart/rm actions. Images / volumes / networks get their own tabs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import type { DockerOverview, DockerContainer, DockerStat, DockerCapability } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { Select } from "./Select.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./ChangesModal.tsx";
import { ConsoleStrip, consoleRoot, runInConsole } from "./TerminalPanel.tsx";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";

// Strip ANSI CSI (colors, cursor moves, erases) + OSC sequences, not just SGR.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex
const stripAnsi = (s: string) => s.replace(ANSI, "");

const STATE_TINT: Record<string, string> = {
  running: "var(--success)", exited: "var(--text3)", paused: "var(--warning)",
  restarting: "var(--warning)", created: "var(--info)", dead: "var(--error)", removing: "var(--error)",
};
type View = "containers" | "images" | "volumes" | "networks";

function Bar({ pct, tint }: { pct: number; tint: string }) {
  return (
    <div className="w-9 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
      <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: tint }} />
    </div>
  );
}

/**
 * Container logs, coloured by what each line is.
 *
 * Monochrome output is a wall: the one ERROR you opened the panel for sits in
 * three hundred identical grey lines. This is a level pass, not a syntax
 * highlighter — the structure that matters in a log is severity and time, and
 * a tokeniser would spend far more to say less.
 *
 * Timestamps are dimmed rather than dropped: they are the one column you scan
 * by, and at full contrast they compete with the message they belong to.
 */
const LEVEL_TINT: [RegExp, string][] = [
  [/\b(ERROR|ERR|FATAL|CRITICAL|PANIC|Traceback|Exception)\b/, "var(--error)"],
  [/\b(WARN|WARNING|DeprecationWarning|FutureWarning)\b/, "var(--warning)"],
  [/\b(INFO|NOTICE)\b/, "var(--info)"],
  [/\b(DEBUG|TRACE)\b/, "var(--text3)"],
];
// Leading ISO-ish stamp, which is what docker prepends with --timestamps.
const STAMP = /^(\S*\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s?/;

function LogLine({ line }: { line: string }) {
  const m = STAMP.exec(line);
  const stamp = m?.[1];
  const rest = stamp ? line.slice(m![0].length) : line;
  const tint = LEVEL_TINT.find(([re]) => re.test(rest))?.[1];
  return (
    <div style={tint ? { color: tint } : undefined}>
      {stamp && <span style={{ color: "var(--text4)", opacity: 0.55 }}>{stamp} </span>}
      {rest}
    </div>
  );
}

/** One container action. Sized and bordered like every other control in the
 *  app, so a row of them reads as a row of buttons. */
function DockerAction({ onClick, disabled, tint, title, children }: {
  onClick: () => void; disabled: boolean; tint: string; title: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="w-[22px] h-[22px] grid place-items-center rounded-md text-[10px] leading-none transition-colors disabled:opacity-30"
      style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`, background: `color-mix(in srgb, ${tint} 8%, transparent)` }}
      onMouseEnter={(e) => { e.currentTarget.style.background = `color-mix(in srgb, ${tint} 24%, transparent)`; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = `color-mix(in srgb, ${tint} 8%, transparent)`; }}
    >{children}</button>
  );
}


/**
 * One section of the stacked left column.
 *
 * The header stays put whether or not the body is open, which is the whole
 * point: tabs hid the fact that there were images at all until you went
 * looking, and "is anything dangling?" should be answerable without leaving the
 * container you are watching.
 */
function Stack({ id, label, n, open, active, onToggle, onActivate, children }: {
  id: View; label: string; n: number; open: boolean; active: boolean;
  onToggle: (id: View) => void; onActivate: (id: View) => void; children: React.ReactNode;
}) {
  return (
    <div className="mb-1 shrink-0">
      <button
        onClick={() => { onActivate(id); onToggle(id); }}
        className="w-full flex items-center gap-2 px-2.5 py-1 sticky top-0 z-20 text-left"
        style={{ background: "var(--bg2)", borderLeft: `2px solid ${active ? "var(--primary)" : "transparent"}` }}
        aria-expanded={open}>
        <span className="text-[8px] t-dim2 w-2 shrink-0">{open ? "▾" : "▸"}</span>
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: active ? "var(--text)" : "var(--text2)" }}>{label}</span>
        <span className="text-[9px] t-dim2 tabular-nums">{n}</span>
      </button>
      {open && children}
    </div>
  );
}

/** A one-line entry in the sections that are not containers. */
function StackRow({ label, meta, dim, onClick }: { label: string; meta?: string; dim?: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} title={label}
      className="flex items-center gap-2 pl-6 pr-2 py-[3px] cursor-pointer rounded-md"
      style={{ opacity: dim ? 0.5 : 1 }}>
      <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: "var(--text2)" }}>{label}</span>
      {meta && <span className="text-[9px] t-dim2 shrink-0 tabular-nums">{meta}</span>}
    </div>
  );
}

function ContainerRow({ c, stat, active, writeEnabled, busy, dense, onSelect, onAction }: {
  c: DockerContainer; stat?: DockerStat; active: boolean; writeEnabled: boolean; busy: boolean;
  dense: boolean;
  onSelect: () => void; onAction: (verb: "start" | "stop" | "restart" | "rm") => void;
}) {
  const running = c.state === "running";
  // The first published port, which is the one you actually reach the service
  // on. The full list is in the tooltip; the row is not a table.
  const port = /(\d+)->/.exec(c.ports || "")?.[1];
  return (
    <div onClick={onSelect} data-cid={active ? "active" : undefined}
      className={`group grid items-center gap-x-2 pl-2 pr-1.5 rounded-md cursor-pointer ${dense ? "py-[2px]" : "py-1"}`}
      // A grid, not a flex row: every container's numbers line up in the same
      // columns, which is what makes a list of twelve scannable instead of
      // twelve individually-arranged lines. lazydocker does the same.
      style={{
        gridTemplateColumns: "10px minmax(0,1fr) 46px 46px 52px 50px",
        background: active ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent",
      }}
      title={`${c.name}\n${c.image}\n${c.status}${c.ports ? `\n${c.ports}` : ""}`}>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATE_TINT[c.state] ?? "var(--text3)" }} />

      <span className="min-w-0 flex flex-col leading-tight">
        <span className="truncate text-[11.5px]" style={{ color: active ? "var(--text)" : "var(--text2)" }}>{c.service || c.name}</span>
        {/* The image was competing with the name on one line and both lost.
            Underneath, dimmer, it reads as what it is — provenance, not
            identity. In dense mode it goes back to the tooltip, which is the
            trade: half the rows, one less thing per row. */}
        {!dense && <span className="truncate text-[9px] t-dim2">{c.image}</span>}
      </span>

      {/* Numbers, not two unlabelled bars. A bar with no scale and no figure
          says "something is happening"; 0.24% says which container is busy. */}
      <span className="text-[9.5px] tabular-nums text-right" style={{ color: stat && running && stat.cpu >= 50 ? "var(--warning)" : "var(--text3)" }}>
        {stat && running ? `${stat.cpu.toFixed(1)}%` : ""}
      </span>
      <span className="text-[9.5px] tabular-nums text-right" style={{ color: stat && running && stat.mem >= 80 ? "var(--warning)" : "var(--text3)" }}
        title={stat ? `memory ${stat.mem}% (${stat.memUsage})` : undefined}>
        {stat && running ? `${stat.mem.toFixed(0)}%` : ""}
      </span>
      <span className="text-[9px] tabular-nums truncate" style={{ color: running ? "var(--info)" : "var(--text4)" }}>
        {/* A stopped container has no numbers, and three blank columns read as
            missing data rather than as "this is not running". */}
        {running ? (port ? `:${port}` : "") : c.state}
      </span>

      {/* Real buttons, not floating glyphs. Bare icons at 45% opacity read as
          decoration — they had no edge, no hit area you could see, and an
          emoji bin sitting next to line-art squares. Each one is now a chip
          with a border and a tinted hover, the same language every other
          control in the app uses, so it is obvious they can be pressed and
          obvious where. */}
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {writeEnabled && (running
          ? <>
              <DockerAction onClick={() => onAction("restart")} disabled={busy} tint="var(--warning)" title="Restart">⟳</DockerAction>
              <DockerAction onClick={() => onAction("stop")} disabled={busy} tint="var(--error)" title="Stop">■</DockerAction>
            </>
          : <>
              <DockerAction onClick={() => onAction("start")} disabled={busy} tint="var(--success)" title="Start">▶</DockerAction>
              <DockerAction onClick={() => onAction("rm")} disabled={busy} tint="var(--error)" title="Remove this container">✕</DockerAction>
            </>)}
      </div>
    </div>
  );
}


/** Docker as a workspace view. `active` means "visible right now" — the view
 *  stays mounted while you're off in the diff, it just stops polling. */
const CONSOLE_KEY = "agentglass.docker.console";

type DetailTab = "logs" | "info" | "env" | "config" | "top";
const DETAIL_TABS: DetailTab[] = ["logs", "info", "env", "config", "top"];

const SECTIONS_KEY = "agentglass.docker.sections";
// Containers open, the rest closed: with 40 images the column is unusable if
// everything starts expanded, and the counts on the headers already answer the
// question most of the time.
const SECTIONS_DEFAULT: Record<View, boolean> = { containers: true, images: false, volumes: false, networks: false };

const DENSITY_KEY = "agentglass.docker.dense";


/**
 * Env, config and top — the read-only tabs.
 *
 * Env is rendered as key/value rather than the raw `KEY=value` strings docker
 * hands back, because the value is the part you are looking for and it is
 * routinely a URL long enough to hide the name it belongs to.
 */
function DetailPane({ tab, env, config, top, error }: {
  tab: "env" | "config" | "top";
  env: string[] | null; config: string | null; top: string | null; error: string | null;
}) {
  if (error) return <div className="flex-1 grid place-items-center t-dim2 text-[12px] px-6 text-center">{error}</div>;
  const text = tab === "config" ? config : tab === "top" ? top : null;
  if (tab !== "env" && text == null) return <div className="flex-1 grid place-items-center t-dim2 text-[12px]"><span className="agx-spin" aria-hidden="true" /></div>;
  if (tab === "env") {
    if (!env) return <div className="flex-1 grid place-items-center t-dim2 text-[12px]"><span className="agx-spin" aria-hidden="true" /></div>;
    if (!env.length) return <div className="flex-1 grid place-items-center t-dim2 text-[12px]">This container has no environment set</div>;
    return (
      <div className="agx-scroll flex-1 min-h-0 overflow-auto p-4 text-[11px] flex flex-col gap-1" style={{ color: "var(--text2)" }}>
        {env.map((line, i) => {
          const eq = line.indexOf("=");
          const k = eq === -1 ? line : line.slice(0, eq);
          const v = eq === -1 ? "" : line.slice(eq + 1);
          return (
            <div key={i} className="flex gap-3 min-w-0">
              <span className="shrink-0 tabular-nums" style={{ color: "var(--primary-hover)", minWidth: 180 }}>{k}</span>
              <span className="min-w-0 break-all" style={{ color: "var(--text)" }}>{v}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <pre className="agx-scroll flex-1 min-h-0 overflow-auto text-[11px] leading-[1.55] px-4 py-2 whitespace-pre m-0"
      style={{ ...CODE_FONT_STYLE, background: "var(--bg)", color: "var(--text2)" }}>{text}</pre>
  );
}

/**
 * The binary-missing empty state: install guidance, not the daemon message.
 *
 * The overview reports `available:false` for BOTH a downed daemon and a docker
 * that was never installed, and those two need different words because they need
 * different fixes — "start Docker" versus "install it". When dockerCapability()
 * says the CLI is absent we render this in place of the daemon error; it is the
 * docker sibling of GitMissingBanner.
 */
function DockerMissing({ reason }: { reason?: string }) {
  return (
    <div className="flex-1 grid place-items-center px-6 text-center">
      <div className="max-w-md flex flex-col items-center gap-2">
        <span className="text-[13px] font-semibold" style={{ color: "var(--warning)" }}>Docker isn't installed</span>
        <span className="text-[11.5px]" style={{ color: "var(--text2)" }}>
          {reason || "The docker CLI isn't on your PATH"}. Containers, images, volumes and logs stay empty until it is.
        </span>
        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
          Get it from <code>docker.com/get-started</code> (Docker Desktop), or your package manager:{" "}
          <code>apt install docker.io</code>, <code>brew install docker</code> — then reopen.
        </span>
      </div>
    </div>
  );
}

export function DockerView({ active }: { active: boolean }) {
  // A shell docked under the logs, for the `make migrate` you always end up
  // needing while watching a container. Its height is remembered and it is
  // keyed on the repo, not on the container, so selecting a different one
  // above never disturbs what is running below.
  const sidebarW = useSidebarWidth();
  const { ask, dialog } = useDialogs();
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleH, setConsoleH] = useState<number>(() => {
    try { return Math.min(0.85, Math.max(0.08, Number(localStorage.getItem(CONSOLE_KEY)) || 0.1)); } catch { return 0.1; }
  });
  useEffect(() => { try { localStorage.setItem(CONSOLE_KEY, String(consoleH)); } catch { /* non-fatal */ } }, [consoleH]);
  const [ov, setOv] = useState<DockerOverview | null>(null);
  // Installed vs daemon-down. Only consulted for the missing-binary case, which
  // is stable for the session — the daemon's own up/down still rides on the
  // overview's error. Lets the empty state offer install guidance instead of
  // sending someone to check a daemon they never had.
  const [cap, setCap] = useState<DockerCapability | null>(null);
  const [stats, setStats] = useState<Record<string, DockerStat>>({});
  const [view, setView] = useState<View>("containers");
  const [openSections, setOpenSections] = useState<Record<View, boolean>>(() => {
    try { return { ...SECTIONS_DEFAULT, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}") }; }
    catch { return SECTIONS_DEFAULT; }
  });
  const toggleSection = useCallback((id: View) => {
    setOpenSections((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
      return next;
    });
  }, []);
  // One line per container instead of two. The image drops to the tooltip,
  // which is where it was before it got its own line, and a stack of twelve
  // stops needing a scroll.
  const [dense, setDense] = useState<boolean>(() => { try { return localStorage.getItem(DENSITY_KEY) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(DENSITY_KEY, dense ? "1" : "0"); } catch { /* non-fatal */ } }, [dense]);
  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("logs");
  // Fetched per tab rather than all at once: `top` shells out to the container
  // and `inspect` returns a few hundred KB of JSON, and paying for both every
  // time someone clicks a container to read its logs is the wrong trade.
  const [env, setEnv] = useState<string[] | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [top, setTop] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [tail, setTail] = useState(400);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  /**
   * Closing the console hands the keyboard back to the panel.
   *
   * The strip takes focus the moment it opens — opening a shell is asking to
   * type in it, and it used to cost a click on the black area first. This is
   * the other half of that: without it `j`/`k` would go on being swallowed by
   * a shell that is no longer on screen.
   */
  const closeConsole = useCallback(() => {
    setConsoleOpen(false);
    requestAnimationFrame(() => frameRef.current?.focus());
  }, []);
  const logSeq = useRef(0);          // guards stale log responses
  const stuckBottom = useRef(true);  // only auto-scroll when the user is at the bottom

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 2600); };

  const containers = ov?.containers ?? [];
  const selected = useMemo(() => containers.find((c) => c.id === selId) ?? containers[0] ?? null, [containers, selId]);
  const writeEnabled = ov?.writeEnabled ?? false;

  const loadOverview = useCallback(async () => {
    try { const o = await api.dockerOverview(); setOv(o); if (o.error) flash(false, o.error); }
    catch (e) { flash(false, String(e)); }
  }, []);
  const loadStats = useCallback(async () => {
    try { const { stats } = await api.dockerStats(); const m: Record<string, DockerStat> = {}; for (const s of stats) m[s.id] = s; setStats(m); }
    catch { /* stats are best-effort */ }
  }, []);
  const loadLogs = useCallback(async (id: string, n: number) => {
    const seq = ++logSeq.current; // drop a slow response if the container changed
    try { const r = await api.dockerLogs(id, n); if (seq !== logSeq.current) return; setLogs(r.ok ? stripAnsi(r.text) : (r.error || "No logs")); }
    catch (e) { if (seq === logSeq.current) setLogs(String(e)); }
  }, []);

  // visible → load overview (cheap), then poll every 5s. Gated on `active`
  // rather than on mount: hidden views keep their state but go quiet.
  useEffect(() => {
    if (!active) return;
    setToast(null);
    loadOverview();
    const t = setInterval(loadOverview, 5000);
    requestAnimationFrame(() => frameRef.current?.focus());
    return () => clearInterval(t);
  }, [active, loadOverview]);

  // Is docker even installed? Asked once per activation, not on the 5s poll —
  // a binary doesn't come and go mid-session, and all we take from it is the
  // absent-CLI verdict that swaps the daemon message for install guidance.
  useEffect(() => {
    if (!active) return;
    let live = true;
    api.dockerCapability().then((c) => { if (live) setCap(c); }).catch(() => { /* origin gate / offline — the overview's error still shows */ });
    return () => { live = false; };
  }, [active]);

  // stats: only poll the (slow) `docker stats` sample while viewing containers.
  useEffect(() => {
    if (!active || view !== "containers") return;
    loadStats();
    const t = setInterval(loadStats, 5000);
    return () => clearInterval(t);
  }, [active, view, loadStats]);

  // logs: poll every 3s while a container's log tab is visible. Keyed by id
  // (not the container object) so the 5s overview refresh doesn't restart it.
  useEffect(() => {
    const id = selected?.id;
    if (!active || view !== "containers" || tab !== "logs" || !id) return;
    loadLogs(id, tail);
    const t = setInterval(() => loadLogs(id, tail), 3000);
    return () => clearInterval(t);
  }, [active, view, tab, selected?.id, tail, loadLogs]);

  // keep the log view pinned to the bottom.
  useEffect(() => { const el = logRef.current; if (el && stuckBottom.current) el.scrollTop = el.scrollHeight; }, [logs]);

  // Cleared on selection change so a tab never shows the previous container's
  // environment for the moment before the new one arrives — with two similar
  // stacks that is indistinguishable from the real thing.
  //
  // Keyed on the container actually on screen (`selected`, which falls back to
  // the first row when nothing is clicked), NOT the raw click state `selId`:
  // the detail pane renders off `selected`, so keying the fetch on `selId` left
  // the first container's header showing with an empty env — nothing was ever
  // requested for it because no id had been clicked — and, once a selection
  // vanished from the list, fetched one container's env under another's name.
  useEffect(() => { setEnv(null); setConfig(null); setTop(null); setDetailErr(null); }, [selected?.id]);
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    let live = true;
    if (tab === "env" || tab === "config") {
      if (env && config) return;
      void api.dockerInspect(id).then((r) => {
        if (!live) return;
        if (!r.ok) { setDetailErr(r.error || "docker inspect failed"); return; }
        setEnv(r.env); setConfig(r.config); setDetailErr(null);
      });
    } else if (tab === "top") {
      void api.dockerTop(id).then((r) => {
        if (!live) return;
        if (!r.ok) { setDetailErr(r.error || "Not running"); setTop(null); return; }
        setTop(r.text); setDetailErr(null);
      });
    }
    return () => { live = false; };
  }, [selected?.id, tab, env, config]);

  /**
   * The same verb across a whole compose project.
   *
   * Sequential, not parallel: `docker compose` brings a stack up in dependency
   * order for a reason, and firing twelve starts at once asks the daemon to
   * race a database against the things that need it. Slower, and it works.
   *
   * Reports what actually happened rather than assuming — one container
   * failing to stop while eleven succeed is the case worth naming.
   */
  const doGroupAction = async (cs: DockerContainer[], verb: "start" | "stop" | "restart") => {
    if (busy) return;
    const targets = cs.filter((c) => (verb === "start" ? c.state !== "running" : c.state === "running"));
    if (!targets.length) return;
    if (verb !== "start" && !(await ask({ title: `${verb} ${targets.length} container${targets.length === 1 ? "" : "s"}?`, confirmLabel: verb }))) return;
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      const fn = verb === "start" ? api.dockerStart : verb === "stop" ? api.dockerStop : api.dockerRestart;
      for (const c of targets) {
        try { (await fn(c.id)).ok ? ok++ : failed.push(c.name); }
        catch { failed.push(c.name); }
      }
      flash(!failed.length, failed.length
        ? `${verb}ed ${ok}, failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`
        : `${verb}ed ${ok} container${ok === 1 ? "" : "s"}`);
      await loadOverview(); await loadStats();
    } finally { setBusy(false); }
  };

  const doAction = async (id: string, verb: "start" | "stop" | "restart" | "rm") => {
    if (busy) return;
    if ((verb === "rm" || verb === "stop") && !(await ask({ title: `${verb} this container?`, danger: verb === "rm", confirmLabel: verb }))) return;
    setBusy(true);
    try {
      const fn = verb === "start" ? api.dockerStart : verb === "stop" ? api.dockerStop : verb === "restart" ? api.dockerRestart : api.dockerRm;
      const r = await fn(id);
      flash(r.ok, r.ok ? (r.output || `${verb}ed`) : (r.error || "Failed"));
      await loadOverview(); await loadStats();
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  // group containers by compose project
  const groups = useMemo(() => {
    const m = new Map<string, DockerContainer[]>();
    for (const c of containers) { const k = c.project || "(standalone)"; (m.get(k) ?? m.set(k, []).get(k)!).push(c); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [containers]);
  // visible (grouped) order — so j/k matches what's on screen, not `docker ps` order
  const ordered = useMemo(() => groups.flatMap(([, cs]) => cs), [groups]);

  const moveSel = (dir: 1 | -1) => {
    if (!ordered.length) return;
    const i = Math.max(0, ordered.findIndex((c) => c.id === selected?.id));
    const n = ordered[(i + dir + ordered.length) % ordered.length];
    if (n) { setSelId(n.id); setTab("logs"); requestAnimationFrame(() => frameRef.current?.querySelector('[data-cid="active"]')?.scrollIntoView({ block: "nearest" })); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (/input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "")) return;
    if (view !== "containers" || !selected) return;
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (k === "r" && writeEnabled && selected.state === "running") { e.preventDefault(); doAction(selected.id, "restart"); }
    else if (k === "s" && writeEnabled) { e.preventDefault(); doAction(selected.id, selected.state === "running" ? "stop" : "start"); }
  };


  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey}
      className="flex-1 min-h-0 flex flex-col outline-none overflow-hidden relative">
                <style>{SCROLLBAR_CSS}</style>
                <div className={viewHeaderClass} style={viewHeaderStyle}>
                  <span className={viewTitleClass} style={{ color: "var(--text)" }}>Docker</span>
                  {ov?.version && <span className="text-[10px] t-dim2">Engine {ov.version}</span>}
                  {/* Scoped to the open project. The fallback case is spelled out
                      rather than shown as an empty list, so an unlabelled stack
                      doesn't read as "docker is broken". */}
                  {ov?.scope && (
                    <span className="text-[9.5px] px-1.5 py-0.5 rounded shrink-0" title={ov.scope.showingAll
                      ? `No container is labelled for ${ov.scope.project} (${ov.scope.workspace}) — showing every container on this host`
                      : `Showing containers for ${ov.scope.workspace}`}
                      style={ov.scope.showingAll
                        ? { background: "color-mix(in srgb, var(--warning) 16%, transparent)", color: "var(--warning)" }
                        : { background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--text2)" }}>
                      {ov.scope.showingAll ? `No ${ov.scope.project} containers · showing all` : ov.scope.project}
                    </span>
                  )}
                  {/* The tabs used to live here and are now the stacked
                      column's headers — two ways to switch the same thing, one
                      of which hid three quarters of what docker was doing. */}
                  <div className="ml-auto flex items-center gap-1.5">
                    {!writeEnabled && ov?.available && <span className="text-[9.5px] t-dim2">Read-only</span>}
                    <button onClick={() => setDense((v) => !v)} title={dense ? "Show each container's image" : "Fit more containers on screen"}
                      className="text-[10px] px-2 py-0.5 rounded-lg"
                      style={dense
                        ? { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
                        : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
                      Dense
                    </button>
                    <button onClick={() => { loadOverview(); loadStats(); }} title="Refresh" className="text-[13px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}>⟳</button>
                  </div>
                </div>

                {!ov?.available ? (
                  // A missing binary and a downed daemon both land here; the
                  // capability tells them apart so the former gets install
                  // guidance rather than "is the daemon running?".
                  cap && !cap.available ? (
                    <DockerMissing reason={cap.reason} />
                  ) : (
                    <div className="flex-1 grid place-items-center t-dim2 text-[12px] px-6 text-center">{ov?.error || "Connecting to Docker…"}</div>
                  )
                ) : (
                  <div className="flex-1 min-h-0 flex">
                    {/* Everything at once down the left, the way lazydocker
                        does it: four stacked sections whose headers never
                        leave, so you can see there are 12 images without
                        navigating away from the container you are watching.
                        Each collapses independently and remembers it. */}
                    <div className="shrink-0 agx-scroll overflow-y-auto py-1 flex flex-col" style={{ width: sidebarW }}>
                      <Stack id="containers" label="Containers" n={containers.length} open={openSections.containers} onToggle={toggleSection} active={view === "containers"} onActivate={setView}>
                      {groups.map(([proj, cs]) => (
                        <div key={proj} className="mb-1">
                          <div className="flex items-center gap-2 px-2.5 py-1 sticky top-0 z-10" style={{ background: "var(--bg2)" }}>
                            <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text2)" }}>{proj}</span>
                            <span className="text-[9px] t-dim2 tabular-nums">{cs.filter((c) => c.state === "running").length}/{cs.length}</span>
                            {/* Names the columns once per project, in the same
                                grid the rows use, so the figures below are not
                                three anonymous numbers. */}
                            {/* Whole-stack actions, where the stack is named.
                                Each is hidden when it would do nothing — a
                                "start all" on twelve running containers is a
                                button that lies about having an effect. */}
                            {writeEnabled && (
                              <span className="flex items-center gap-1 ml-2">
                                {cs.some((c) => c.state !== "running") && (
                                  <DockerAction onClick={() => doGroupAction(cs, "start")} disabled={busy} tint="var(--success)" title={`Start every stopped container in ${proj}`}>▶</DockerAction>
                                )}
                                {cs.some((c) => c.state === "running") && (
                                  <>
                                    <DockerAction onClick={() => doGroupAction(cs, "restart")} disabled={busy} tint="var(--warning)" title={`Restart every running container in ${proj}`}>⟳</DockerAction>
                                    <DockerAction onClick={() => doGroupAction(cs, "stop")} disabled={busy} tint="var(--error)" title={`Stop every running container in ${proj}`}>■</DockerAction>
                                  </>
                                )}
                              </span>
                            )}
                            <span className="ml-auto grid gap-x-2 text-[8.5px] t-dim2 uppercase tracking-wider" style={{ gridTemplateColumns: "46px 46px 52px 50px" }}>
                              <span className="text-right">cpu</span>
                              <span className="text-right">mem</span>
                              <span>port</span>
                              <span />
                            </span>
                          </div>
                          <div className="px-1">
                            {cs.map((c) => <ContainerRow key={c.id} c={c} stat={stats[c.id]} active={selected?.id === c.id} writeEnabled={writeEnabled} busy={busy} dense={dense} onSelect={() => { setSelId(c.id); setTab("logs"); }} onAction={(v) => doAction(c.id, v)} />)}
                          </div>
                        </div>
                      ))}
                      </Stack>
                      <Stack id="images" label="Images" n={ov.images.length} open={openSections.images} onToggle={toggleSection} active={view === "images"} onActivate={setView}>
                        {ov.images.map((i) => (
                          <StackRow key={i.id} onClick={() => setView("images")} dim={i.dangling}
                            label={i.repository === "<none>" ? i.id.slice(0, 12) : `${i.repository}:${i.tag}`} meta={i.size} />
                        ))}
                      </Stack>
                      <Stack id="volumes" label="Volumes" n={ov.volumes.length} open={openSections.volumes} onToggle={toggleSection} active={view === "volumes"} onActivate={setView}>
                        {ov.volumes.map((v) => (
                          <StackRow key={v.name} onClick={() => setView("volumes")} label={v.name} meta={v.driver} />
                        ))}
                      </Stack>
                      <Stack id="networks" label="Networks" n={ov.networks.length} open={openSections.networks} onToggle={toggleSection} active={view === "networks"} onActivate={setView}>
                        {ov.networks.map((n) => (
                          <StackRow key={n.id} onClick={() => setView("networks")} label={n.name} meta={n.driver} />
                        ))}
                      </Stack>
                    </div>
                    <SidebarGrip />
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                    {view !== "containers" ? (
                      <div className="agx-scroll flex-1 min-h-0 overflow-auto p-4">
                        <table className="w-full text-[11px]" style={{ color: "var(--text2)" }}>
                          <thead className="text-[9.5px] uppercase tracking-wider t-dim2 text-left">
                            {view === "images" && <tr>{["Repository", "Tag", "Image id", "Size", "Created", "In use"].map((h) => <th key={h} className="py-1.5 pr-4 font-semibold">{h}</th>)}</tr>}
                            {view === "volumes" && <tr>{["Volume", "Driver"].map((h) => <th key={h} className="py-1.5 pr-4 font-semibold">{h}</th>)}</tr>}
                            {view === "networks" && <tr>{["Network", "Id", "Driver", "Scope"].map((h) => <th key={h} className="py-1.5 pr-4 font-semibold">{h}</th>)}</tr>}
                          </thead>
                          <tbody className="tabular-nums">
                            {view === "images" && ov.images.map((i) => (
                              <tr key={i.id} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", opacity: i.dangling ? 0.55 : 1 }}>
                                <td className="py-1.5 pr-4" style={{ color: "var(--text)" }}>{i.repository}</td><td className="py-1.5 pr-4">{i.tag}</td><td className="py-1.5 pr-4">{i.id.slice(0, 12)}</td><td className="py-1.5 pr-4">{i.size}</td><td className="py-1.5 pr-4">{i.created}</td><td className="py-1.5 pr-4">{i.containers}</td>
                              </tr>
                            ))}
                            {view === "volumes" && ov.volumes.map((v) => (
                              <tr key={v.name} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}><td className="py-1.5 pr-4 break-all" style={{ color: "var(--text)" }}>{v.name}</td><td className="py-1.5 pr-4">{v.driver}</td></tr>
                            ))}
                            {view === "networks" && ov.networks.map((n) => (
                              <tr key={n.id} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}><td className="py-1.5 pr-4" style={{ color: "var(--text)" }}>{n.name}</td><td className="py-1.5 pr-4">{n.id}</td><td className="py-1.5 pr-4">{n.driver}</td><td className="py-1.5 pr-4">{n.scope}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : selected ? (
                        <>
                          <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATE_TINT[selected.state] ?? "var(--text3)" }} />
                            <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={selected.name}>{selected.name}</span>
                            <span className="text-[10px] t-dim2 truncate">{selected.status}</span>
                            <div className="ml-auto flex items-center gap-1">
                              {/* Runs in the console already docked below, in
                                  the same shell you would have typed it into.
                                  A second, container-only terminal would be a
                                  second set of bugs for no extra reach. */}
                              {writeEnabled && selected.state === "running" && (
                                <button onClick={() => { setConsoleOpen(true); runInConsole(consoleRoot(), `docker exec -it ${selected.id.slice(0, 12)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`); }}
                                  className="text-[10px] px-2 py-0.5 rounded mr-1"
                                  style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}
                                  title={`Open a shell inside ${selected.name}`}>Exec</button>
                              )}
                              {DETAIL_TABS.map((t) => (
                                <button key={t} onClick={() => setTab(t)} className="text-[10px] px-2 py-0.5 rounded" style={{ background: tab === t ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: tab === t ? "var(--text)" : "var(--text3)" }}>{t[0].toUpperCase() + t.slice(1)}</button>
                              ))}
                              {tab === "logs" && (
                                <Select value={String(tail)} onChange={(v) => setTail(Number(v))} align="right"
                                  className="text-[10px] px-1 py-0.5 rounded outline-none"
                                  style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}
                                  options={[100, 400, 1000, 2000].map((n) => ({ value: String(n), label: `${n} lines` }))} />
                              )}
                            </div>
                          </div>
                          {tab === "env" || tab === "config" || tab === "top" ? (
                            <DetailPane tab={tab} env={env} config={config} top={top} error={detailErr} />
                          ) : tab === "logs" ? (
                            <pre ref={logRef} onScroll={(e) => { const el = e.currentTarget; stuckBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28; }} className="agx-scroll flex-1 min-h-0 overflow-auto text-[11px] leading-[1.55] px-4 py-2 whitespace-pre-wrap break-all" style={{ ...CODE_FONT_STYLE, background: "var(--bg)", color: "var(--text2)" }}>{logs
                              ? logs.split("\n").map((l, i) => <LogLine key={i} line={l} />)
                              : "…"}</pre>
                          ) : (
                            <div className="agx-scroll flex-1 min-h-0 overflow-auto p-4 text-[11.5px] space-y-1.5" style={{ color: "var(--text2)" }}>
                              {[["Name", selected.name], ["Id", selected.id], ["Image", selected.image], ["State", selected.state], ["Status", selected.status], ["Ports", selected.ports || "—"], ["Compose project", selected.project || "—"], ["Service", selected.service || "—"], ["Uptime", selected.runningFor]].map(([k, v]) => (
                                <div key={k} className="flex gap-3"><span className="w-32 shrink-0 t-dim2">{k}</span><span className="min-w-0 break-all" style={{ color: "var(--text)" }}>{v}</span></div>
                              ))}
                              {stats[selected.id] && <div className="flex gap-3"><span className="w-32 shrink-0 t-dim2">CPU / MEM</span><span style={{ color: "var(--text)" }}>{stats[selected.id].cpu}% · {stats[selected.id].mem}% ({stats[selected.id].memUsage})</span></div>}
                            </div>
                          )}
                        </>
                    ) : <div className="flex-1 grid place-items-center t-dim2 text-[12px]">No containers</div>}
                    </div>
                  </div>
                )}

                {/* Docked shell. Sits above the hint bar and below everything
                    else, so opening it takes room from the logs rather than
                    covering them. */}
                <ConsoleStrip
                  root={consoleRoot()}
                  open={consoleOpen}
                  height={consoleH}
                  onHeight={setConsoleH}
                  onClose={closeConsole}
                />

                {ov?.available && view === "containers" && (
                  <div className="shrink-0 px-4 py-1 border-t text-[9.5px] t-dim2 flex items-center gap-3" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <span><b className="font-semibold">j/k</b> container</span>
                    <span><b className="font-semibold">s</b> start/stop</span>
                    <span><b className="font-semibold">r</b> restart</span>
                    {/* Loud on purpose. As a ghost chip among the keyboard
                        hints nobody found it — and a shell docked under the
                        logs is the sort of thing you only use if you know it
                        is there. It reads as an action, not as a legend. */}
                    <button
                      onClick={() => (consoleOpen ? closeConsole() : setConsoleOpen(true))}
                      className="ml-1 px-2.5 py-1 rounded-lg text-[10.5px] font-medium whitespace-nowrap transition-colors flex items-center gap-1.5"
                      title="A shell in this project, docked under the logs — run make targets, migrations or tests without leaving Docker. It keeps running while you look around."
                      style={{
                        background: consoleOpen ? "color-mix(in srgb, var(--primary) 22%, transparent)" : "color-mix(in srgb, var(--primary) 12%, transparent)",
                        color: consoleOpen ? "var(--text)" : "var(--primary-hover)",
                        border: `1px solid color-mix(in srgb, var(--primary) ${consoleOpen ? 55 : 35}%, transparent)`,
                      }}
                    >
                      <span style={{ fontSize: 11 }}>{consoleOpen ? "▾" : "▸"}</span>
                      <span>Console</span>
                      <kbd className="text-[8.5px] px-1 py-[1px] rounded" style={{ border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", opacity: 0.85 }}>shell</kbd>
                    </button>
                    <span className="ml-auto">Logs auto-refresh · stats every 5s</span>
                  </div>
                )}
                {toast && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg text-[11px] shadow-xl" style={{ zIndex: 40, background: "var(--bg3)", border: `1px solid ${toast.ok ? "color-mix(in srgb, var(--success) 50%, transparent)" : "color-mix(in srgb, var(--error) 50%, transparent)"}`, color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</div>
                )}
                {dialog}
    </div>
  );
}
