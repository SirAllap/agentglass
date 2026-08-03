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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import type { GitRepoRef, PortEntry, PortsReport, ProcEntry, ResourceReport, SpaceReport } from "../../../shared/types.ts";
import { HAS_BROWSER } from "../lib/desktop.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { requestBrowserNav } from "../lib/browserNav.ts";

export type MachineTab = "ports" | "resources";

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
          width: "min(760px, 94vw)", background: "var(--bg2)", border: edge(20),
          boxShadow: "0 40px 90px -24px var(--shadow)",
        }}>
        <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: edge(16) }}>
          <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>Machine</span>
          <span className="inline-flex rounded-md overflow-hidden ml-2" style={{ border: edge(20) }}>
            {(["ports", "resources"] as const).map((t) => (
              <button key={t} onClick={() => onTab(t)} className="text-[10.5px] px-3 py-1"
                style={t === tab
                  ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--text)" }
                  : { color: "var(--text3)" }}>{t === "ports" ? "Ports" : "Resources"}</button>
            ))}
          </span>
          <button onClick={onClose} aria-label="Close" className="agx-btn ml-auto shrink-0 px-1.5 py-0.5 rounded text-[11px]"
            style={{ color: "var(--text2)", border: edge(18) }}>✕</button>
        </div>
        <div className="flex-1 min-h-0 agx-scroll overflow-y-auto">
          {tab === "ports" ? <Ports onOpenBrowser={onOpenBrowser} /> : <Resources />}
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

  const load = useCallback(() => {
    api.machinePorts().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);

  const mine = useMemo(() => data?.ports.filter((p) => p.mine) ?? [], [data]);
  const rest = useMemo(() => data?.ports.filter((p) => !p.mine) ?? [], [data]);

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
    <div>
      {note && <div className="px-3 py-1.5 text-[10.5px]" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>{note}</div>}

      <Group label="Yours" count={mine.length} />
      {mine.length === 0 && <Note>Nothing of yours is listening right now.</Note>}
      {mine.map((p) => (
        <Row key={`${p.addr}:${p.port}:${p.pid}`} p={p}
          actions={
            <>
              <IconBtn title={HAS_BROWSER && onOpenBrowser ? "Open in the browser tab" : "Open in your browser"} onClick={() => open(p)}>↗</IconBtn>
              <IconBtn title="Copy the address" onClick={() => void navigator.clipboard?.writeText(`http://localhost:${p.port}`)}>⧉</IconBtn>
              {p.pid != null && p.proc !== "agentglass-serv" && (
                <IconBtn title="Ask this process to stop (SIGTERM)" tint="var(--error)" disabled={busy === p.pid} onClick={() => void stop(p)}>✕</IconBtn>
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
  );
}

function Row({ p, actions, dim }: { p: PortEntry; actions?: React.ReactNode; dim?: boolean }) {
  return (
    <div className="group flex items-center gap-3 px-3 py-1.5" style={{ borderBottom: edge(7) }}>
      <span className="tabular-nums shrink-0 w-[54px] text-[12.5px]"
        style={{ color: dim ? "var(--text3)" : "var(--text)", fontWeight: dim ? 400 : 600 }}>{p.port}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px]" style={{ color: dim ? "var(--text2)" : "var(--text)" }}>
          {p.proc ?? "—"}
        </span>
        <span className="block truncate text-[10px]" style={{ color: "var(--text3)" }}>
          {p.addr}:{p.port}
          {p.pid != null && ` · pid ${p.pid}`}
          {/* The cwd is the whole reason this beats `ss`: it names the checkout
              the process was started in. */}
          {p.cwd && ` · ${p.cwd.split("/").slice(-2).join("/")}`}
        </span>
      </span>
      {actions && <span className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">{actions}</span>}
    </div>
  );
}

// ------------------------------------------------------------- resources ----

function Resources() {
  const [data, setData] = useState<ResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);

  useEffect(() => {
    const load = () => api.machineResources().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e)));
    load();
    const id = setInterval(load, POLL_MS);
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
    return () => clearInterval(id);
  }, []);

  /**
   * Ours, grouped by the checkout each process was started in.
   *
   * The cwd does the grouping, and the repo list only supplies the NAME — so a
   * process in a directory nobody has registered as a project still gets a row
   * under its own path rather than disappearing into "other".
   */
  const groups = useMemo(() => {
    const byRoot = new Map<string, { label: string; branch: string; procs: ProcEntry[]; cpu: number; rss: number }>();
    for (const p of data?.procs ?? []) {
      if (!p.ours) continue;
      const repo = bestRepo(repos, p.cwd);
      const key = repo?.root ?? p.cwd ?? "—";
      const g = byRoot.get(key) ?? {
        label: repo ? (repo.worktreeOf ? repo.branch : repo.name) : (p.cwd?.split("/").pop() ?? "elsewhere"),
        branch: repo?.branch ?? "",
        procs: [], cpu: 0, rss: 0,
      };
      g.procs.push(p);
      g.cpu += p.cpu ?? 0;
      g.rss += p.rss;
      byRoot.set(key, g);
    }
    return [...byRoot.entries()].map(([root, g]) => ({ root, ...g })).sort((a, b) => b.rss - a.rss);
  }, [data, repos]);

  if (error) return <Note tint="var(--error)">{error}</Note>;
  if (!data) return <Note>Reading /proc…</Note>;

  const otherRss = Math.max(0, data.totalRss - data.oursRss);
  const otherCpu = data.totalCpu != null && data.oursCpu != null ? Math.max(0, data.totalCpu - data.oursCpu) : null;

  return (
    <div>
      <div className="flex items-baseline gap-3 px-3 py-2.5" style={{ borderBottom: edge(12) }}>
        <span className="text-[19px] tabular-nums" style={{ color: "var(--text)" }}>
          {data.oursCpu != null ? data.oursCpu.toFixed(1) : "—"}<span className="text-[12px]" style={{ color: "var(--text3)" }}>%</span>
        </span>
        <span className="text-[19px] tabular-nums" style={{ color: "var(--text)" }}>{gb(data.oursRss)}</span>
        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
          agentglass and everything it started
          {/* Said, not hidden: the first sample after opening this has nothing
              to compare against, and a "0.0%" that means "no reading yet" is a
              lie a panel like this must not tell. */}
          {!data.rated && " · CPU needs a second sample"}
        </span>
      </div>

      <div className="grid px-3 py-1 text-[9.5px] uppercase tracking-wider"
        style={{ gridTemplateColumns: "minmax(0,1fr) 68px 84px", color: "var(--text3)", borderBottom: edge(10) }}>
        <span>Name</span><span className="text-right">CPU</span><span className="text-right">RSS</span>
      </div>

      {groups.length === 0 && <Note>Nothing of ours is running.</Note>}
      {groups.map((g) => (
        <div key={g.root}>
          <Line label={g.label} cpu={g.cpu} rss={g.rss} depth={0} title={g.root} strong
            aside={g.branch && g.branch !== g.label ? g.branch : undefined} />
          {g.procs.slice(0, 12).map((p) => (
            <Line key={p.pid} label={p.comm} cpu={p.cpu ?? 0} rss={p.rss} depth={1}
              title={`${p.cmd || p.comm}\npid ${p.pid}\n${p.cwd ?? ""}`} aside={`pid ${p.pid}`} />
          ))}
          {g.procs.length > 12 && (
            <div className="px-3 py-1 text-[10px]" style={{ color: "var(--text3)", paddingLeft: 34 }}>
              …and {g.procs.length - 12} more in this checkout
            </div>
          )}
        </div>
      ))}

      {/* One line, not four hundred: a browser's tab processes are not what this
          panel is for, and the only thing worth knowing about them is how much
          of the machine they leave. */}
      <Line label="The rest of this machine" cpu={otherCpu ?? 0} rss={otherRss} depth={0} dim
        aside={`${data.seen} processes seen`} />

      <Space repos={repos} />
    </div>
  );
}

function Line({ label, cpu, rss, depth, title, aside, strong, dim }: {
  label: string; cpu: number; rss: number; depth: number; title?: string;
  aside?: string; strong?: boolean; dim?: boolean;
}) {
  // Above a whole core, a number stops being a reading and becomes a finding.
  const hot = cpu >= 80;
  return (
    <div className="grid items-center px-3 py-[3px] text-[11px]"
      style={{ gridTemplateColumns: "minmax(0,1fr) 68px 84px", borderBottom: edge(6) }} title={title}>
      <span className="min-w-0 flex items-center gap-2" style={{ paddingLeft: depth * 16 }}>
        <span className="truncate" style={{
          color: dim ? "var(--text3)" : strong ? "var(--text)" : "var(--text2)",
          fontWeight: strong ? 500 : 400,
        }}>{label}</span>
        {aside && <span className="shrink-0 text-[9.5px] truncate" style={{ color: "var(--text4)", maxWidth: 180 }}>{aside}</span>}
      </span>
      <span className="text-right tabular-nums" style={{ color: hot ? "var(--warning)" : dim ? "var(--text3)" : "var(--text2)" }}>
        {cpu.toFixed(1)}%
      </span>
      <span className="text-right tabular-nums" style={{ color: dim ? "var(--text3)" : "var(--text2)" }}>{mb(rss)}</span>
    </div>
  );
}

/**
 * Where a checkout's disk went.
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

  useEffect(() => { setRoot((cur) => cur || repos[0]?.root || ""); }, [repos]);

  const scan = async () => {
    if (!root) return;
    setBusy(true);
    try { setData(await api.machineSpace(root)); } catch (e) { setData({ root, bytes: 0, freeable: 0, dirs: [], error: String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className="px-3 py-2.5" style={{ borderTop: edge(14), background: "color-mix(in srgb, var(--text) 4%, transparent)" }}>
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span style={{ color: "var(--text)" }}>Disk</span>
        <select value={root} onChange={(e) => { setRoot(e.target.value); setData(null); }}
          className="text-[10.5px] px-1.5 py-0.5 rounded outline-none min-w-0"
          style={{ background: "var(--bg)", color: "var(--text2)", border: edge(20), maxWidth: 260 }}>
          {repos.map((r) => <option key={r.root} value={r.root}>{r.worktreeOf ? r.branch : r.name}</option>)}
        </select>
        <button onClick={() => void scan()} disabled={busy || !root}
          className="agx-btn text-[10.5px] px-2 py-0.5 rounded"
          style={{ color: "var(--text2)", border: edge(20) }}>{busy ? "Measuring…" : "⟳ Measure"}</button>
        {data && !data.error && (
          <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
            {mb(data.bytes)} · <span style={{ color: "var(--success)" }}>{mb(data.freeable)} rebuildable</span>
          </span>
        )}
      </div>
      {data?.error && <div className="mt-1.5 text-[10.5px]" style={{ color: "var(--error)" }}>{data.error}</div>}
      {data && !data.error && (
        <div className="mt-2 flex flex-col gap-[2px]">
          {data.dirs.slice(0, 8).map((d) => (
            <div key={d.path} className="flex items-center gap-2 text-[10.5px]">
              <span className="truncate min-w-0 flex-1" style={{ color: d.reclaimable ? "var(--warning)" : "var(--text2)" }}>{d.name}</span>
              {d.reclaimable && <span className="shrink-0 text-[9px]" style={{ color: "var(--text4)" }}>rebuildable</span>}
              <span className="shrink-0 tabular-nums w-[74px] text-right" style={{ color: "var(--text2)" }}>{mb(d.bytes)}</span>
            </div>
          ))}
          <div className="mt-1 text-[9.5px]" style={{ color: "var(--text4)" }}>
            Read only — nothing here deletes anything.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared ----

const Note = ({ children, tint }: { children: React.ReactNode; tint?: string }) =>
  <div className="px-3 py-3 text-[11.5px]" style={{ color: tint ?? "var(--text3)" }}>{children}</div>;

function Group({ label, count, hint }: { label: string; count: number; hint?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-wider"
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

const mb = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
