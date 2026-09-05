// Live Docker — agentglass's lazydocker replacement. Containers grouped by
// compose project with live CPU/mem, a streaming-ish log viewer, and start/
// stop/restart/rm actions. Images / volumes / networks get their own tabs.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PlayIcon, RefreshIcon } from "../lib/glyphIcons.tsx";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import type { DockerOverview, DockerContainer, DockerStat, DockerCapability } from "../../../shared/types.ts";
import { depSpec } from "../../../shared/deps.ts";
import { api } from "../lib/api.ts";
import { Select } from "./Select.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./diff/DiffLines.tsx";
import { ConsoleStrip, consoleRoot, runInConsole } from "./TerminalPanel.tsx";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { CloseIcon } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";
import { Detail, type DetailSection } from "./docker/Detail.tsx";
import { Volumes } from "./docker/Volumes.tsx";
import { Disk } from "./docker/Disk.tsx";
import { filterStacks, initiallyOpen, stackDots, stackLabel, toStacks, toWorktrees, type StackHealth } from "../lib/dockerStacks.ts";
import { HAS_BROWSER } from "../lib/desktop.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { requestBrowserNav } from "../lib/browserNav.ts";
import {
  firstReachable, freshnessLabel, freshnessNote, healthLabel, healthTint,
  ownerTint, ownerTitle, portLabel, portUrl,
} from "../lib/dockerRow.ts";

// Strip ANSI CSI (colors, cursor moves, erases) + OSC sequences, not just SGR.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex
const stripAnsi = (s: string) => s.replace(ANSI, "");

const STATE_TINT: Record<string, string> = {
  running: "var(--success)", exited: "var(--text3)", paused: "var(--warning)",
  restarting: "var(--warning)", created: "var(--info)", dead: "var(--error)", removing: "var(--error)",
};
type View = "containers" | "images" | "volumes" | "networks" | "disk";

/** The stack strip's colours. Amber for restarting or still starting up, grey
 *  for stopped — a stopped stack is a normal thing to have. */
const STACK_TINT: Record<StackHealth, string> = {
  bad: "var(--error)", warn: "var(--warning)", off: "var(--text4)", ok: "var(--success)",
};
/** Which stacks you left collapsed. Per machine, not per project: the answer to
 *  "do I care about acme-tools" does not change when you switch checkout. */
const STACKS_OPEN_KEY = "agx.docker.stacksOpen";
/** Stack or worktree. Remembered, because it is a way of thinking rather than
 *  a thing you toggle while you work. */
const GROUP_KEY = "agx.docker.groupBy";

function Bar({ pct, tint }: { pct: number; tint: string }) {
  return (
    <div className="w-9 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
      <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: tint }} />
    </div>
  );
}

/* The log's own rendering — levels, timestamps, the search highlight — moved
   to components/docker/LogView.tsx when the log stopped being a string this
   panel polled and became a feed that view owns. */

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
  id: View; label: string;
  /** How many things are in there. Omitted where a count would be a lie: Disk
   *  is one view, not a list of zero, and "DISK 0" reads as "nothing here". */
  n?: number;
  open: boolean; active: boolean;
  onToggle: (id: View) => void; onActivate: (id: View) => void; children: React.ReactNode;
}) {
  return (
    <div className="mb-1 shrink-0">
      <button
        onClick={() => { onActivate(id); onToggle(id); }}
        className="w-full flex items-center gap-2 px-2.5 py-1 sticky top-0 z-20 text-left"
        style={{ background: "var(--bg2)", borderLeft: `2px solid ${active ? "var(--primary)" : "transparent"}` }}
        aria-expanded={open}>
        <span className="text-[10px] t-dim2 w-2 shrink-0">{open ? "▾" : "▸"}</span>
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: active ? "var(--text)" : "var(--text2)" }}>{label}</span>
        {n != null && <span className="text-[10px] t-dim2 tabular-nums">{n}</span>}
      </button>
      {open && children}
    </div>
  );
}

/** A one-line entry in the sections that are not containers. */
function StackRow({ label, meta, dim, onClick }: { label: string; meta?: string; dim?: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} title={label}
      className="flex items-center gap-2 pl-6 pr-2 py-1 cursor-pointer rounded-md"
      style={{ opacity: dim ? 0.5 : 1 }}>
      <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: "var(--text2)" }}>{label}</span>
      {meta && <span className="text-[10px] t-dim2 shrink-0 tabular-nums">{meta}</span>}
    </div>
  );
}

/**
 * How old the picture is.
 *
 * Its own component with its own clock on purpose: the label has to count up
 * every second, and re-rendering the whole panel once a second to move one word
 * would undo the care the poll takes. Here, a tick repaints eleven characters.
 */
function Freshness({ ov }: { ov: DockerOverview | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ov?.at) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ov?.at]);
  if (!ov?.at) return null;
  const note = freshnessNote(ov.freshness, ov.tookMs);
  const worried = ov.freshness === "retrying" || ov.freshness === "down";
  return (
    <span className="text-[9.5px] shrink-0 tabular-nums"
      title={note ?? `gathered ${freshnessLabel(ov.at)}${ov.tookMs ? ` in ${ov.tookMs}ms` : ""}`}
      style={{ color: worried ? "var(--warning)" : "var(--text4)" }}>
      {ov.freshness === "retrying" ? "retrying…" : freshnessLabel(ov.at)}
    </span>
  );
}

/** A small labelled chip, the shape the rest of the app uses for one. */
function RowChip({ text, tint, title, onClick }: { text: string; tint: string; title?: string; onClick?: () => void }) {
  return (
    <span
      title={title}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className={`text-[9.5px] leading-none px-1.5 py-0.5 rounded-md shrink-0 whitespace-nowrap ${onClick ? "cursor-pointer" : ""}`}
      style={{
        color: tint,
        border: `1px solid color-mix(in srgb, ${tint} 40%, transparent)`,
        background: `color-mix(in srgb, ${tint} 10%, transparent)`,
      }}>
      {text}
    </span>
  );
}

function ContainerRow({ c, stat, active, writeEnabled, busy, dense, onSelect, onAction, onOpenPort }: {
  c: DockerContainer; stat?: DockerStat; active: boolean; writeEnabled: boolean; busy: boolean;
  dense: boolean;
  onSelect: () => void; onAction: (verb: "start" | "stop" | "restart" | "rm") => void;
  /** Opening a port belongs to whoever owns the browser, not to a row. */
  onOpenPort: (url: string) => void;
}) {
  const running = c.state === "running";
  // The port you can actually reach the service on, read from the parsed list.
  // The raw string is the fallback for a format the server did not recognise —
  // which is exactly what this row showed before there was a parser.
  const port = firstReachable(c.portList);
  const url = port ? portUrl(port) : null;
  const legacyPort = /(\d+)->/.exec(c.ports || "")?.[1];
  const health = healthLabel(c);
  const tint = healthTint(c.health);
  return (
    <div onClick={onSelect} data-cid={active ? "active" : undefined}
      className={`group grid items-center gap-x-2 pl-2 pr-1.5 rounded-md cursor-pointer ${dense ? "py-0.5" : "py-1"}`}
      // A grid, not a flex row: every container's numbers line up in the same
      // columns, which is what makes a list of twelve scannable instead of
      // twelve individually-arranged lines. lazydocker does the same.
      style={{
        gridTemplateColumns: "10px minmax(0,1fr) 46px 46px 52px 50px",
        background: active ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent",
      }}
      title={[
        c.name, c.image, c.status,
        c.ports || "",
        c.owner ? ownerTitle(c.owner) : "",
        // The probe's own words. This is the line that says what to fix, and
        // until now reading it meant a trip to `docker inspect`.
        c.healthError ? `health: ${c.healthError}` : "",
        c.restarts ? `restarted ${c.restarts}×` : "",
      ].filter(Boolean).join("\n")}>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATE_TINT[c.state] ?? "var(--text3)" }} />

      <span className="min-w-0 flex flex-col leading-tight">
        <span className="min-w-0 flex items-center gap-1.5">
          <span className="truncate text-[11.5px]" style={{ color: active ? "var(--text)" : "var(--text2)" }}>{c.service || c.name}</span>
          {/* Only the states worth acting on get a chip. A healthy container
              already says so with its green dot, and a second green thing on
              the row would be the panel congratulating itself. */}
          {health && c.health !== "healthy" && tint && <RowChip text={health} tint={tint} />}
          {/* The one chip that is about YOU: this container is running fine,
              it just came out of another checkout. */}
          {c.owner?.foreign && <RowChip text={c.owner.worktree} tint={ownerTint(c.owner)} title={ownerTitle(c.owner)} />}
        </span>
        {/* The image was competing with the name on one line and both lost.
            Underneath, dimmer, it reads as what it is — provenance, not
            identity. In dense mode it goes back to the tooltip, which is the
            trade: half the rows, one less thing per row. */}
        {!dense && (
          <span className="truncate text-[10px] t-dim2">
            {c.image}
            {/* A restart count is only news when it is not zero, and then it is
                the most important thing on the row. */}
            {c.restarts ? <span style={{ color: "var(--warning)" }}> · {c.restarts} restarts</span> : null}
          </span>
        )}
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
      {/* A stopped container has no numbers, and three blank columns read as
          missing data rather than as "this is not running". A port you can open
          is a button; one you cannot — a database, something only exposed — is
          text, because a link that goes nowhere is worse than no link. */}
      {running && url ? (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onOpenPort(url); }}
          title={`Open ${url}${HAS_BROWSER ? " in the browser tab" : ""}`}
          className="text-[10px] tabular-nums truncate text-left rounded px-1 -mx-1 min-h-[20px]"
          style={{ color: "var(--info)" }}>
          {portLabel(port!)} ↗
        </button>
      ) : (
        <span className="text-[10px] tabular-nums truncate" style={{ color: running ? "var(--info)" : "var(--text4)" }}>
          {running ? (port ? portLabel(port) : legacyPort ? `:${legacyPort}` : "") : c.state}
        </span>
      )}

      {/* Real buttons, not floating glyphs. Bare icons at 45% opacity read as
          decoration — they had no edge, no hit area you could see, and an
          emoji bin sitting next to line-art squares. Each one is now a chip
          with a border and a tinted hover, the same language every other
          control in the app uses, so it is obvious they can be pressed and
          obvious where. */}
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {writeEnabled && (running
          ? <>
              <DockerAction onClick={() => onAction("restart")} disabled={busy} tint="var(--warning)" title="Restart"><RefreshIcon /></DockerAction>
              <DockerAction onClick={() => onAction("stop")} disabled={busy} tint="var(--error)" title="Stop">■</DockerAction>
            </>
          : <>
              <DockerAction onClick={() => onAction("start")} disabled={busy} tint="var(--success)" title="Start">▶</DockerAction>
              <DockerAction onClick={() => onAction("rm")} disabled={busy} tint="var(--error)" title="Remove this container"><CloseIcon size={ICON.sm} /></DockerAction>
            </>)}
      </div>
    </div>
  );
}


/** Docker as a workspace view. `active` means "visible right now" — the view
 *  stays mounted while you're off in the diff, it just stops polling. */
const CONSOLE_KEY = "agentglass.docker.console";


const SECTIONS_KEY = "agentglass.docker.sections";
// Containers open, the rest closed: with 40 images the column is unusable if
// everything starts expanded, and the counts on the headers already answer the
// question most of the time.
const SECTIONS_DEFAULT: Record<View, boolean> = { containers: true, images: false, volumes: false, networks: false, disk: false };

const DENSITY_KEY = "agentglass.docker.dense";


/* Env, inspect and processes moved to components/docker/Detail.tsx when the
   detail stopped being a tab row. They are sections under the log now, and the
   facts that used to hide behind "Info" are the header. */

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
        {/* Generic: one macOS, one Windows, an unbounded number of Linux
            distributions. Docker's own page covers every one of them, and
            Settings ▸ Requirements is the same check for every other tool. */}
        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
          Install it however you install software here (<code>{depSpec("docker")?.url}</code>), then reopen.
          Settings ▸ Requirements checks this and every other tool agentglass uses.
        </span>
      </div>
    </div>
  );
}

export function DockerView({ active, onOpenBrowser }: {
  active: boolean;
  /** Bring the browser view forward. Absent on the phone and in the web build,
   *  where a port opens in the real browser instead — see openPort below. */
  onOpenBrowser?: () => void;
}) {
  // A shell docked under the logs, for the `make migrate` you always end up
  // needing while watching a container. Its height is remembered and it is
  // keyed on the repo, not on the container, so selecting a different one
  // above never disturbs what is running below.
  /* 340, because a container row is a grid and not a list: dot, name, project
     chip, CPU, MEM, port and two buttons. Measured by dragging the handle
     down — below this the chip and the percentage print on top of each other.
     The handle still works; it just cannot make this column unreadable. */
  const sidebarW = useSidebarWidth(340);
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
  /* Which of the read-only sections under the log are open. They replace the
     tab row: the facts that used to hide behind "Info" are the header now, and
     env / inspect / processes open UNDER the log rather than instead of it —
     what you want while reading `docker inspect` is usually the log line that
     made you open it. */
  const [sections, setSections] = useState<Record<DetailSection, boolean>>({ env: false, config: false, top: false, compare: false });
  const toggleDetail = useCallback((id: DetailSection) => setSections((cur) => ({ ...cur, [id]: !cur[id] })), []);
  // Fetched per tab rather than all at once: `top` shells out to the container
  // and `inspect` returns a few hundred KB of JSON, and paying for both every
  // time someone clicks a container to read its logs is the wrong trade.
  const [env, setEnv] = useState<string[] | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [top, setTop] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [tail, setTail] = useState(400);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
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

  /* The log used to be polled here every three seconds and repainted whole.
     It is followed now — LogView owns the stream, the cap, the pause and the
     scroll — which is why neither the timer nor the buffer live in this file
     any more. */

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
  // Fetched when a section is opened, not when a container is selected: `top`
  // shells out to the container and `inspect` returns a few hundred KB of JSON,
  // and paying for both every time somebody clicks a row to read its log is the
  // wrong trade. A closed section costs nothing.
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    let live = true;
    if ((sections.env || sections.config) && !(env && config)) {
      void api.dockerInspect(id).then((r) => {
        if (!live) return;
        if (!r.ok) { setDetailErr(r.error || "docker inspect failed"); return; }
        setEnv(r.env); setConfig(r.config); setDetailErr(null);
      });
    }
    if (sections.top && top == null) {
      void api.dockerTop(id).then((r) => {
        if (!live) return;
        if (!r.ok) { setDetailErr(r.error || "Not running"); setTop(null); return; }
        setTop(r.text); setDetailErr(null);
      });
    }
    return () => { live = false; };
  }, [selected?.id, sections.env, sections.config, sections.top, env, config, top]);

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

  /**
   * Open a container's port.
   *
   * In the desktop app it goes to the browser view — a dev server you started
   * from this app, in a tab of this app, next to the log that is printing its
   * requests. Everywhere else (the phone, the plain web build) there is no such
   * tab, and the real browser is the honest answer rather than a dead button.
   * The same shape the ports panel already uses.
   */
  const openPort = useCallback((url: string) => {
    if (HAS_BROWSER && onOpenBrowser) { requestBrowserNav(url); onOpenBrowser(); return; }
    openExternal(url);
  }, [onOpenBrowser]);

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

  /* Containers as stacks: counts, worst state, owner, and broken ones first.
     The rules live in lib/dockerStacks.ts because they are opinions worth
     pinning — a container docker is restarting in a loop reads as "up" in every
     flat list built from `docker ps`, and that is the one you want caught. */
  /* Grouped by stack, or pivoted onto the checkouts they came from. The pivot
     is the question a machine with twenty-five worktrees actually raises: not
     "what stacks exist" but "what is running out of each of mine". */
  const [groupBy, setGroupBy] = useState<"stack" | "worktree">(() => {
    try { return localStorage.getItem(GROUP_KEY) === "worktree" ? "worktree" : "stack"; } catch { return "stack"; }
  });
  const [q, setQ] = useState("");
  const stacks = useMemo(
    () => filterStacks(groupBy === "worktree" ? toWorktrees(containers) : toStacks(containers), q),
    [containers, groupBy, q],
  );
  const [openStacks, setOpenStacks] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(STACKS_OPEN_KEY) || "{}") as Record<string, boolean>; }
    catch { return {}; }
  });
  /* A stack that has just broken opens itself, whatever you left it as: the
     reason to collapse one is that it is fine and you want the room. Applied on
     the stack SET changing rather than on every poll, so it cannot fight you
     while you are collapsing things. */
  const stackKey = stacks.map((s) => `${s.project}:${s.worst}`).join("|");
  useEffect(() => {
    setOpenStacks((cur) => {
      const next = initiallyOpen(stacks, cur);
      return JSON.stringify(next) === JSON.stringify(cur) ? cur : next;
    });
  }, [stackKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleStack = useCallback((project: string) => {
    setOpenStacks((cur) => {
      const next = { ...cur, [project]: !(cur[project] ?? true) };
      try { localStorage.setItem(STACKS_OPEN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  // visible order — so j/k walks what is on screen, skipping collapsed stacks
  // rather than jumping into a container nobody can see.
  const ordered = useMemo(
    () => stacks.flatMap((s) => ((openStacks[s.project] ?? true) ? s.containers : [])),
    [stacks, openStacks],
  );

  const moveSel = (dir: 1 | -1) => {
    if (!ordered.length) return;
    const i = Math.max(0, ordered.findIndex((c) => c.id === selected?.id));
    const n = ordered[(i + dir + ordered.length) % ordered.length];
    if (n) { setSelId(n.id); requestAnimationFrame(() => frameRef.current?.querySelector('[data-cid="active"]')?.scrollIntoView({ block: "nearest" })); }
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
                  <h2 className="sr-only">Docker</h2>
                  {ov?.version && <span className="text-[10px] t-dim2">Engine {ov.version}</span>}
                  {/* How old this picture is. The panel caches and the daemon
                      can be slow, so without this a snapshot of unknown age
                      reads as live — and a panel that goes quietly stale is
                      worse than one that admits it, because you believe it. */}
                  <Freshness ov={ov} />
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
                    {/* One box for "which container is this". It reaches the
                        things a row only implies — the worktree, the branch,
                        the published port — so typing 8000 finds whatever is
                        serving it, which the flat list could never answer. */}
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter"
                      className="text-[10px] px-2 py-0.5 rounded-lg outline-none w-[120px]"
                      style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} />
                    <button onClick={() => { const next = groupBy === "stack" ? "worktree" : "stack"; setGroupBy(next); try { localStorage.setItem(GROUP_KEY, next); } catch { /* private mode */ } }}
                      title={groupBy === "stack" ? "Group by the checkout each container came from" : "Group by compose project"}
                      className="text-[10px] px-2 py-0.5 rounded-lg min-h-[20px]"
                      style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
                      by {groupBy}
                    </button>
                    {!writeEnabled && ov?.available && <span className="text-[9.5px] t-dim2">Read-only</span>}
                    <button onClick={() => setDense((v) => !v)} title={dense ? "Show each container's image" : "Fit more containers on screen"}
                      className="text-[10px] px-2 py-0.5 rounded-lg"
                      style={dense
                        ? { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
                        : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
                      Dense
                    </button>
                    <button onClick={() => { loadOverview(); loadStats(); }} title="Refresh" className="text-[13px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}><RefreshIcon /></button>
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
                    <div className="shrink-0 agx-scroll overflow-y-auto overflow-x-hidden py-1 flex flex-col" style={{ width: sidebarW }}>
                      <Stack id="containers" label="Containers" n={containers.length} open={openSections.containers} onToggle={toggleSection} active={view === "containers"} onActivate={setView}>
                      {stacks.map((st) => {
                        const open = openStacks[st.project] ?? true;
                        const { dots, more } = stackDots(st);
                        const cs = st.containers;
                        return (
                        <div key={st.project} className="mb-1">
                          {/* The stack, as a row with a state of its own. It
                              used to be a heading with a ratio next to it,
                              which meant "is my stack up?" was answered by
                              reading twelve lines. */}
                          <div className="flex items-center gap-2 px-2.5 py-1 sticky top-0 z-10" style={{ background: "var(--bg2)" }}>
                            <button onClick={() => toggleStack(st.project)} title={open ? "Collapse" : "Expand"}
                              className="text-[10px] t-dim2 w-3 shrink-0 min-h-[20px] text-left" aria-expanded={open}>{open ? "▾" : "▸"}</button>
                            <span className="text-[10px] uppercase tracking-wider font-semibold truncate" style={{ color: "var(--text2)" }}>{st.project}</span>
                            {/* One dot per container. Twelve containers, one
                                glance — and the stack sorts itself up here
                                when one of them is red. */}
                            <span className="flex items-center gap-0.5 shrink-0" title={cs.map((c) => `${c.service || c.name}: ${c.status}`).join("\n")}>
                              {dots.map((d, i) => (
                                <i key={i} className="w-[6px] h-[6px] rounded-full" style={{ background: STACK_TINT[d] }} />
                              ))}
                              {more > 0 && <span className="text-[9px] t-dim2 tabular-nums">+{more}</span>}
                            </span>
                            <span className="text-[9.5px] tabular-nums shrink-0"
                              style={{ color: st.worst === "bad" ? "var(--error)" : st.worst === "warn" ? "var(--warning)" : "var(--text3)" }}>
                              {stackLabel(st)}
                            </span>
                            {/* A whole stack running from another checkout is
                                the state behind most "why isn't my change
                                showing up". */}
                            {st.foreign && st.owner && (
                              <span className="text-[9px] px-1 py-0.5 rounded shrink-0" title={ownerTitle(st.owner)}
                                style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>
                                {st.owner.worktree}
                              </span>
                            )}
                            {/* Whole-stack actions, where the stack is named.
                                Each is hidden when it would do nothing — a
                                "start all" on twelve running containers is a
                                button that lies about having an effect. */}
                            {writeEnabled && (
                              <span className="flex items-center gap-1 ml-1">
                                {cs.some((c) => c.state !== "running") && (
                                  <DockerAction onClick={() => doGroupAction(cs, "start")} disabled={busy} tint="var(--success)" title={`Start every stopped container in ${st.project}`}><PlayIcon /></DockerAction>
                                )}
                                {cs.some((c) => c.state === "running") && (
                                  <>
                                    <DockerAction onClick={() => doGroupAction(cs, "restart")} disabled={busy} tint="var(--warning)" title={`Restart every running container in ${st.project}`}>⟳</DockerAction>
                                    <DockerAction onClick={() => doGroupAction(cs, "stop")} disabled={busy} tint="var(--error)" title={`Stop every running container in ${st.project}`}>■</DockerAction>
                                  </>
                                )}
                              </span>
                            )}
                            {/* Names the columns once per stack, in the same
                                grid the rows use, so the figures below are not
                                three anonymous numbers. */}
                            {open && (
                              <span className="ml-auto grid gap-x-2 text-[8.5px] t-dim2 uppercase tracking-wider" style={{ gridTemplateColumns: "46px 46px 52px 50px" }}>
                                <span className="text-right">cpu</span>
                                <span className="text-right">mem</span>
                                <span>port</span>
                                <span />
                              </span>
                            )}
                          </div>
                          {open && (
                            <div className="px-1">
                              {cs.map((c) => <ContainerRow key={c.id} c={c} stat={stats[c.id]} active={selected?.id === c.id} writeEnabled={writeEnabled} busy={busy} dense={dense} onSelect={() => setSelId(c.id)} onAction={(v) => doAction(c.id, v)} onOpenPort={openPort} />)}
                            </div>
                          )}
                        </div>
                        );
                      })}
                      </Stack>
                      <Stack id="images" label="Images" n={ov.images.length} open={openSections.images} onToggle={toggleSection} active={view === "images"} onActivate={setView}>
                        {ov.images.map((i) => (
                          <StackRow key={i.id} onClick={() => setView("images")} dim={i.dangling}
                            label={i.repository === "<none>" ? i.id.slice(0, 12) : `${i.repository}:${i.tag}`} meta={i.size} />
                        ))}
                      </Stack>
                      <Stack id="volumes" label="Volumes" n={ov.volumes.length} open={openSections.volumes} onToggle={toggleSection} active={view === "volumes"} onActivate={setView}>
                        {ov.volumes.map((v) => (
                          <StackRow key={v.name} onClick={() => setView("volumes")} label={v.name}
                            /* Free — it comes from agentglass's own ledger, not
                               from docker — and it is the fact that explains a
                               bundle you did not build. */
                            meta={v.worktrees && v.worktrees.length > 1 ? `${v.worktrees.length} worktrees` : v.lastWrite?.worktree ?? v.driver} />
                        ))}
                      </Stack>
                      <Stack id="networks" label="Networks" n={ov.networks.length} open={openSections.networks} onToggle={toggleSection} active={view === "networks"} onActivate={setView}>
                        {ov.networks.map((n) => (
                          <StackRow key={n.id} onClick={() => setView("networks")} label={n.name} meta={n.driver} />
                        ))}
                      </Stack>
                      {/* Disk is a section rather than a number in the header:
                          `docker system df -v` walks every layer on the
                          machine, and that is not a thing to pay for on a
                          timer. Opening it asks; nothing else does. */}
                      <Stack id="disk" label="Disk" open={openSections.disk} onToggle={toggleSection} active={view === "disk"} onActivate={setView}>
                        <StackRow onClick={() => setView("disk")} label="What is using the disk, and what is safe to take back" />
                      </Stack>
                    </div>
                    <SidebarGrip />
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                    {view === "disk" ? (
                      <Disk writeEnabled={writeEnabled} ask={ask} onDone={(ok, msg) => { flash(ok, msg); void loadOverview(); }} />
                    ) : view === "volumes" ? (
                      // Its own component now: sizes, who is holding it, who
                      // last wrote to it, and a read-only look inside.
                      <Volumes volumes={ov.volumes} />
                    ) : view !== "containers" ? (
                      <div className="agx-scroll flex-1 min-h-0 overflow-auto p-4">
                        <table className="w-full text-[11px]" style={{ color: "var(--text2)" }}>
                          <thead className="text-[9.5px] uppercase tracking-wider t-dim2 text-left">
                            {view === "images" && <tr>{["Repository", "Tag", "Image id", "Size", "Created", "In use"].map((h) => <th key={h} className="py-1.5 pr-4 font-semibold">{h}</th>)}</tr>}
                            {view === "networks" && <tr>{["Network", "Id", "Driver", "Scope"].map((h) => <th key={h} className="py-1.5 pr-4 font-semibold">{h}</th>)}</tr>}
                          </thead>
                          <tbody className="tabular-nums">
                            {view === "images" && ov.images.map((i) => (
                              <tr key={i.id} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", opacity: i.dangling ? 0.55 : 1 }}>
                                <td className="py-1.5 pr-4" style={{ color: "var(--text)" }}>{i.repository}</td><td className="py-1.5 pr-4">{i.tag}</td><td className="py-1.5 pr-4">{i.id.slice(0, 12)}</td><td className="py-1.5 pr-4">{i.size}</td><td className="py-1.5 pr-4">{i.created}</td><td className="py-1.5 pr-4">{i.containers}</td>
                              </tr>
                            ))}
                            {view === "networks" && ov.networks.map((n) => (
                              <tr key={n.id} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}><td className="py-1.5 pr-4" style={{ color: "var(--text)" }}>{n.name}</td><td className="py-1.5 pr-4">{n.id}</td><td className="py-1.5 pr-4">{n.driver}</td><td className="py-1.5 pr-4">{n.scope}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : selected ? (
                        <Detail
                          c={selected}
                          stat={stats[selected.id]}
                          env={env} config={config} top={top} error={detailErr}
                          writeEnabled={writeEnabled}
                          tail={tail} onTail={setTail}
                          onExec={() => { setConsoleOpen(true); runInConsole(consoleRoot(), `docker exec -it ${selected.id.slice(0, 12)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`); }}
                          onOpenPort={openPort}
                          open={sections} onToggle={toggleDetail}
                          others={containers}
                        />
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
                    {/*
                      * Hand the work to tmux, so closing agentglass cannot take
                      * it with it.
                      *
                      * The sidecar runs with AGENTGLASS_DIE_WITH_PARENT=1 — it
                      * is tied to the window — so every shell it owns dies when
                      * the window does. A `make app.build` five minutes in goes
                      * with it, which is exactly what happened.
                      *
                      * A tmux server is nobody's child. Run the build inside one
                      * and closing agentglass DETACHES rather than kills;
                      * pressing this again re-attaches to the same session, mid
                      * build, scrollback and all. `-A` is what makes it one
                      * button instead of two: attach if it exists, create if it
                      * does not.
                      *
                      * Deliberately typed into the console rather than built
                      * into the terminal. It changes nothing until it is
                      * pressed, it is undone by typing `exit`, and it leaves the
                      * Terminal view and its tabs completely alone — which is
                      * the whole reason it is one line here instead of a change
                      * to how shells are started.
                      */}
                    {/* The "keep running" button used to be here.
                        It typed `tmux new-session -A -s …` into this shell — a
                        BARE tmux, which is the machine's own server with the
                        machine's own config, borrowed to make an app shell
                        outlive the app. The console runs on the engine now, in
                        a session of its own, so it already outlives the window
                        and comes back where you left it. A button that offers
                        what is already true is a button that teaches people the
                        thing was optional. */}
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
                      <kbd className="text-[8.5px] px-1 py-px rounded" style={{ border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", opacity: 0.85 }}>shell</kbd>
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
