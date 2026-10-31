/*
 * What the container detail decides, out of the components: the red line under
 * the header, the four stat cards, what a log line is and how the levels count,
 * how a find walks its matches, what pause says, and how the environment and
 * the process list read. The screen has no renderer in tests, so each of these
 * is a function that can be broken on purpose.
 */
import type { DockerContainer, DockerStat } from "../../../shared/types.ts";
import { isSecret } from "../../../shared/dockerSecret.ts";
import { portLabel, portUrl } from "./dockerRow.ts";
import { exitCode, kindOf } from "./dockerState.ts";
import { levelOf } from "./dockerLogFeed.ts";
import { meterOf } from "./dockerView.ts";

/* ----------------------------------------------------------- the red line */

export interface HealthLine {
  tone: "bad" | "amb";
  /** The bold opening. */
  lead: string;
  /** The probe's own words, when it said any. */
  code?: string;
  rest: string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const bare = (s: string | undefined): string => (s ?? "").replace(/^Up /, "").replace(/ \([^)]*\)$/, "");

/** Why a container needs you, in a sentence; null when it does not. */
export function healthLine(c: DockerContainer): HealthLine | null {
  const k = kindOf(c);
  const restarts = c.restarts === undefined ? "" : `, ${plural(c.restarts, "restart")}`;
  if (k === "unhealthy") {
    const n = c.healthFailures ?? 0;
    const probe = c.healthError?.split("\n")[0]?.trim().slice(0, 160);
    return {
      tone: "bad", lead: n > 1 ? `Health check failing ${n} times in a row:` : "Health check failing:",
      ...(probe ? { code: probe } : {}), rest: `Up ${bare(c.uptime ?? c.status)}${restarts}.`,
    };
  }
  if (k === "restarting") {
    const last = /^Restarting \((-?\d+)\)/.exec(c.status || "")?.[1];
    const lead = c.restarts === undefined ? "" : `${plural(c.restarts, "restart")}${last ? `, last exit code ${last}` : ""}. `;
    return { tone: "amb", lead: "Restart loop:", rest: `${lead}Docker keeps trying.` };
  }
  if (k === "crash") {
    return { tone: "bad", lead: `Exited with code ${exitCode(c)}`, rest: `${(c.status || "").replace(/^Exited \(-?\d+\) /, "")}. It was not stopped by you.` };
  }
  if (k === "dead") return { tone: "bad", lead: "Docker marked this container dead.", rest: "It cannot be started again; remove it and recreate it." };
  return null;
}

/* ---------------------------------------------------------------- the cards */

export interface Facts {
  up: { value: string; sub: string };
  cpu: { text: string; pct: number | null; hot: boolean };
  mem: { text: string; sub: string; pct: number | null; hot: boolean };
}

export function factsOf(c: DockerContainer, stat: DockerStat | undefined): Facts {
  const state = (c.state || "").toLowerCase();
  const restarts = c.restarts === undefined ? "" : plural(c.restarts, "restart");
  let up: Facts["up"];
  if (state === "running" || state === "paused") up = { value: bare(c.uptime ?? c.status), sub: restarts };
  else if (state === "restarting") up = { value: "Restarting", sub: restarts };
  else if (state === "created") up = { value: "Not started", sub: "created, never run" };
  else if (state === "dead") up = { value: "Dead", sub: "" };
  else up = { value: "Stopped", sub: (c.status || "").replace(/^Exited \(-?\d+\) /, "") };
  const m = meterOf(stat, state === "running");
  return {
    up,
    cpu: m.cpu == null ? { text: "—", pct: null, hot: false } : { text: `${m.cpu.toFixed(1)} %`, pct: m.cpu, hot: m.cpuHot },
    mem: m.mem == null
      ? { text: "—", sub: "", pct: null, hot: false }
      : { text: `${Math.round(m.mem)} %`, sub: stat!.memUsage.replace("/", "of"), pct: m.mem, hot: m.memHot },
  };
}

export interface PortChip { kind: "web" | "plain" | "off"; label: string; url?: string; title: string }

export function portChips(c: DockerContainer): PortChip[] {
  const running = (c.state || "").toLowerCase() === "running";
  return (c.portList ?? []).map((p): PortChip => {
    const url = portUrl(p);
    if (!running) return { kind: "off", label: portLabel(p), title: "Published when it runs" };
    if (url) return { kind: "web", label: url.replace(/^https?:\/\//, ""), url, title: `Open ${url} in the browser tab` };
    return {
      kind: "plain", label: portLabel(p),
      title: p.host === null ? "Exposed by the image, not published to the host" : "Published, but not a web port",
    };
  });
}

/* ------------------------------------------------------------------ the log */

export type Level3 = "error" | "warn" | "info";
export type LevelPick = "all" | Level3;

export interface LogEntry {
  /** HH:MM:SS, or null when the line carries no stamp. */
  time: string | null;
  stamp: string | null;
  text: string;
  level: Level3;
  /** The line said its own level; false when it was inherited or assumed. */
  tagged: boolean;
}

const STAMP = /^(\S*\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s?/;

/**
 * Lines into entries. Debug reads as info, so the three counts add up to all.
 * An indented line with no level of its own takes the one above it: a stack
 * trace stays with the error that printed it instead of falling out of the
 * Errors filter.
 */
export function readLog(lines: string[]): LogEntry[] {
  let prev: Level3 = "info";
  return lines.map((line) => {
    const m = STAMP.exec(line);
    const text = m ? line.slice(m[0].length) : line;
    const own = levelOf(text);
    const tagged = own !== null;
    const level: Level3 = own === "error" ? "error" : own === "warn" ? "warn" : tagged ? "info" : /^\s/.test(text) ? prev : "info";
    prev = level;
    return { time: m ? (/[T ](\d{2}:\d{2}:\d{2})/.exec(m[1]!)?.[1] ?? null) : null, stamp: m?.[1] ?? null, text, level, tagged };
  });
}

export const levelCounts = (e: LogEntry[]) => ({
  all: e.length,
  error: e.filter((x) => x.level === "error").length,
  warn: e.filter((x) => x.level === "warn").length,
  info: e.filter((x) => x.level === "info").length,
});

export const shownBy = (e: LogEntry[], pick: LevelPick): LogEntry[] => (pick === "all" ? e : e.filter((x) => x.level === pick));

/** The last line that says it is at this level, -1 for none. */
export function lastIndexOf(e: LogEntry[], level: Level3): number {
  for (let i = e.length - 1; i >= 0; i--) if (e[i]!.tagged && e[i]!.level === level) return i;
  return -1;
}

const needle = (q: string): string => q.trim().toLowerCase();

/** Every match in every line; `offsets[i]` is the number of the first match in line i. */
export function hitsIn(e: LogEntry[], q: string): { offsets: number[]; total: number } {
  const n = needle(q);
  let total = 0;
  const offsets = e.map((x) => {
    const at = total;
    if (n) { const hay = x.text.toLowerCase(); for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) total++; }
    return at;
  });
  return { offsets, total };
}

export function markSegments(text: string, q: string, first: number): { t: string; hit: number | null }[] {
  const n = needle(q);
  if (!n) return [{ t: text, hit: null }];
  const hay = text.toLowerCase();
  const out: { t: string; hit: number | null }[] = [];
  let at = 0, hit = first;
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, at)) {
    if (i > at) out.push({ t: text.slice(at, i), hit: null });
    out.push({ t: text.slice(i, i + n.length), hit: hit++ });
    at = i + n.length;
  }
  if (at < text.length) out.push({ t: text.slice(at), hit: null });
  return out;
}

export const stepHit = (at: number, total: number, dir: 1 | -1): number => (total <= 0 ? 0 : (((at + dir) % total) + total) % total);

export const pauseLabel = (paused: boolean, waiting: number): string =>
  !paused ? "Pause" : waiting ? `Resume · ${waiting} waiting` : "Resume";

export type StreamKey = "live" | "paused" | "ended" | "snapshot";

/** What the chip in the log toolbar says. A container that is not running was only ever read once. */
export function streamChip(i: { running: boolean; ended: string | null; paused: boolean }): { key: StreamKey; word: string } {
  if (!i.running) return { key: "snapshot", word: "Snapshot" };
  if (i.ended) return { key: "ended", word: "Stream ended" };
  return i.paused ? { key: "paused", word: "Paused" } : { key: "live", word: "Live" };
}

/* ------------------------------------------------------- environment & top */

export interface EnvRow { key: string; value: string; secret: boolean }

export function envRows(lines: string[], q: string): EnvRow[] {
  const n = needle(q);
  return lines
    .map((line): EnvRow => {
      const eq = line.indexOf("=");
      const key = eq < 0 ? line : line.slice(0, eq);
      return { key, value: eq < 0 ? "" : line.slice(eq + 1), secret: isSecret(key) };
    })
    .filter((r) => !n || r.key.toLowerCase().includes(n));
}

export const envSummary = (lines: string[]): string =>
  `${plural(lines.length, "variable")} · ${envRows(lines, "").filter((r) => r.secret).length} hidden`;

export interface ProcRow { pid: string; user: string; cpu: string; cmd: string; depth: number }

/**
 * `docker top` as a tree by parent pid. Null when the header has no pid or
 * command column, so the caller can show the text as it came.
 */
export function topTree(text: string): ProcRow[] | null {
  const [head, ...body] = text.trim().split("\n");
  if (!head) return null;
  const cols = head.trim().split(/\s+/).map((h) => h.toLowerCase());
  const at = (re: RegExp) => cols.findIndex((h) => re.test(h));
  const [pid, ppid, cmd, user, cpu] = [at(/^pid$/), at(/^ppid$/), at(/^(cmd|command)$/), at(/^(uid|user)$/), at(/^(c|%cpu)$/)];
  if (pid < 0 || cmd < 0) return null;
  const rows = body.filter((l) => l.trim()).map((l) => {
    const t = l.trim().split(/\s+/);
    return { pid: t[pid] ?? "", ppid: ppid < 0 ? "" : (t[ppid] ?? ""), user: user < 0 ? "" : (t[user] ?? ""), cpu: cpu < 0 ? "" : (t[cpu] ?? ""), cmd: t.slice(cmd).join(" ") };
  });
  const known = new Set(rows.map((r) => r.pid));
  const kids = new Map<string, typeof rows>();
  for (const r of rows) {
    const root = !known.has(r.ppid) || r.ppid === r.pid;
    const key = root ? "" : r.ppid;
    kids.set(key, [...(kids.get(key) ?? []), r]);
  }
  const out: ProcRow[] = [];
  const walk = (key: string, depth: number) => {
    for (const r of (kids.get(key) ?? []).sort((a, b) => Number(a.pid) - Number(b.pid))) {
      out.push({ pid: r.pid, user: r.user, cpu: r.cpu, cmd: r.cmd, depth });
      if (depth < 32) walk(r.pid, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
