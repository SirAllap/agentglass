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
        {/* Not a scroller itself: each tab owns its own scrolling, because
            Resources pins a footer under one and a scroller here would push
            that footer off the bottom instead. */}
        <div className="flex-1 min-h-0 flex flex-col">
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
    <div className="flex-1 min-h-0 agx-scroll overflow-y-auto">
      {note && <div className="px-3.5 py-1.5 text-[10.5px]" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>{note}</div>}

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

/** "4h41m" — coarse on purpose. The question this answers is "did this start
 *  just now or has it been sitting here", and to the second is noise. */
function forAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

function Row({ p, actions, dim }: { p: PortEntry; actions?: React.ReactNode; dim?: boolean }) {
  return (
    <div className="group flex items-center gap-3 px-3.5 py-1.5 hover:bg-white/5" style={{ borderBottom: edge(7) }}>
      {/* A live socket, marked the way a running shell is marked everywhere
          else here. Ours get the colour; the system's stay grey, because the
          point of the section is which is which. */}
      <span className="shrink-0 w-2 grid place-items-center">
        <span style={{ width: 6, height: 6, borderRadius: 999, display: "block", background: dim ? "color-mix(in srgb, var(--text) 22%, transparent)" : "var(--success)" }} />
      </span>
      <span className="tabular-nums shrink-0 w-[52px] text-[13px]"
        style={{ color: dim ? "var(--text3)" : "var(--primary)", fontWeight: dim ? 400 : 600 }}>{p.port}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px]" style={{ color: dim ? "var(--text2)" : "var(--text)", fontWeight: dim ? 400 : 500 }}>
          {p.proc ?? "—"}
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
      {/* This one IS a verdict, and it is safe to make: whatever it was serving
          has been deleted underneath it. */}
      {p.cwdGone && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
          title="Its working directory no longer exists — the checkout it was serving has been removed."
          style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
          checkout gone
        </span>
      )}
      {p.cwd && (
        <span className="shrink-0 truncate text-[10px] px-1.5 py-0.5 rounded-full max-w-[190px]"
          title={p.cwd}
          style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
          {p.cwd.split("/").filter(Boolean).pop()}
        </span>
      )}
      {actions && <span className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">{actions}</span>}
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

    for (const p of data?.procs ?? []) {
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
  }, [data, repos]);

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
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 agx-scroll overflow-y-auto">
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
                        title={`${p.cmd || p.comm}\npid ${p.pid}\n${p.cwd ?? ""}`} aside={`pid ${p.pid}`} />
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
  );
}

/** Name · sparkline · CPU · RSS. One grid, declared once, so a header and a row
 *  cannot drift out of alignment. */
const COLS = "minmax(0,1fr) 62px 66px 84px";

function Line({ label, cpu, rss, depth, title, aside, kind, caret, onClick, spark }: {
  label: string; cpu: number; rss: number; depth: number; title?: string; aside?: string;
  kind: "project" | "checkout" | "proc" | "other";
  caret?: string; onClick?: () => void; spark?: number[];
}) {
  // Above a whole core, a number stops being a reading and becomes a finding.
  const hot = cpu >= 80;
  const tint = kind === "other" ? "var(--text3)" : kind === "proc" ? "var(--text2)" : "var(--text)";
  const Row = onClick ? "button" : "div";
  return (
    <Row
      {...(onClick ? { onClick, type: "button" as const } : {})}
      className={`grid items-center w-full text-left px-3.5 py-[3px] text-[11.5px] ${onClick ? "hover:bg-white/5" : ""}`}
      style={{ gridTemplateColumns: COLS, borderBottom: edge(6) }} title={title}>
      <span className="min-w-0 flex items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
        {caret
          ? <span className="shrink-0 w-3 text-[9px]" style={{ color: "var(--text3)" }}>{caret}</span>
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
        <select value={root} onChange={(e) => { setRoot(e.target.value); setData(null); setOpen(false); }}
          className="text-[10.5px] px-1.5 py-0.5 rounded outline-none min-w-0"
          style={{ background: "var(--bg)", color: "var(--text2)", border: edge(20), maxWidth: 240 }}>
          {repos.map((r) => <option key={r.root} value={r.root}>{r.worktreeOf ? r.branch : base(r.root)}</option>)}
        </select>
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
          <div className="flex flex-col gap-[3px]">
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
                {d.reclaimable && <span className="shrink-0 text-[9px]" style={{ color: "var(--text4)" }}>rebuildable</span>}
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
