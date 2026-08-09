// What this machine is doing: open ports, hungry processes, and where the disk
// went.
//
// All three have a perfectly good command-line answer already — `ss`, `top`,
// `du` — and asking any of them means leaving the app, finding a shell, and then
// translating a pid back into "which of my six worktrees is that". The
// translation is the whole point. A port is only interesting once you know it is
// *your* dev server in *that* checkout; a 700 MB process is only actionable once
// you know which branch it belongs to.
//
// One surface, reachable from the dashboard and from inside the workspace,
// because "is 5173 still up?" is a question you have while looking at anything.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import type { GitLock, GitLocksReport, GitRepoRef, ProcDetail, MachineTotals, PortEntry, PortsReport, ProcEntry, ResourceReport, SpaceReport } from "../../../shared/types.ts";
import { HAS_BROWSER } from "../lib/desktop.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { requestBrowserNav } from "../lib/browserNav.ts";
import { CloseButton, CloseIcon } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";
import { CheckoutPicker } from "./CheckoutPicker.tsx";

export type MachineTab = "ports" | "resources" | "locks";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;
/** Fast enough that a dev server you just started appears while you are still
 *  looking, slow enough that a /proc walk every tick is not a cost. Also what
 *  makes the CPU column a rate at all: it needs two samples. */
const POLL_MS = 2500;

export function MachinePanel({ tab, onTab, onClose, onOpenBrowser }: {
  tab: MachineTab;
  onTab: (t: MachineTab) => void;
  onClose: () => void;
  /** Switch to the built-in browser view, after a port has asked for it. Absent
   *  on surfaces that have no browser to switch to. */
  onOpenBrowser?: () => void;
}) {
  return (
    // Above the workspace portal and above the file viewer: this opens from
    // inside the workspace as often as from the dashboard behind it, and a
    // panel that renders under the thing that opened it is not a panel.
    <Portal z={10050}>
      <div className="fixed inset-0" style={{ zIndex: 1, background: "rgba(0,0,0,.6)" }} onClick={onClose} />
      <div role="dialog" aria-label="Machine"
        className="fixed rounded-xl overflow-hidden flex flex-col"
        style={{
          zIndex: 2, top: "8vh", bottom: "8vh", left: "50%", transform: "translateX(-50%)",
          // Widened twice, and for the same reason both times: this stopped
          // being a dialog and became a table with a detail pane beside it.
          // At 760 the flexible column got 218px and truncated the ancestry
          // chain; at 1020 the pane was 340 and wrapped a command line and a
          // long path over three lines each. `96vw` still caps it on a laptop.
          width: "min(1320px, 96vw)", background: "var(--bg2)", border: edge(20),
          boxShadow: "0 40px 90px -24px var(--shadow)",
        }}>
        <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: edge(16) }}>
          <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>Machine</span>
          <span className="inline-flex rounded-md overflow-hidden ml-2" style={{ border: edge(20) }}>
            {(["ports", "resources", "locks"] as const).map((t) => (
              <button key={t} onClick={() => onTab(t)} className="text-[10.5px] px-3 py-1"
                style={t === tab
                  ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--text)" }
                  : { color: "var(--text3)" }}>{t === "ports" ? "Ports" : t === "resources" ? "Resources" : "Locks"}</button>
            ))}
          </span>
          <CloseButton onClick={onClose} title="Close" style={{ color: "var(--text2)", border: edge(18) }} className="agx-btn ml-auto shrink-0 rounded" />
        </div>
        {/* Not a scroller itself: each tab owns its own scrolling, because
            Resources pins a footer under one and a scroller here would push
            that footer off the bottom instead. */}
        <div className="flex-1 min-h-0 flex flex-col">
          {tab === "ports" ? <Ports onOpenBrowser={onOpenBrowser} /> : tab === "resources" ? <Resources /> : <Locks />}
        </div>
      </div>
    </Portal>
  );
}

// ----------------------------------------------------------------- ports ----

function Ports({ onOpenBrowser }: { onOpenBrowser?: () => void }) {
  const [data, setData] = useState<PortsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExternal, setShowExternal] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Which row's detail is open, by pid. Null is the ordinary state — the pane
   *  is a second question, not a permanent third of the panel. */
  const [selected, setSelected] = useState<number | null>(null);
  /** Twenty-two system daemons under "everything else", and the question that
   *  opens that section is always "who has <port>". Searching is on every tab
   *  of the tool the rest of this borrows from. */
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    api.machinePorts().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);

  /** Port, process name, checkout, and what started it — everything the row
   *  actually shows. Searching only the port number would miss "which of these
   *  is vite", which is the other half of why people open this. */
  const hit = useCallback((p: PortEntry) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [String(p.port), p.proc ?? "", p.cwd ?? "", p.addr, ...p.ancestry.map((a) => a.name)]
      .some((s) => s.toLowerCase().includes(needle));
  }, [q]);
  const mine = useMemo(() => data?.ports.filter((p) => p.mine && hit(p)) ?? [], [data, hit]);
  const rest = useMemo(() => data?.ports.filter((p) => !p.mine && hit(p)) ?? [], [data, hit]);

  const open = (p: PortEntry) => {
    // Bound to a specific address? Use it. `0.0.0.0` and `::` mean "every
    // interface", which as a URL is nothing — localhost is where you actually
    // reach it from this machine.
    const host = p.addr === "0.0.0.0" || p.addr === "::" || p.addr === "*" ? "localhost" : p.addr.includes(":") ? `[${p.addr}]` : p.addr;
    const url = `http://${host}:${p.port}`;
    if (HAS_BROWSER && onOpenBrowser) { requestBrowserNav(url); onOpenBrowser(); return; }
    openExternal(url);
  };

  const stop = async (p: PortEntry) => {
    if (p.pid == null) return;
    setBusy(p.pid);
    const r = await api.machineKill(p.pid);
    setBusy(null);
    setNote(r.ok ? (r.detail ?? "asked it to stop") : (r.error ?? "could not stop it"));
    // Not instant: SIGTERM asks, and a server that shuts down cleanly takes a
    // moment. The poll will notice; this just makes it feel answered.
    setTimeout(load, 600);
  };

  if (error) return <Note tint="var(--error)">{error}</Note>;
  if (!data) return <Note>Looking at the sockets…</Note>;
  if (data.error) return <Note tint="var(--warning)">{data.error}</Note>;

  return (
    <div className="flex-1 min-h-0 flex">
    <div className="flex-1 min-w-0 agx-scroll overflow-y-auto">
      {note && <div className="px-3.5 py-1.5 text-[10.5px]" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>{note}</div>}

      {/* Above the groups rather than inside one: it filters both, and a filter
          that lives in a section looks like it only applies there. */}
      <div className="px-3.5 py-1.5" style={{ borderBottom: edge(7) }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by port, process, checkout or what started it…"
          className="text-[10.5px] px-2 py-1 rounded w-full outline-none bg-transparent"
          style={{ color: "var(--text)", border: edge(20) }} />
      </div>

      <Group label="Yours" count={mine.length} />
      {mine.length === 0 && <Note>{q.trim() ? `Nothing of yours matches “${q.trim()}”.` : "Nothing of yours is listening right now."}</Note>}
      {mine.map((p) => (
        <Row key={`${p.addr}:${p.port}:${p.pid}`} p={p}
          selected={selected === p.pid} narrow={selected != null}
          onSelect={p.pid != null ? () => setSelected((s) => (s === p.pid ? null : p.pid)) : undefined}
          actions={
            <>
              <IconBtn title={HAS_BROWSER && onOpenBrowser ? "Open in the browser tab" : "Open in your browser"} onClick={() => open(p)}>↗</IconBtn>
              <IconBtn title="Copy the address" onClick={() => void navigator.clipboard?.writeText(`http://localhost:${p.port}`)}>⧉</IconBtn>
              {p.pid != null && p.proc !== "agentglass-serv" && (
                <IconBtn title="Ask this process to stop (SIGTERM)" tint="var(--error)" disabled={busy === p.pid} onClick={() => void stop(p)}><CloseIcon size={ICON.sm} /></IconBtn>
              )}
            </>
          } />
      ))}

      {/* Collapsed, because it is thirty rows of system daemons and the answer
          is almost never in it — but present, because "who has 8080?" is
          sometimes exactly the question. */}
      <button onClick={() => setShowExternal((v) => !v)} className="w-full text-left">
        <Group label={`${showExternal ? "▾" : "▸"} Everything else`} count={rest.length}
          hint="other users' processes — the system will not say whose" />
      </button>
      {showExternal && rest.map((p) => (
        <Row key={`${p.addr}:${p.port}:${p.pid}`} p={p} dim />
      ))}
    </div>
    {/* Only ever ours: /proc will not describe another account's process, so
        opening a detail on one would be a pane that says "not yours". */}
    {selected != null && <DetailPane pid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** One reading, with the bar that makes a percentage legible at a glance. */
function Stat({ label, value, pct, tint }: { label: string; value: string; pct?: number | null; tint?: string }) {
  return (
    <span className="flex flex-col gap-1 min-w-0">
      <span className="flex items-baseline gap-1.5">
        <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: "var(--text4)" }}>{label}</span>
        <span className="text-[11.5px] tabular-nums truncate" style={{ color: "var(--text)" }}>{value}</span>
      </span>
      {/* Absent, not empty, when there is nothing to plot: a bar drawn at zero
          reads as "idle", which is the opposite of "we have not measured yet". */}
      {pct != null && (
        <span className="block h-[3px] rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>
          <span className="block h-full rounded-full"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: tint ?? "var(--primary)" }} />
        </span>
      )}
    </span>
  );
}

/** Warm at 80, hot at 90 — the point is that a number you must not ignore does
 *  not look like one you may. */
const heat = (pct: number) =>
  pct >= 90 ? "var(--error)" : pct >= 80 ? "var(--warning)" : "var(--primary)";

/** "24.9 / 30.5 GB" — one unit, one decimal, said once. The long form spelled
 *  GB twice and truncated, and the hundredths were never actionable. */
const pair = (used: number, total: number) =>
  `${(used / 1e9).toFixed(1)} / ${(total / 1e9).toFixed(1)} GB`;

function MachineStrip({ m }: { m: MachineTotals }) {
  const memPct = m.memTotal ? (m.memUsed / m.memTotal) * 100 : null;
  const swapPct = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : null;
  const diskUsed = m.diskTotal - m.diskFree;
  const diskPct = m.diskTotal ? (diskUsed / m.diskTotal) * 100 : null;
  if (!m.memTotal && !m.diskTotal && m.cpu == null) return null;
  return (
    <div className="px-3.5 py-2.5 flex items-start gap-5" style={{ borderBottom: edge(10) }}>
      <span className="text-[10px] uppercase tracking-wider shrink-0 pt-0.5" style={{ color: "var(--text4)" }}>
        This<br />machine
      </span>
      <span className="grid gap-x-5 gap-y-2 flex-1 min-w-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))" }}>
        <Stat label="CPU" pct={m.cpu} tint={m.cpu != null ? heat(m.cpu) : undefined}
          value={m.cpu != null ? `${m.cpu.toFixed(0)}% of ${m.cores}` : "sampling…"} />
        <Stat label="Memory" pct={memPct} tint={memPct != null ? heat(memPct) : undefined}
          value={m.memTotal ? pair(m.memUsed, m.memTotal) : "—"} />
        {/* Shown only where there is any. A swap row reading 0% on a machine
            with none is furniture. */}
        {m.swapTotal > 0 && (
          <Stat label="Swap" pct={swapPct} tint={swapPct != null ? heat(swapPct) : undefined}
            value={pair(m.swapUsed, m.swapTotal)} />
        )}
        <Stat label="Disk" pct={diskPct} tint={diskPct != null ? heat(diskPct) : undefined}
          value={m.diskTotal ? `${(m.diskFree / 1e9).toFixed(0)} GB free` : "—"} />
        <Stat label="Load" value={m.load1.toFixed(2)} />
        {m.tempC != null && (
          <Stat label="Temp" value={`${m.tempC.toFixed(0)} °C`}
            pct={Math.min(100, (m.tempC / 100) * 100)} tint={heat(m.tempC)} />
        )}
      </span>
    </div>
  );
}

/**
 * The columns of a port row, reserved rather than negotiated.
 *
 * Flex sized every cell from its contents, so a row with two badges put its
 * checkout pill somewhere else than a row with one, and pointing at a row made
 * the action buttons appear and shove everything left. Nothing was wrong with
 * any single row; the list had no shape.
 *
 * So each thing gets a column and keeps it. The last one is the important one:
 * it is there whether the row has buttons or not, which is what stops the
 * hover from moving anything. Same fix, and the same reason, as the lists in
 * Source control.
 */
/**
 * The row's columns. Fixed on purpose — see ports-row-grid.test.ts, which is
 * what stops a row's contents deciding where its neighbour starts.
 *
 * A fixed track does NOT clip what is put in it, which is a separate thing and
 * was the bug: the cwd chip carried `max-w-[190px]` inside a 132px track, and
 * being right-aligned it painted *leftwards* over the badges. Measured at
 * 1400px wide before the fix: the chip ran 1127→1298 while the badge track
 * ended at 1154 — 27px of overlap. The cure is on the chip and its container
 * (`max-w-full`, `overflow-hidden`), not here.
 *
 * The checkout track grew because it holds the longest thing on the row —
 * `agentglass-work-2026-08-05` is a real directory name here — and the 1fr
 * column has room to give now that the panel is wider.
 */
export const PORT_GRID = "8px 52px minmax(0, 1fr) 190px 176px 76px";

/**
 * The same row with the detail pane open.
 *
 * The pane takes 340px, and the badge and checkout columns take 366 of what is
 * left — which would leave the flexible column about ninety pixels, i.e. the
 * truncation this panel already shipped once. Both of those columns say things
 * the pane says in full, so with it open they are the ones to give up.
 */
export const PORT_GRID_NARROW = "8px 52px minmax(0, 1fr) 76px";

/** "4h41m" — coarse on purpose. The question this answers is "did this start
 *  just now or has it been sitting here", and to the second is noise. */
function forAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

function Row({ p, actions, dim, selected, onSelect, narrow }: {
  p: PortEntry; actions?: React.ReactNode; dim?: boolean; selected?: boolean;
  onSelect?: () => void;
  /** The detail pane is open, so the columns it duplicates step aside. */
  narrow?: boolean;
}) {
  return (
    <div className={`group grid items-center gap-3 px-3.5 py-1.5 hover:bg-white/5${onSelect ? " cursor-pointer" : ""}`}
      onClick={onSelect}
      style={{
        borderBottom: edge(7), gridTemplateColumns: narrow ? PORT_GRID_NARROW : PORT_GRID,
        background: selected ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined,
      }}>
      {/* A live socket, marked the way a running shell is marked everywhere
          else here. Ours get the colour; the system's stay grey, because the
          point of the section is which is which. */}
      <span className="grid place-items-center">
        <span style={{ width: 6, height: 6, borderRadius: 999, display: "block", background: dim ? "color-mix(in srgb, var(--text) 22%, transparent)" : "var(--success)" }} />
      </span>
      <span className="tabular-nums text-[13px]"
        style={{ color: dim ? "var(--text3)" : "var(--primary)", fontWeight: dim ? 400 : 600 }}>{p.port}</span>
      <span className="min-w-0">
        {/* The name, and then what is holding it.
            The chain was put at the END of the detail line below first, after
            the address, the pid and the age. It never survived: that line
            truncates, and by the time it had spent its width on `0.0.0.0:4000 ·
            pid 1927432 · up 13s` there was nothing left, so the feature was
            invisible on the machine it was written for. Here it sits beside a
            name that is fifteen characters at worst, and it is the first thing
            read after "what is this" — which is the order the question is
            actually asked in. */}
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="shrink-0 truncate text-[11.5px] max-w-[45%]" style={{ color: dim ? "var(--text2)" : "var(--text)", fontWeight: dim ? 400 : 500 }}>
            {p.proc ?? "—"}
          </span>
          {p.ancestry.length > 0 && (
            <span className="truncate text-[10px]"
              title={`Started by: ${p.ancestry.map((a) => `${a.name} (pid ${a.pid})`).join(" ← ")}`}
              style={{ color: "var(--text4)" }}>
              ← {p.ancestry.map((a) => a.name).join(" ← ")}
            </span>
          )}
        </span>
        <span className="block truncate text-[10px]" style={{ color: "var(--text4)" }}>
          {p.addr}:{p.port}
          {p.pid != null && ` · pid ${p.pid}`}
          {p.ageSec != null && ` · up ${forAge(p.ageSec)}`}
        </span>
      </span>
      {/* The cwd is the whole reason this beats `ss`: it names the checkout the
          process was started in, which is the fact you actually wanted. */}
      {/* Who started this, for a port nobody remembers taking.
          Deliberately a statement of fact and not a warning: an agent starts a
          server on purpose constantly, and a panel that called every one of
          them a leak would be wrong most of the time and ignored the rest. The
          age beside it is what makes it decidable — a minute old is a session
          working, four hours old is a session that ended without tidying up. */}
      {!narrow && <span className="flex items-center justify-end gap-1.5 min-w-0 overflow-hidden">
      {p.fromAgent && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
          title="Started by a coding agent's tool call, not launched by hand. Check the age before assuming it is still wanted."
          // Grey, and chosen rather than inherited: amber would fire on the dev
          // server a session started a minute ago and is still using, and a
          // badge that cries wolf on the common case stops being read by the
          // time it matters. The age next to it does the arguing.
          style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text3) 30%, transparent)" }}>
          agent-started
        </span>
      )}
      {/* Bound to every interface, said out loud.
          Amber and not red: on a development machine this is often deliberate
          — this app's own server sits here when remote access is on — so it is
          a thing to have noticed, not a thing that is wrong. What makes it
          worth a chip at all is that `0.0.0.0` in the line above is easy to
          read straight past, and it is the only fact on the row whose
          consequence leaves the machine. */}
      {p.publicBind && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
          title={`Listening on every interface (${p.addr}), not just this machine — anything that can reach you on the network can reach this port.`}
          style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>
          on the network
        </span>
      )}
      {/* Not a fault — a rebuild replaces a binary under whatever is still
          running it, constantly. It is here because it is the only explanation
          for a server that behaves like a version you no longer have on disk,
          and nothing else on the row can hint at that. */}
      {p.exeGone && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
          title="The executable this is running has been deleted or replaced on disk. It is still running the old one — restart it to pick up the new."
          style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text3) 30%, transparent)" }}>
          stale binary
        </span>
      )}
      {/* This one IS a verdict, and it is safe to make: whatever it was serving
          has been deleted underneath it. */}
      {p.cwdGone && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
          title="Its working directory no longer exists — the checkout it was serving has been removed."
          style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
          checkout gone
        </span>
      )}
      </span>}
      {!narrow && <span className="flex items-center justify-end min-w-0 overflow-hidden">
      {p.cwd && (
        <span className="min-w-0 truncate text-[10px] px-1.5 py-0.5 rounded-full max-w-full"
          title={p.cwd}
          style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
          {p.cwd.split("/").filter(Boolean).pop()}
        </span>
      )}
      </span>}
      {/* The column exists whether or not this row has buttons, and whether or
          not the pointer is over it. Fading them in is the only thing hover
          does — a row that re-flows the moment you point at it is the defect
          the Source control lists had, and it is the same fix. */}
      {/* The row selects; the buttons act. Without this a click on "stop" also
          opens the detail of the thing it just stopped. */}
      <span onClick={(e) => e.stopPropagation()}
        className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">{actions}</span>
    </div>
  );
}

// ------------------------------------------------------------- resources ----

/** How many samples the sparklines remember. At one poll every 2.5s that is
 *  about a minute — long enough to see a build start, short enough that the
 *  line is about now rather than about the session. */
const HISTORY = 24;

function Resources() {
  const [data, setData] = useState<ResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  /** CPU over time, per group key. A ref rather than state: it is written on
   *  every poll and read during the render that poll already caused, so making
   *  it state would be a second render for a number nobody is waiting on. */
  const history = useRef<Map<string, number[]>>(new Map());
  /** Forty processes grouped across a dozen checkouts. Same reason as the ports
   *  list: the question is "where is the one eating the CPU", not "show me
   *  everything". */
  const [q, setQ] = useState("");
  /** Which process's detail is open, by pid. The same pane the ports list
   *  opens — a pid is a pid, and the questions asked of one here ("what is
   *  this eating the CPU actually running?") are the same ones. */
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(() => {
    api.machineResources()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
    return () => clearInterval(id);
  }, [load]);

  /**
   * Ours, as a tree: project → checkout → process.
   *
   * Grouping by the raw cwd produced rows called "serallap", "dist" and
   * "electron" — the directory a process happened to be started in, which is
   * not a thing anybody is looking for. The repo list turns those into the two
   * questions actually being asked: which PROJECT, and which CHECKOUT of it.
   * Anything in no known checkout lands in one "Elsewhere" row rather than
   * inventing a group per directory.
   */
  const tree = useMemo(() => {
    type Leaf = { key: string; label: string; procs: ProcEntry[]; cpu: number; rss: number };
    type Node = { key: string; label: string; kids: Leaf[]; cpu: number; rss: number };
    const byProject = new Map<string, Node>();
    const mkNode = (key: string): Node => ({ key, label: base(key), kids: [], cpu: 0, rss: 0 });
    const loose: Leaf = { key: "~elsewhere", label: "Elsewhere", procs: [], cpu: 0, rss: 0 };

    // Filtered before grouping, so a checkout with no match disappears entirely
    // rather than staying as an empty header — a group that says a name and
    // nothing else reads as a bug.
    const needle = q.trim().toLowerCase();
    const keep = (p: ProcEntry) => !needle ||
      [p.comm, p.cmd, p.cwd ?? "", String(p.pid)].some((s) => s.toLowerCase().includes(needle));
    for (const p of (data?.procs ?? []).filter(keep)) {
      if (!p.ours) continue;
      const repo = bestRepo(repos, p.cwd);
      if (!repo) { loose.procs.push(p); loose.cpu += p.cpu ?? 0; loose.rss += p.rss; continue; }
      const projectRoot = repo.worktreeOf ?? repo.root;
      const node = byProject.get(projectRoot) ?? mkNode(projectRoot);
      let leaf = node.kids.find((k) => k.key === repo.root);
      if (!leaf) {
        // A worktree IS its branch — that is what it was cut for. The main
        // checkout is named by its directory, with the branch as an aside.
        leaf = { key: repo.root, label: repo.worktreeOf ? repo.branch : base(repo.root), procs: [], cpu: 0, rss: 0 };
        node.kids.push(leaf);
      }
      leaf.procs.push(p); leaf.cpu += p.cpu ?? 0; leaf.rss += p.rss;
      node.cpu += p.cpu ?? 0; node.rss += p.rss;
      byProject.set(projectRoot, node);
    }

    const nodes = [...byProject.values()];
    for (const n of nodes) n.kids.sort((a, b) => b.rss - a.rss);
    nodes.sort((a, b) => b.rss - a.rss);
    if (loose.procs.length) nodes.push({ key: loose.key, label: loose.label, kids: [loose], cpu: loose.cpu, rss: loose.rss });
    return nodes;
  }, [data, repos, q]);

  // Record this sample against every key on screen, so a line that appears
  // later still starts empty rather than borrowing somebody else's shape.
  if (data?.rated) {
    for (const n of tree) {
      push(history.current, n.key, n.cpu);
      for (const k of n.kids) push(history.current, k.key, k.cpu);
    }
  }

  if (error) return <Note tint="var(--error)">{error}</Note>;
  if (!data) return <Note>Reading /proc…</Note>;

  const otherRss = Math.max(0, data.totalRss - data.oursRss);
  const otherCpu = data.totalCpu != null && data.oursCpu != null ? Math.max(0, data.totalCpu - data.oursCpu) : null;
  const live = (data.procs ?? []).filter((p) => p.ours).length;
  const flip = (key: string) => setShut((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <div className="flex-1 min-h-0 flex">
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <div className="flex-1 min-h-0 agx-scroll overflow-y-auto">
        {/* Under the totals rather than over them: the numbers at the top are
            the machine's and do not move when you filter, and a box above them
            would suggest they do. */}
        <div className="px-3.5 py-1.5" style={{ borderBottom: edge(7) }}>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by process, command, checkout or pid…"
            className="text-[10.5px] px-2 py-1 rounded w-full outline-none bg-transparent"
            style={{ color: "var(--text)", border: edge(20) }} />
        </div>
        <div className="flex items-baseline gap-3 px-3.5 py-3" style={{ borderBottom: edge(12) }}>
          <span className="text-[22px] tabular-nums leading-none" style={{ color: "var(--text)" }}>
            {data.oursCpu != null ? data.oursCpu.toFixed(1) : "—"}<span className="text-[12px]" style={{ color: "var(--text3)" }}>%</span>
          </span>
          <span className="text-[22px] tabular-nums leading-none" style={{ color: "var(--text)" }}>
            {gb(data.oursRss).replace(" GB", "")}<span className="text-[12px]" style={{ color: "var(--text3)" }}> GB</span>
          </span>
          <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
            Σ RSS · {live} process{live === 1 ? "" : "es"} of ours
            {/* Said, not hidden: the first sample after opening has nothing to
                compare against, and a "0.0%" that means "no reading yet" is a
                lie a panel like this must not tell. */}
            {!data.rated && " · CPU needs a second sample"}
          </span>
          <button onClick={load} title="Sample again now"
            className="agx-btn ml-auto shrink-0 px-1.5 py-0.5 rounded text-[11px]"
            style={{ color: "var(--text2)", border: edge(18) }}>⟳</button>
        </div>

        {/* The whole machine, above our share of it.
            Without this the panel could say "our 67 processes hold 4.26 GB"
            and leave you unable to tell whether that was most of the box or a
            rounding error — which is exactly when people go and open a system
            monitor instead. Every number here is a file in /proc or /sys, read
            on the same poll as the process list. */}
        <MachineStrip m={data.machine} />

        <div className="grid px-3.5 py-1 text-[9.5px] uppercase tracking-wider"
          style={{ gridTemplateColumns: COLS, color: "var(--text3)", borderBottom: edge(10) }}>
          <span>Name</span><span /><span className="text-right">CPU</span><span className="text-right">RSS</span>
        </div>

        {tree.length === 0 && <Note>Nothing of ours is running.</Note>}
        {tree.map((n) => {
          const closed = shut.has(n.key);
          return (
            <div key={n.key}>
              <Line label={n.label} cpu={n.cpu} rss={n.rss} depth={0} title={n.key} kind="project"
                caret={closed ? "▸" : "▾"} onClick={() => flip(n.key)} spark={history.current.get(n.key)} />
              {!closed && n.kids.map((k) => {
                const kShut = shut.has(k.key);
                const all = showAll.has(k.key);
                const shown = all ? k.procs : k.procs.slice(0, 8);
                return (
                  <div key={k.key}>
                    <Line label={k.label} cpu={k.cpu} rss={k.rss} depth={1} title={k.key} kind="checkout"
                      caret={kShut ? "▸" : "▾"} onClick={() => flip(k.key)} spark={history.current.get(k.key)} />
                    {!kShut && shown.map((p) => (
                      <Line key={p.pid} label={p.comm} cpu={p.cpu ?? 0} rss={p.rss} depth={2} kind="proc"
                        title={`${p.cmd || p.comm}\npid ${p.pid}\n${p.cwd ?? ""}`} aside={`pid ${p.pid}`}
                        selected={selected === p.pid}
                        onClick={() => setSelected((s) => (s === p.pid ? null : p.pid))} />
                    ))}
                    {!kShut && k.procs.length > shown.length && (
                      <button onClick={() => setShowAll((c) => new Set(c).add(k.key))}
                        className="w-full text-left px-3.5 py-1 text-[10px] hover:bg-white/5"
                        style={{ paddingLeft: 3.5 * 4 + 2 * 16, color: "var(--primary)" }}>
                        show {k.procs.length - shown.length} more in this checkout
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* One line, not four hundred: a browser's tab processes are not what
            this panel is for, and the only thing worth knowing about them is
            how much of the machine they leave. */}
        <Line label="The rest of this machine" cpu={otherCpu ?? 0} rss={otherRss} depth={0} kind="other"
          aside={`${data.seen} processes seen`} />
      </div>

      {/* Pinned, not appended. It was the last thing in a list that is ninety
          rows long on this machine, which is the same as not shipping it. */}
      <Space repos={repos} />
    </div>
    {/* The same pane the ports list opens. Ours only, which every row here
        already is — this tab lists our subtree and one collapsed line for the
        rest of the machine. */}
    {selected != null && <DetailPane pid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** Name · sparkline · CPU · RSS. One grid, declared once, so a header and a row
 *  cannot drift out of alignment. */
const COLS = "minmax(0,1fr) 62px 66px 84px";

function Line({ label, cpu, rss, depth, title, aside, kind, caret, onClick, spark, selected }: {
  label: string; cpu: number; rss: number; depth: number; title?: string; aside?: string;
  kind: "project" | "checkout" | "proc" | "other";
  caret?: string; onClick?: () => void; spark?: number[];
  /** Its detail is open in the pane. Same tint as the ports row uses, because
   *  it is the same state and the two lists sit one tab apart. */
  selected?: boolean;
}) {
  // Above a whole core, a number stops being a reading and becomes a finding.
  const hot = cpu >= 80;
  const tint = kind === "other" ? "var(--text3)" : kind === "proc" ? "var(--text2)" : "var(--text)";
  const Row = onClick ? "button" : "div";
  return (
    <Row
      {...(onClick ? { onClick, type: "button" as const } : {})}
      className={`grid items-center w-full text-left px-3.5 py-1 text-[11.5px] ${onClick ? "hover:bg-white/5" : ""}`}
      style={{
        gridTemplateColumns: COLS, borderBottom: edge(6),
        background: selected ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined,
      }} title={title}>
      <span className="min-w-0 flex items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
        {caret
          ? <span className="shrink-0 w-3 text-[10px]" style={{ color: "var(--text3)" }}>{caret}</span>
          : kind === "proc"
            // A live process, marked the way a running shell is marked
            // everywhere else in this app.
            ? <span className="shrink-0 w-3 grid place-items-center"><span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--success)", display: "block" }} /></span>
            : <span className="shrink-0 w-3" />}
        <span className="truncate" style={{
          color: tint,
          fontWeight: kind === "project" ? 600 : kind === "checkout" ? 500 : 400,
          letterSpacing: kind === "project" ? ".06em" : undefined,
          textTransform: kind === "project" ? "uppercase" : undefined,
          fontSize: kind === "project" ? 10.5 : undefined,
        }}>{label}</span>
        {aside && <span className="shrink-0 text-[9.5px] truncate" style={{ color: "var(--text4)", maxWidth: 190 }}>{aside}</span>}
      </span>
      <span className="justify-self-end pr-1">{spark && spark.length > 2 ? <Spark values={spark} hot={hot} /> : null}</span>
      <span className="text-right tabular-nums" style={{ color: hot ? "var(--warning)" : kind === "other" ? "var(--text3)" : "var(--text2)" }}>
        {cpu.toFixed(1)}%
      </span>
      <span className="text-right tabular-nums" style={{ color: kind === "other" ? "var(--text3)" : "var(--text2)" }}>{mb(rss)}</span>
    </Row>
  );
}

/**
 * CPU over the last minute.
 *
 * Scaled to its own maximum, not to 100%: a group that idles between 0.2% and
 * 0.9% is flat against a full core and its shape — which is the whole point of
 * a sparkline — would be invisible. The number beside it carries the magnitude;
 * this carries the movement.
 */
function Spark({ values, hot }: { values: number[]; hot: boolean }) {
  const max = Math.max(0.5, ...values);
  const step = 58 / Math.max(1, values.length - 1);
  const d = values.map((v, i) => `${i * step},${13 - (v / max) * 11}`).join(" ");
  return (
    <svg width={60} height={14} viewBox="0 0 60 14" preserveAspectRatio="none" aria-hidden>
      <polyline points={d} fill="none" strokeWidth={1.2} stroke={hot ? "var(--warning)" : "var(--success)"} strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Where a checkout's disk went — pinned to the bottom of the panel.
 *
 * Pinned, not appended: on this machine the process tree above is ninety rows,
 * and a footer at the end of ninety rows is a footer nobody has ever seen.
 *
 * Asked for, never polled: `du` walks every inode under the directory, which is
 * seconds on a repository with a node_modules in it. And it reports only — a
 * button that deletes a directory because it *looks* rebuildable is one
 * mislabelled entry away from taking somebody's work, and `rm -rf node_modules`
 * is two keystrokes away in the terminal one tab over.
 */
function Space({ repos }: { repos: GitRepoRef[] }) {
  const [root, setRoot] = useState("");
  const [data, setData] = useState<SpaceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { setRoot((cur) => cur || repos[0]?.root || ""); }, [repos]);

  const scan = async () => {
    if (!root) return;
    setBusy(true);
    setOpen(true);
    try { setData(await api.machineSpace(root)); }
    catch (e) { setData({ root, bytes: 0, freeable: 0, dirs: [], error: String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className="shrink-0" style={{ borderTop: edge(16), background: "color-mix(in srgb, var(--text) 5%, transparent)" }}>
      <div className="flex items-center gap-2 px-3.5 py-2 text-[11px] flex-wrap">
        <span style={{ color: "var(--text3)" }}>⛁</span>
        <span style={{ color: "var(--text)", fontWeight: 500 }}>Disk</span>
        {/* Which checkout to measure — a one-shot argument for the scan, not a
            move: nothing else follows it anywhere. */}
        <CheckoutPicker repos={repos} value={root}
          onPick={(r) => { setRoot(r); setData(null); setOpen(false); }}
          placeholder="Pick a checkout" triggerMaxWidth={240} />
        {data && !data.error && (
          <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
            <b style={{ color: "var(--text2)", fontWeight: 500 }}>{mb(data.bytes)}</b>
            {data.freeable > 0 && <> · <b style={{ color: "var(--success)", fontWeight: 500 }}>{mb(data.freeable)}</b> rebuildable</>}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {data && !data.error && (
            <button onClick={() => setOpen((o) => !o)} className="agx-btn text-[10.5px] px-2 py-0.5 rounded"
              style={{ color: "var(--text2)", border: edge(20) }}>{open ? "Hide" : "Show"} the breakdown</button>
          )}
          <button onClick={() => void scan()} disabled={busy || !root}
            className="agx-btn text-[10.5px] px-2 py-0.5 rounded disabled:opacity-50"
            style={busy
              ? { color: "var(--text3)", border: edge(20) }
              : { color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>
            {busy ? "Measuring…" : data ? "⟳ Measure again" : "⟳ Measure"}
          </button>
        </span>
      </div>

      {!data && !busy && (
        <div className="px-3.5 pb-2 text-[10px]" style={{ color: "var(--text4)" }}>
          Nothing is measured until you ask — `du` reads every file under the checkout, which takes seconds.
        </div>
      )}
      {data?.error && <div className="px-3.5 pb-2 text-[10.5px]" style={{ color: "var(--error)" }}>{data.error}</div>}

      {data && !data.error && open && (
        <div className="px-3.5 pb-2.5">
          <div className="grid gap-1.5 mb-2" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
            <Card k="On disk" v={mb(data.bytes)} />
            <Card k="Rebuildable" v={mb(data.freeable)} tint="var(--success)" />
            <Card k="Biggest" v={data.dirs[0] ? `${data.dirs[0].name}` : "—"} small />
          </div>
          <div className="flex flex-col gap-1">
            {data.dirs.slice(0, 8).map((d) => (
              <div key={d.path} className="flex items-center gap-2 text-[10.5px]">
                {/* A bar, because "676 MB" and "3 MB" in a column of numbers is
                    a comparison you have to do in your head. */}
                <span className="shrink-0 rounded-full" style={{
                  width: 44, height: 4,
                  background: "color-mix(in srgb, var(--text) 12%, transparent)",
                }}>
                  <span className="block h-full rounded-full" style={{
                    width: `${Math.max(2, Math.round((d.bytes / Math.max(1, data.dirs[0]!.bytes)) * 100))}%`,
                    background: d.reclaimable ? "var(--warning)" : "var(--primary)",
                  }} />
                </span>
                <span className="truncate min-w-0 flex-1" style={{ color: d.reclaimable ? "var(--warning)" : "var(--text2)" }}>{d.name}</span>
                {d.reclaimable && <span className="shrink-0 text-[10px]" style={{ color: "var(--text4)" }}>rebuildable</span>}
                <span className="shrink-0 tabular-nums w-[74px] text-right" style={{ color: "var(--text2)" }}>{mb(d.bytes)}</span>
              </div>
            ))}
          </div>
          <div className="mt-1.5 text-[9.5px]" style={{ color: "var(--text4)" }}>
            Read only — nothing here deletes anything.
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ k, v, tint, small }: { k: string; v: string; tint?: string; small?: boolean }) {
  return (
    <div className="rounded-md px-2 py-1.5 min-w-0" style={{ border: edge(14) }}>
      <div className="text-[9.5px] truncate" style={{ color: "var(--text3)" }}>{k}</div>
      <div className={`${small ? "text-[10.5px]" : "text-[13px]"} tabular-nums truncate`} style={{ color: tint ?? "var(--text)" }}>{v}</div>
    </div>
  );
}

// ---------------------------------------------------------------- shared ----

const Note = ({ children, tint }: { children: React.ReactNode; tint?: string }) =>
  <div className="px-3 py-3 text-[11.5px]" style={{ color: tint ?? "var(--text3)" }}>{children}</div>;

// ---------------------------------------------------------------- detail ----

/**
 * One process, in full, beside the list.
 *
 * The row can say what is listening and what is holding it. It cannot say what
 * the thing is actually running or what it was handed, and those are the next
 * two questions every time. Cramming them into the row is what produced a
 * truncated ancestry chain and two pills painted on top of each other — the row
 * is not where depth goes.
 *
 * Shared by Ports and Resources because a pid is a pid.
 */
function DetailPane({ pid, onClose }: { pid: number; onClose: () => void }) {
  const [d, setD] = useState<ProcDetail | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  /** Seventy-five variables is a list you scroll past, not one you read. The
   *  tool this borrows from puts a search on every tab for the same reason. */
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    setD(null); setShown({}); setNote(null); setQ("");
    api.machineProcess(pid).then((r) => { if (live) setD(r); }).catch((e) => { if (live) setNote(String(e)); });
    return () => { live = false; };
  }, [pid]);

  const reveal = async (key: string) => {
    const r = await api.machineEnv(pid, key);
    if (r.ok && r.value !== undefined) setShown((s) => ({ ...s, [key]: r.value! }));
    // The refusal a paired phone gets. Said plainly rather than as a silent
    // no-op, because "nothing happened" reads as a bug and this is a decision.
    else setNote(r.error ?? "the desktop app is the only thing that can reveal these");
  };

  return (
    <div className="shrink-0 flex flex-col min-h-0 agx-scroll overflow-y-auto"
      // 420 rather than 340: this holds absolute paths and full command lines,
      // and at 340 both wrapped over three lines each, which is how a detail
      // pane becomes harder to read than the row it replaced.
      style={{ width: 420, borderLeft: edge(14), background: "color-mix(in srgb, var(--text) 3%, transparent)" }}>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: edge(10) }}>
        <span className="text-[11px] font-medium truncate" style={{ color: "var(--text)" }}>{d?.comm || `pid ${pid}`}</span>
        <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--text4)" }}>pid {pid}</span>
        <CloseButton onClick={onClose} title="Close the detail" hit={22} className="ml-auto" />
      </div>

      {!d ? <Note>Reading /proc…</Note> : d.error ? <Note tint="var(--warning)">{d.error}</Note> : (
        <div className="px-3 py-2 flex flex-col gap-3 text-[10.5px]">
          {note && <div style={{ color: "var(--warning)" }}>{note}</div>}

          <Field label="Command">
            {/* Wrapped and selectable, unlike everywhere else in this panel:
                the command is the one thing here people copy. */}
            <span className="block break-all" style={{ color: "var(--text2)", userSelect: "text" }}>{d.cmd || "—"}</span>
          </Field>

          {d.cwd && <Field label="Working directory"><span className="block break-all" style={{ color: "var(--text2)", userSelect: "text" }}>{d.cwd}</span></Field>}

          {d.ancestry.length > 0 && (
            <Field label="Started by">
              {/* Indented, oldest at the top: the chain reads as a descent from
                  something you recognise down to the thing in front of you,
                  which is the direction the question is asked in. */}
              {[...d.ancestry].reverse().map((a, i) => (
                <span key={a.pid} className="block truncate" style={{ color: "var(--text2)", paddingLeft: i * 10 }}>
                  {i > 0 && <span style={{ color: "var(--text4)" }}>└─ </span>}
                  {a.name} <span className="tabular-nums" style={{ color: "var(--text4)" }}>({a.pid})</span>
                </span>
              ))}
              <span className="block truncate" style={{ color: "var(--text)", paddingLeft: d.ancestry.length * 10 }}>
                <span style={{ color: "var(--text4)" }}>└─ </span>{d.comm} <span className="tabular-nums" style={{ color: "var(--text4)" }}>({d.pid})</span>
              </span>
            </Field>
          )}

          <Field label={envLabel(d.env.length, q, d.env.filter((v) => matches(v.key, q)).length)}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
              className="text-[10px] px-1.5 py-1 rounded mb-1 outline-none bg-transparent w-full"
              style={{ color: "var(--text)", border: edge(20) }} />
            {/* Matched on the KEY only. The values are the thing being
                protected, and a filter that searched them would answer "does
                this process hold a variable containing <string>" for anything
                that could reach this panel — which is a lookup oracle over
                exactly the secrets the masking is for. */}
            {d.env.filter((v) => matches(v.key, q)).map((v) => (
              <span key={v.key} className="flex items-baseline gap-2">
                <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)" }}>{v.key}</span>
                {shown[v.key] !== undefined ? (
                  <span className="min-w-0 break-all" style={{ color: "var(--text2)", userSelect: "text" }}>{shown[v.key]}</span>
                ) : v.masked ? (
                  // The KEY is usually the whole answer — that AGENTGLASS_BIND
                  // is set at all explains a stray server. The value is a
                  // detail, and one that must not travel to a phone.
                  <button onClick={() => void reveal(v.key)} className="shrink-0 hover:opacity-70"
                    title="Hidden because it looks like a secret. Click to reveal — the desktop app only."
                    style={{ color: "var(--text4)" }}>•••••••• <span style={{ color: "var(--primary)" }}>show</span></button>
                ) : (
                  <span className="min-w-0 break-all" style={{ color: "var(--text2)", userSelect: "text" }}>{v.value}</span>
                )}
              </span>
            ))}
          </Field>
        </div>
      )}
    </div>
  );
}

/** Case-insensitive substring, which is what people type into a filter box. */
function matches(key: string, q: string): boolean {
  return !q || key.toLowerCase().includes(q.trim().toLowerCase());
}

/** "Environment (75)", or "Environment (3 of 75)" while filtering — a count
 *  that silently means something different is how a list lies about itself. */
function envLabel(total: number, q: string, shown: number): string {
  return q.trim() ? `Environment (${shown} of ${total})` : `Environment (${total})`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{label}</span>
      {children}
    </div>
  );
}

// ----------------------------------------------------------------- locks ----

/**
 * "Another git process seems to be running in this repository."
 *
 * The message tells you nothing you can act on. Sometimes a git really is
 * running and the answer is to wait; more often a tool call was interrupted and
 * a zero-byte `index.lock` is the only thing between you and a commit. This
 * separates the two, which is the whole feature — the rest is a list.
 *
 * Deliberately NOT modelled on the kernel-lock table this borrows its idea
 * from: git takes no kernel lock, so `lslocks` cannot see any of this. See
 * server/src/gitlocks.ts.
 */
function Locks() {
  const [data, setData] = useState<GitLocksReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The git holding a lock, opened in the same pane the other two tabs use.
   *  "A rebase is running" and "a fetch is running" are different decisions,
   *  and the row has room for neither. */
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(() => {
    api.machineLocks().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);

  const remove = async (l: GitLock) => {
    setBusy(l.path);
    const r = await api.machineUnlock(l.path);
    setBusy(null);
    setNote(r.ok ? (r.detail ?? "removed it") : (r.error ?? "could not remove it"));
    setTimeout(load, 300);
  };

  if (error) return <Note tint="var(--error)">{error}</Note>;
  if (!data) return <Note>Looking through your checkouts…</Note>;
  if (data.error) return <Note tint="var(--warning)">{data.error}</Note>;

  const stale = data.locks.filter((l) => l.stale);
  const held = data.locks.filter((l) => !l.stale);

  return (
    <div className="flex-1 min-h-0 flex">
    <div className="flex-1 min-w-0 agx-scroll overflow-y-auto">
      {note && <div className="px-3.5 py-1.5 text-[10.5px]" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>{note}</div>}

      {/* The count of checkouts is not decoration: an empty list has to be
          distinguishable from a sweep that never ran. */}
      <Group label="Stuck" count={stale.length} hint={`nothing is holding these · ${data.scanned} checkout${data.scanned === 1 ? "" : "s"} scanned`} />
      {stale.length === 0 && <Note>Nothing is stuck. Every lock found has a git behind it.</Note>}
      {stale.map((l) => <LockRow key={l.path} l={l} busy={busy === l.path} onRemove={() => void remove(l)}
        selected={selected != null && selected === l.heldBy?.pid} onSelect={l.heldBy ? () => setSelected((s) => (s === l.heldBy!.pid ? null : l.heldBy!.pid)) : undefined} />)}

      {held.length > 0 && (
        <>
          <Group label="In use" count={held.length} hint="a git is working here — these are doing their job" />
          {held.map((l) => <LockRow key={l.path} l={l}
            selected={selected != null && selected === l.heldBy?.pid}
            onSelect={l.heldBy ? () => setSelected((s) => (s === l.heldBy!.pid ? null : l.heldBy!.pid)) : undefined} />)}
        </>
      )}
    </div>
    {selected != null && <DetailPane pid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function LockRow({ l, busy, onRemove, selected, onSelect }: {
  l: GitLock; busy?: boolean; onRemove?: () => void; selected?: boolean;
  /** Only where a git is actually holding it. A stale lock has no process to
   *  open, and a row that looks clickable and does nothing is worse than one
   *  that does not. */
  onSelect?: () => void;
}) {
  return (
    <div className={`group grid items-center gap-3 px-3.5 py-1.5 hover:bg-white/5${onSelect ? " cursor-pointer" : ""}`}
      onClick={onSelect}
      style={{
        borderBottom: edge(7), gridTemplateColumns: "8px minmax(0, 1fr) 176px 76px",
        background: selected ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined,
      }}>
      <span className="grid place-items-center">
        <span style={{ width: 6, height: 6, borderRadius: 999, display: "block",
          background: l.stale ? "var(--warning)" : "var(--success)" }} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11.5px]" style={{ color: "var(--text)", fontWeight: 500 }}>{l.name}</span>
        <span className="block truncate text-[10px]" style={{ color: "var(--text4)" }} title={l.path}>
          {`held for ${forAge(l.ageSec)}`}
          {/* The command, not just the pid: two gits in the same checkout are
              told apart by what they are doing, and "a rebase is running" is a
              different decision from "a fetch is running". */}
          {l.heldBy && ` · pid ${l.heldBy.pid} · ${l.heldBy.cmd}`}
        </span>
      </span>
      <span className="flex items-center justify-end min-w-0 overflow-hidden">
        <span className="min-w-0 truncate text-[10px] px-1.5 py-0.5 rounded-full max-w-full"
          title={l.repo}
          style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
          {l.repo.split("/").filter(Boolean).pop()}
        </span>
      </span>
      <span onClick={(e) => e.stopPropagation()}
        className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* Only offered for the ones nothing is holding. The server re-decides
            that at the moment of the call anyway — this list is up to a poll
            interval old — but offering a button that will be refused is a worse
            way to learn it. */}
        {l.stale && onRemove && (
          <IconBtn title={`Delete ${l.name}. Nothing is holding it.`} tint="var(--error)" disabled={busy} onClick={onRemove}>
            <CloseIcon size={ICON.sm} />
          </IconBtn>
        )}
      </span>
    </div>
  );
}

function Group({ label, count, hint }: { label: string; count: number; hint?: string }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-1.5 text-[10px] uppercase tracking-wider"
      style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 5%, transparent)", borderBottom: edge(10) }}>
      <span>{label}</span>
      {hint && <span className="normal-case tracking-normal text-[9.5px] truncate" style={{ color: "var(--text4)" }}>{hint}</span>}
      <span className="ml-auto tabular-nums tracking-normal">{count}</span>
    </div>
  );
}

function IconBtn({ children, title, onClick, tint, disabled }: {
  children: React.ReactNode; title: string; onClick: () => void; tint?: string; disabled?: boolean;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className="agx-btn text-[10.5px] leading-none px-1.5 py-1 rounded disabled:opacity-40"
      style={{ color: tint ?? "var(--text2)", border: `1px solid color-mix(in srgb, ${tint ?? "var(--text)"} ${tint ? 45 : 18}%, transparent)` }}>
      {children}
    </button>
  );
}

/** The checkout a path is in: the longest registered root that contains it, so
 *  a worktree wins over the project it was cut from. */
function bestRepo(repos: GitRepoRef[], cwd: string | null): GitRepoRef | null {
  if (!cwd) return null;
  let best: GitRepoRef | null = null;
  for (const r of repos) {
    if (cwd !== r.root && !cwd.startsWith(r.root + "/")) continue;
    if (!best || r.root.length > best.root.length) best = r;
  }
  return best;
}

/** The last segment of a path — the name a directory is actually called. */
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** Append a sample to a bounded history. Bounded here rather than at the reader
 *  so a panel left open for an hour does not hold an hour of numbers. */
function push(m: Map<string, number[]>, key: string, v: number): void {
  const arr = m.get(key) ?? [];
  arr.push(v);
  if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
  m.set(key, arr);
}

const mb = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
