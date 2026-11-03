/*
 * The Docker panel's live feed: `GET /docker/live`, server-sent events.
 *
 * The panel used to ask the daemon for everything every five seconds (116
 * spawns a minute at eight containers, measured) whether or not anything had
 * happened. Docker already volunteers what changes, so the panel now waits for
 * it: ONE `docker events` and ONE streaming `docker stats` serve every open
 * panel, and neither exists while nobody is listening.
 *
 *   - ref-counted: the first client starts both processes, the last one out
 *     kills them. A leaked stream would be a docker process for the life of the
 *     server, which is the failure dockerwatch.ts was written around, so the
 *     processes go through the same wrapper (it takes docker down with us);
 *   - an event says WHICH list changed, never the new contents. Bursts are
 *     coalesced for 250 ms: `compose up` of eight services is dozens of events
 *     and one refetch;
 *   - a daemon that goes away is a message, then a retry with capped backoff on
 *     this side only. The backoff re-spawns a process that died; it never
 *     re-reads anything on a timer.
 *
 * Ceiling: stats are the whole host's running containers, not only the panel's
 * scope (`docker stats` streams everything it is not told to skip); the
 * client keeps the ids it shows.
 */
import type { DockerLiveMessage, DockerLiveScope, DockerStat } from "../../shared/types.ts";
import { dockerBin, invalidateOverview, statFromRow } from "./docker.ts";
import { spawnWatched } from "./dockerwatch.ts";

const COALESCE_MS = 250;
const STATS_FLUSH_MS = 150;
/** A process that lived this long counts as connected: `docker events` says nothing when nothing happens. */
const UP_AFTER_MS = 1500;
/** Open feeds at once. One per window and phone is normal; more is a leak. */
const MAX_CLIENTS = 12;
/** Under the server's 255 s idle limit, so a quiet feed is not cut. */
const HEARTBEAT_MS = 120_000;

let backoffBase = 1000;
/** Test seam: the retry clock. */
export function __setBackoffBaseForTest(ms: number): void { backoffBase = ms; }
/** Seconds between retries: 1, 2, 4 … 30. */
export const backoffMs = (fails: number): number => Math.min(30_000, backoffBase * 2 ** Math.min(fails, 16));

/* ---- what an event means ------------------------------------------------- */

// Only actions that change what a list shows. A health check execs inside the
// container every few seconds (`exec_start`, `exec_die`) and `volume mount`
// fires for every container start: neither is a change worth a refetch.
const CHANGES: Record<string, Record<string, DockerLiveScope[]>> = {
  container: {
    // The image's "containers" count moves with a container's creation and removal.
    create: ["containers", "images"], destroy: ["containers", "images"],
    start: ["containers"], die: ["containers"], pause: ["containers"], unpause: ["containers"],
    rename: ["containers"], restart: ["containers"], oom: ["containers"], update: ["containers"],
    health_status: ["containers"],
  },
  image: { pull: ["images"], tag: ["images"], untag: ["images"], delete: ["images"], import: ["images"], load: ["images"], prune: ["images"] },
  volume: { create: ["volumes"], destroy: ["volumes"], prune: ["volumes"] },
  network: { create: ["networks"], destroy: ["networks"], connect: ["networks"], disconnect: ["networks"], remove: ["networks"], prune: ["networks"] },
};

/** The lists one `docker events` line changes (empty for noise and for lines that are not events). */
export function scopesFor(line: string): DockerLiveScope[] {
  try {
    const ev = JSON.parse(line) as { Type?: string; type?: string; Action?: string; status?: string };
    // "health_status: healthy", "exec_start: /bin/true": the verb is before the colon.
    const action = String(ev.Action ?? ev.status ?? "").split(":")[0]!.trim();
    return CHANGES[String(ev.Type ?? ev.type ?? "")]?.[action] ?? [];
  } catch { return []; }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Rows out of a piece of `docker stats` stream: it clears the screen between samples even with --format. */
export function statsFromChunk(text: string): DockerStat[] {
  const rows: DockerStat[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(ANSI, "").trim();
    if (!line.startsWith("{")) continue;
    try { rows.push(statFromRow(JSON.parse(line))); } catch { /* half a line */ }
  }
  return rows;
}

/* ---- one long-lived docker process, restarted with backoff ---------------- */

class Watched {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private upTimer: ReturnType<typeof setTimeout> | null = null;
  private fails = 0;
  private running = false;

  constructor(
    private args: string[],
    private onLine: (line: string) => void,
    /** false once on each loss, true once the process has proved itself. */
    private onState: (up: boolean) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fails = 0;
    this.spawn();
  }

  stop(): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    if (this.upTimer) clearTimeout(this.upTimer);
    this.retry = this.upTimer = null;
    const p = this.proc;
    this.proc = null;
    // The wrapper's trap takes docker down with it; `exited` is awaited by Bun, so no zombie stays.
    try { p?.kill(); } catch { /* already gone */ }
  }

  /** The daemon is known to be back: do not sit out the rest of the backoff. */
  nudge(): void {
    if (!this.running || this.proc || !this.retry) return;
    clearTimeout(this.retry);
    this.retry = null;
    this.spawn();
  }

  private spawn(): void {
    this.retry = null;
    const bin = dockerBin();
    let p: ReturnType<typeof Bun.spawn>;
    try {
      if (!bin) throw new Error("no docker");
      p = spawnWatched(bin, this.args);
    } catch { this.lost(); return; }
    this.proc = p;
    this.upTimer = setTimeout(() => {
      if (this.proc !== p) return;
      this.fails = 0;
      this.onState(true);
    }, UP_AFTER_MS);

    void (async () => {
      const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          if (this.proc === p) for (const l of lines) if (l.trim()) this.onLine(l);
        }
      } catch { /* the process died; `exited` below deals with it */ }
    })();

    void p.exited.then(() => {
      if (this.proc !== p) return;     // stopped on purpose
      this.proc = null;
      this.lost();
    });
  }

  private lost(): void {
    if (this.upTimer) clearTimeout(this.upTimer);
    this.upTimer = null;
    if (!this.running) return;
    this.onState(false);
    this.retry = setTimeout(() => this.spawn(), backoffMs(this.fails++));
  }
}

/* ---- the shared feed ------------------------------------------------------ */

type Send = (m: DockerLiveMessage) => void;
const clients = new Set<Send>();
let phase: "starting" | "up" | "down" = "starting";
let pending = new Set<DockerLiveScope>();
let coalesce: ReturnType<typeof setTimeout> | null = null;
let statsBatch: string[] = [];
let statsFlush: ReturnType<typeof setTimeout> | null = null;

function broadcast(m: DockerLiveMessage): void {
  for (const send of clients) { try { send(m); } catch { /* that client is going away */ } }
}

const events = new Watched(
  ["events", "--filter", "type=container", "--filter", "type=image", "--filter", "type=volume", "--filter", "type=network", "--format", "{{json .}}"],
  (line) => {
    const scopes = scopesFor(line);
    if (!scopes.length) return;
    for (const s of scopes) pending.add(s);
    coalesce ??= setTimeout(() => {
      coalesce = null;
      const out = pending;
      pending = new Set();
      // The 5.5 s overview cache would answer the refetch with the world before the event.
      invalidateOverview();
      for (const scope of out) broadcast({ kind: "changed", scope });
    }, COALESCE_MS);
  },
  (up) => {
    if (up) {
      const was = phase;
      phase = "up";
      if (was === "down") { stats.nudge(); broadcast({ kind: "up" }); }
    } else if (phase !== "down") {
      phase = "down";
      broadcast({ kind: "down" });
    }
  },
);

const stats = new Watched(
  ["stats", "--no-trunc", "--format", "{{json .}}"],
  (line) => {
    statsBatch.push(line);
    statsFlush ??= setTimeout(() => {
      statsFlush = null;
      const byId = new Map(statsFromChunk(statsBatch.join("\n")).map((s) => [s.id, s]));
      statsBatch = [];
      if (byId.size) broadcast({ kind: "stats", stats: [...byId.values()] });
    }, STATS_FLUSH_MS);
  },
  () => { /* the events process speaks for the daemon */ },
);

function startAll(): void {
  phase = "starting";
  events.start();
  stats.start();
}

function stopAll(): void {
  events.stop();
  stats.stop();
  for (const t of [coalesce, statsFlush]) if (t) clearTimeout(t);
  coalesce = statsFlush = null;
  pending = new Set();
  statsBatch = [];
  phase = "starting";
}

/** Listen to the feed; the returned function stops listening. Null when too many are already. */
export function subscribe(send: Send): (() => void) | null {
  if (clients.size >= MAX_CLIENTS) return null;
  clients.add(send);
  if (clients.size === 1) startAll();
  else if (phase === "down") send({ kind: "down" });
  let left = false;
  return () => {
    if (left) return;
    left = true;
    clients.delete(send);
    if (!clients.size) stopAll();
  };
}

/** `GET /docker/live`. */
export function liveResponse(signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let beat: ReturnType<typeof setInterval> | null = null;
  let off: (() => void) | null = null;
  const leave = () => {
    if (beat) clearInterval(beat);
    beat = null;
    off?.();
    off = null;
    try { controller.close(); } catch { /* already closed */ }
  };
  const write = (text: string) => { try { controller.enqueue(enc.encode(text)); } catch { leave(); } };
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: leave });

  off = subscribe((m) => write(`data: ${JSON.stringify(m)}\n\n`));
  if (!off) return new Response(JSON.stringify({ ok: false, error: "too many live docker feeds are already open" }), { status: 429, headers: { "content-type": "application/json" } });
  // The comment makes the browser's `open` fire now instead of at the first event.
  write("retry: 2000\n: open\n\n");
  beat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
  signal.addEventListener("abort", leave, { once: true });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
