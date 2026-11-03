/*
 * The Machine dialog's decisions, out of the components so they can be asserted
 * without a renderer (there is none): what a port row says about a process, which
 * dials the machine gets and when they turn amber, how the process tree is cut,
 * how the disk plan is grouped, and when a stats sample may ask for a new reading.
 */
import type {
  DiskCleanLine, DiskCleanMount, GitLock, GitRepoRef, MachineTotals, PortEntry, PortsReport, ProcEntry, SpaceDir,
} from "../../../shared/types.ts";
import { sortLines } from "./diskClean.ts";

/** Where a reading stops being a reading and becomes a finding. */
export const LINE_PCT = 80;

/** "4h41m": did it start just now or has it been sitting here; to the second is noise. */
export function forAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

// ------------------------------------------------------------------ ports ----

export type FlagTone = "muted" | "warn" | "bad";
export interface Flag { key: string; label: string; tone: FlagTone; title: string }

/** Facts about a listener, not verdicts: amber means "look", never "wrong". */
export function portFlags(p: PortEntry): Flag[] {
  const out: Flag[] = [];
  if (p.fromAgent) out.push({ key: "agent", label: "agent-started", tone: "muted", title: "Started by a coding agent's tool call, not launched by hand. Check the age before assuming it is still wanted." });
  if (p.publicBind) out.push({ key: "net", label: "on the network", tone: "warn", title: `Listening on every interface (${p.addr}), not just this machine — anything that can reach you on the network can reach this port.` });
  if (p.exeGone) out.push({ key: "stale", label: "stale binary", tone: "muted", title: "The executable this is running has been deleted or replaced on disk. It is still running the old one — restart it to pick up the new." });
  if (p.cwdGone) out.push({ key: "gone", label: "checkout gone", tone: "bad", title: "Its working directory no longer exists — the checkout it was serving has been removed." });
  if (p.tmpLeftover) out.push({ key: "tmp", label: "tmp leftover", tone: "warn", title: `It is serving from ${p.dir}, a scratch directory. Whatever it was for, nobody is likely to look at it again.` });
  if (p.duplicate) out.push({ key: "dup", label: "duplicate", tone: "warn", title: `Another ${p.proc} is serving the same folder (${p.dir}). One of them is probably left over.` });
  if (p.idleSec != null) out.push({ key: "idle", label: "idle", tone: "warn", title: `Nothing has connected for ${forAge(p.idleSec)}.` });
  return out;
}

/** `0.0.0.0`, `::` and `*` mean "every interface", which as a URL is nothing: localhost is where this machine reaches it. */
export function portUrl(p: Pick<PortEntry, "addr" | "port">): string {
  const host = p.addr === "0.0.0.0" || p.addr === "::" || p.addr === "*" ? "localhost" : p.addr.includes(":") ? `[${p.addr}]` : p.addr;
  return `http://${host}:${p.port}`;
}

/** Port, process, checkout, address and what started it: everything the row shows. */
export function portHit(p: PortEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [String(p.port), p.proc ?? "", p.dir ?? p.cwd ?? "", p.addr, ...p.ancestry.map((a) => a.name)]
    .some((s) => s.toLowerCase().includes(needle));
}

export function splitPorts(ports: PortEntry[], q: string): { mine: PortEntry[]; rest: PortEntry[] } {
  const shown = ports.filter((p) => portHit(p, q));
  return { mine: shown.filter((p) => p.mine), rest: shown.filter((p) => !p.mine) };
}

/** Never offered for a row without a pid, nor for this app's own server (comm is truncated to 15 characters). */
export const canStop = (p: Pick<PortEntry, "pid" | "proc">): boolean => p.pid != null && p.proc !== "agentglass-serv";

export const checkoutName = (p: Pick<PortEntry, "dir" | "cwd">): string | null => {
  const path = p.dir ?? p.cwd;
  return path ? path.split("/").filter(Boolean).pop() ?? null : null;
};

export const checkoutTitle = (p: Pick<PortEntry, "dir" | "cwd">): string =>
  p.dir && p.dir !== p.cwd ? `Serving ${p.dir}\nStarted in ${p.cwd ?? "?"}` : p.dir ?? p.cwd ?? "";

/** Two reports that would draw the same table: everything equal, the age compared by the words `forAge` gives it. */
export function sameShown(a: PortsReport, b: PortsReport): boolean {
  const shown = (r: PortsReport) => JSON.stringify(r, (k, v) => (k === "ageSec" && typeof v === "number" ? forAge(v) : v));
  return shown(a) === shown(b);
}

// ------------------------------------------------------------------ dials ----

export type DialKey = "cpu" | "mem" | "swap" | "disk" | "load" | "temp";
export interface Dial { key: DialKey; label: string; value: string; sub: string; pct: number | null; hot: boolean; word: string }

const gb1 = (n: number) => (n / 1e9).toFixed(1);
const clamp = (n: number) => Math.min(100, Math.max(0, n));

function dial(key: DialKey, label: string, value: string, sub: string, pct: number | null, word: string): Dial {
  return { key, label, value, sub, pct, hot: pct != null && pct >= LINE_PCT, word };
}

/** The machine as dials. Swap only where there is any, temperature only where there is a sensor: a ring reading 0 % on a machine without one is furniture. */
export function dialsOf(m: MachineTotals): Dial[] {
  if (!m.memTotal && !m.diskTotal && m.cpu == null) return [];
  const out: Dial[] = [];
  out.push(m.cpu != null
    ? dial("cpu", "CPU", `${m.cpu.toFixed(0)} %`, `of ${m.cores} cores`, clamp(m.cpu), "busy")
    : dial("cpu", "CPU", "—", "sampling…", null, "busy"));
  out.push(m.memTotal
    ? dial("mem", "Memory", `${gb1(m.memUsed)} GB`, `of ${gb1(m.memTotal)} GB`, clamp((m.memUsed / m.memTotal) * 100), "nearly full")
    : dial("mem", "Memory", "—", "", null, "nearly full"));
  if (m.swapTotal > 0) out.push(dial("swap", "Swap", `${gb1(m.swapUsed)} GB`, `of ${gb1(m.swapTotal)} GB`, clamp((m.swapUsed / m.swapTotal) * 100), "nearly full"));
  const used = m.diskTotal ? clamp(((m.diskTotal - m.diskFree) / m.diskTotal) * 100) : null;
  out.push(used != null
    ? dial("disk", "Disk", `${(m.diskFree / 1e9).toFixed(0)} GB free`, `${used.toFixed(0)} % used`, used, "past the line")
    : dial("disk", "Disk", "—", "", null, "past the line"));
  out.push(dial("load", "Load", m.load1.toFixed(2), `1 min · ${m.cores} cores`, m.cores ? clamp((m.load1 / m.cores) * 100) : null, "overloaded"));
  if (m.tempC != null) out.push(dial("temp", "Temp", `${m.tempC.toFixed(0)} °C`, "hottest sensor", clamp(m.tempC), "running hot"));
  return out;
}

/** Past the line the sub-line says the word, so amber is never the only signal. */
export const dialSub = (d: Dial): string => (d.hot && d.word ? d.word : d.sub);

const RING_R = 16;
export const RING = { r: RING_R, c: 2 * Math.PI * RING_R };
/** `stroke-dasharray` for a ring that is `pct` full; null draws no arc (nothing measured is not zero). */
export const ringDash = (pct: number | null): string | null => (pct == null ? null : `${(RING.c * pct) / 100} ${RING.c}`);

// ------------------------------------------------------------------- tree ----

/** The checkout a path is in: the longest registered root that contains it, so a worktree wins over the project it was cut from. */
export function bestRepo(repos: GitRepoRef[], cwd: string | null): GitRepoRef | null {
  if (!cwd) return null;
  let best: GitRepoRef | null = null;
  for (const r of repos) {
    if (cwd !== r.root && !cwd.startsWith(r.root + "/")) continue;
    if (!best || r.root.length > best.root.length) best = r;
  }
  return best;
}

export const baseName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

export interface TreeLeaf { key: string; label: string; procs: ProcEntry[]; cpu: number; rss: number }
export interface TreeNode { key: string; label: string; kids: TreeLeaf[]; cpu: number; rss: number }

/**
 * Ours, as project, checkout, process. Grouping by the raw cwd produced rows
 * called the home directory and "dist"; the repo list turns those into the two
 * questions asked. Anything in no known checkout lands in one "Elsewhere" row.
 * Filtered before grouping, so a checkout with no match disappears.
 */
export function treeOf(procs: ProcEntry[], repos: GitRepoRef[], q: string): TreeNode[] {
  const byProject = new Map<string, TreeNode>();
  const loose: TreeLeaf = { key: "~elsewhere", label: "Elsewhere", procs: [], cpu: 0, rss: 0 };
  const needle = q.trim().toLowerCase();
  const keep = (p: ProcEntry) => !needle || [p.comm, p.cmd, p.cwd ?? "", String(p.pid)].some((s) => s.toLowerCase().includes(needle));
  for (const p of procs.filter(keep)) {
    if (!p.ours) continue;
    const repo = bestRepo(repos, p.cwd);
    if (!repo) { loose.procs.push(p); loose.cpu += p.cpu ?? 0; loose.rss += p.rss; continue; }
    const projectRoot = repo.worktreeOf ?? repo.root;
    const node = byProject.get(projectRoot) ?? { key: projectRoot, label: baseName(projectRoot), kids: [], cpu: 0, rss: 0 };
    let leaf = node.kids.find((k) => k.key === repo.root);
    if (!leaf) {
      // A worktree IS its branch; the main checkout is named by its directory.
      leaf = { key: repo.root, label: repo.worktreeOf ? repo.branch : baseName(repo.root), procs: [], cpu: 0, rss: 0 };
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
}

/** How many samples the sparklines remember. */
export const HISTORY = 24;

/** Append to a bounded history, bounded here so a dialog left open does not hold an hour of numbers. */
export function pushSample(m: Map<string, number[]>, key: string, v: number): void {
  const arr = m.get(key) ?? [];
  arr.push(v);
  if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
  m.set(key, arr);
}

/** Binary units, like the process tree always had; the dials and the disk plan are decimal. */
export const mb = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** The sparkline's points in a 60 x 14 box, scaled to the line's own maximum (floor 0.5). */
export function sparkPoints(values: number[]): string {
  const max = Math.max(0.5, ...values);
  const step = 60 / Math.max(1, values.length - 1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${(13 - (v / max) * 12).toFixed(1)}`).join(" ");
}

// -------------------------------------------------------------- disk plan ----

export interface PlanGroup { lines: DiskCleanLine[]; bytes: number }
const sizeOf = (lines: DiskCleanLine[]): PlanGroup => ({ lines, bytes: lines.reduce((n, l) => n + (l.bytes ?? 0), 0) });

/** Safe (the plan), Look first (yours to decide), and In use / information (stays; shown so the numbers add up). */
export function groupsOf(lines: readonly DiskCleanLine[]): { safe: PlanGroup; ask: PlanGroup; info: PlanGroup } {
  const sorted = sortLines(lines);
  return {
    safe: sizeOf(sorted.filter((l) => l.verdict === "safe")),
    ask: sizeOf(sorted.filter((l) => l.verdict === "ask")),
    info: sizeOf(sorted.filter((l) => l.verdict === "inuse" || l.verdict === "explain")),
  };
}

/** One mount's bar: grey for what is used, a striped tail for what the plan would give back, amber under the setting. */
export function mountBar(m: DiskCleanMount, warnPct: number): { usedPct: number; safePct: number; greyPct: number; low: boolean } {
  const usedPct = m.size > 0 ? Math.min(100, ((m.size - m.free) / m.size) * 100) : 0;
  const safePct = m.size > 0 ? Math.min(usedPct, (m.safeBytes / m.size) * 100) : 0;
  const freePct = m.size > 0 ? (m.free / m.size) * 100 : null;
  return { usedPct, safePct, greyPct: usedPct - safePct, low: freePct !== null && freePct < warnPct };
}

// -------------------------------------------------------------- the rest ----

/** The eight biggest folders, each bar relative to the biggest and never under 2 %. */
export function breakdownRows(dirs: SpaceDir[]): (SpaceDir & { pct: number })[] {
  const top = Math.max(1, dirs[0]?.bytes ?? 1);
  return dirs.slice(0, 8).map((d) => ({ ...d, pct: Math.max(2, Math.round((d.bytes / top) * 100)) }));
}

/**
 * The host's CPU, load and temperature have no event source. While Docker's
 * stats feed is streaming, each sample may ask for one new reading, at most once
 * per `gap` and never while one is in flight; with no feed, a reading is taken on
 * open, on window focus and on Refresh, and that is all.
 */
export const resampleDue = (now: number, last: number, gap: number, inFlight: boolean): boolean => !inFlight && now - last >= gap;

/** Stale lock files (nothing holds them) and the ones a live git holds. */
export function lockGroups(locks: GitLock[]): { stuck: GitLock[]; held: GitLock[] } {
  return { stuck: locks.filter((l) => l.stale), held: locks.filter((l) => !l.stale) };
}
