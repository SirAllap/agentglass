// Main-server side of the terminal relay: starts it, keeps it alive, mints the
// tickets that open its door, and gives terminal.ts a socket-shaped proxy so
// ptyOpen/ptyMessage/ptyClose run unchanged for a connection the relay holds.
// Imports no code that opens the database and none from terminal.ts (that one
// imports THIS, for `laneOf`): the three handlers are handed in by index.ts.
// See wire.ts for why the relay exists and termrelay.ts for what it does.
import { basename } from "node:path";
import { ptyDataFrom } from "./ptyData.ts";
import { MAX_QUERY, lineSplitter, restartDelay } from "./wire.ts";
import type { FromRelay, TicketFacts, ToRelay } from "./wire.ts";

type Ws = any; // the ServerWebSocket subset terminal.ts touches: data, send, close, getBufferedAmount
export type RelayHandlers = { open(ws: Ws): void; message(ws: Ws, raw: string): void; close(ws: Ws): void };

const LANE = Symbol("relayLane");

/** What terminal.ts spawns through instead of Bun.spawn when the window came
 *  in through the relay. */
export type Lane = {
  spawn(argv: string[], o: { cwd: string; env: Record<string, string>; tap: boolean }): ReturnType<typeof Bun.spawn>;
  /** Output happened on the lane; `bytes` only when spawned with `tap`. */
  onOut: ((bytes: Uint8Array | null) => void) | null;
  /** The window typed: stands in for `terminalActive()` on the keystroke path. */
  onKeys: (() => void) | null;
};

type Conn = { id: number; ws: Ws; lane: Lane; pid: number; exit: (code: number) => void; spawned: boolean };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let gen = 0;
let handlers: RelayHandlers | null = null;
let log: (line: string) => void = (l) => console.warn(l);
const conns = new Map<number, Conn>();
const facts = new Map<string, { f: TicketFacts; until: number }>();
const deaths: number[] = [];
let stopping = false;
/** What a connect needs, with room for a stalled main. Short on purpose: a ticket outlives nothing it was minted for. */
const TICKET_MS = 45_000;
const READY_MS = 5000;

export const relayPid = (): number | null => child?.pid ?? null;

export const laneOf = (ws: unknown): Lane | null => (ws as { [LANE]?: Lane } | null)?.[LANE] ?? null;
const upWaiters: (() => void)[] = [];
/** The longest a ticket request waits for a relay that is still starting. */
export const RELAY_UP_WAIT_MS = 3_000;

/**
 * Resolves true once the relay has said it is listening, false after `ms`.
 *
 * The relay is a child that starts after the server: measured on the
 * installed app, "server started" at one moment and the relay's "up" 714 ms
 * later. The window asks for its first ticket as soon as the server answers,
 * inside that gap; the answer was "no relay", the window set the relay aside
 * for 30 s, and its terminal took the in-process door for the rest of its
 * life (one bridge under the server, none under the relay, with the relay
 * running). A ticket request now waits here for the relay instead.
 */
export function relayUp(ms = RELAY_UP_WAIT_MS): Promise<boolean> {
  if (child && port) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = () => { clearTimeout(t); resolve(true); };
    // loop-ok: drops one waiter
    const t = setTimeout(() => { const i = upWaiters.indexOf(done); if (i >= 0) upWaiters.splice(i, 1); resolve(false); }, ms);
    upWaiters.push(done);
  });
}

export const relayInfo = (): { port: number; gen: number } | null => (child && port ? { port, gen } : null);

const send = (m: ToRelay) => {
  const stdin = child?.stdin as { write(s: string): void; flush(): void } | undefined;
  if (!stdin) return; // relay gone: its exit handler cleans up
  try { stdin.write(JSON.stringify(m) + "\n"); stdin.flush(); } catch { /* same */ }
};

/** argv that starts this same program in the relay role. Compiled, the binary
 *  is its own second entry point; under `bun run` it is the entry script. */
export function relayArgv(execPath: string, entry: string): string[] {
  const dev = /^bun(\.exe)?$/.test(basename(execPath));
  return dev ? [execPath, "--no-env-file", "run", entry] : [execPath];
}

function proxyFor(id: number, data: unknown): { ws: Ws; conn: Conn } {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => { exit = r; });
  const conn: Conn = { id, ws: null, pid: 0, exit, spawned: false, lane: null as unknown as Lane };
  const lane: Lane = {
    onOut: null,
    onKeys: null,
    spawn(argv, o) {
      conn.spawned = true;
      send({ op: "spawn", conn: id, argv, cwd: o.cwd, env: o.env, tap: o.tap });
      return {
        get pid() { return conn.pid; },
        stdin: { write: (b: Uint8Array) => send({ op: "write", conn: id, b64: Buffer.from(b).toString("base64") }), flush: () => {} },
        exited,
        stdout: null,
        stderr: null,
        kill: (sig?: number | NodeJS.Signals) => { try { if (conn.pid) process.kill(conn.pid, sig as NodeJS.Signals); } catch { /* gone */ } },
      } as unknown as ReturnType<typeof Bun.spawn>;
    },
  };
  conn.lane = lane;
  conn.ws = {
    data, [LANE]: lane, readyState: 1, remoteAddress: "127.0.0.1",
    send(x: unknown) { if (typeof x === "string") send({ op: "send", conn: id, text: x }); return 1; },
    close(code = 1000, reason = "") { send({ op: "close", conn: id, code, reason }); },
    getBufferedAmount: () => 0,
  };
  return { ws: conn.ws, conn };
}

function onMessage(m: FromRelay) {
  if (m.op === "ready") { port = m.port; gen++; log(`[termrelay] up on 127.0.0.1:${port}`); for (const w of upWaiters.splice(0)) w(); return; }
  if (m.op === "open") {
    const t = facts.get(m.ticket); facts.delete(m.ticket);
    if (!t || t.until < Date.now() || m.query.length > MAX_QUERY || !handlers) { send({ op: "close", conn: m.conn, code: 4401, reason: "ticket" }); return; }
    // Local and deviceless by construction: tickets are only minted for the
    // window on this machine's loopback (see mintTickets), never a paired phone.
    const data = ptyDataFrom(new URLSearchParams(m.query), { ...t.f, local: true, deviceId: null });
    const { ws, conn } = proxyFor(m.conn, data);
    conns.set(m.conn, conn);
    handlers.open(ws);
    return;
  }
  const c = conns.get(m.conn);
  if (!c) return;
  if (m.op === "msg") handlers?.message(c.ws, m.text);
  else if (m.op === "closed") { c.pid = 0; conns.delete(m.conn); handlers?.close(c.ws); c.exit(-1); }
  else if (m.op === "spawned") c.pid = m.pid;
  else if (m.op === "failed") { log(`[termrelay] spawn failed: ${m.error}`); c.exit(127); }
  else if (m.op === "out") c.lane.onOut?.(m.b64 ? Buffer.from(m.b64, "base64") : null);
  else if (m.op === "keys") c.lane.onKeys?.();
  else if (m.op === "exited") { c.pid = 0; c.exit(m.code); }
}

function launch(): boolean {
  const argv = relayArgv(process.execPath, new URL("../index.ts", import.meta.url).pathname);
  try {
    child = Bun.spawn(argv, {
      // No token, no database path: the relay is told what to run per terminal.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTGLASS_RELAY_CHILD: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
  } catch (e) { child = null; log(`[termrelay] cannot start (${String(e)}); terminal stays in-process`); return false; }
  const me = child;
  // A relay that hangs before `ready` never exits on its own: without this the
  // feature would be silently off until the server restarts. Killing it
  // counts as a death below.
  // loop-ok: kills one child
  const hung = setTimeout(() => { if (child === me && !port) { log("[termrelay] no ready in 5 s; killing it"); try { me.kill(); } catch { /* gone */ } } }, READY_MS);
  (async () => {
    const split = lineSplitter();
    const dec = new TextDecoder();
    try { for await (const chunk of me.stdout as ReadableStream<Uint8Array>) for (const l of split(dec.decode(chunk, { stream: true }))) { try { onMessage(JSON.parse(l) as FromRelay); } catch { /* not ours */ } } } catch { /* ended */ }
  })();
  me.exited.then(() => {
    clearTimeout(hung);
    if (child !== me) return;
    child = null; port = 0; facts.clear();
    // Shells the relay held are orphaned: hang them up through the normal close path.
    for (const c of [...conns.values()]) { conns.delete(c.id); try { handlers?.close(c.ws); } catch { /* already gone */ } c.exit(-1); }
    if (stopping) return;
    deaths.push(Date.now());
    const wait = restartDelay(deaths, Date.now());
    if (wait === null) { log("[termrelay] died 4 times in a minute; terminal stays in-process until the server restarts"); return; }
    log(`[termrelay] exited; restarting in ${wait} ms (the window reconnects)`);
    // loop-ok: relaunches one child
    setTimeout(() => { if (!stopping && !child) launch(); }, wait);
  });
  return true;
}

export function startRelay(h: RelayHandlers, logLine?: (l: string) => void): void {
  handlers = h;
  if (logLine) log = logLine;
  launch();
}

export function stopRelay(): void {
  stopping = true;
  try { (child?.stdin as { end(): void } | undefined)?.end(); } catch { /* gone */ }
}

/**
 * Tickets for the window's own relay connections. The caller has already
 * passed the same `trustedCaller` check as the in-process socket; refusing
 * anything but this machine's loopback keeps a paired phone on the old door
 * (its disconnect-a-device and LAN handling live there).
 * Null when the relay is down: the client then uses the in-process path.
 */
export function mintTickets(n: number, f: TicketFacts, now = Date.now()): { port: number; gen: number; tickets: string[] } | null {
  const info = relayInfo();
  if (!info) return null;
  for (const [k, v] of facts) if (v.until < now) facts.delete(k);
  const tickets: string[] = [];
  for (let i = 0; i < Math.min(Math.max(n, 1), 4) && facts.size < 64; i++) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    facts.set(id, { f, until: now + TICKET_MS });
    send({ op: "ticket", id });
    tickets.push(id);
  }
  return { ...info, tickets };
}
