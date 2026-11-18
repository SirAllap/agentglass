// The terminal relay process. Runs as a second role of the server binary (see
// gate.ts), speaks to the main server in JSON lines on stdin/stdout, and owns
// the whole byte path of a terminal: the WebSocket to the window, the Python
// bridge on the pty, and the coalescing and backpressure between them. It
// imports only wire.ts and node/bun built-ins: never db.ts, never terminal.ts.
// What a terminal IS (which shell, which tmux, scope, agents) stays decided in
// main; this process only moves the bytes once main has said what to run.
import { MAX_QUERY, TicketBook, lineSplitter, relayOriginOk } from "./wire.ts";
import type { FromRelay, ToRelay } from "./wire.ts";

const FRAME_MS = 8;            // hold output for one frame's time, as the old pump did
const BIG = 64 * 1024;         // send at once rather than wait out the frame
const HIGH_WATER = 512 * 1024; // socket queue past which we stop reading the pty
const OUT_NUDGE_MS = 50;       // main's tmux sweep wants "output happened", not every chunk

type Conn = {
  id: number;
  ws: import("bun").ServerWebSocket<{ id: number }>;
  proc?: ReturnType<typeof Bun.spawn>;
  closed: boolean;
  tap: boolean;
  tapHeld: Uint8Array[];
  tapBytes: number;
  nudge: ReturnType<typeof setTimeout> | null;
  lastKeys: number;
  /** Frames that arrive between the upgrade and main's `spawn` answer. */
  pending: (string | Buffer)[];
  pendingBytes: number;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function run(): Promise<never> {
  const tickets = new TicketBook();
  const conns = new Map<number, Conn>();
  let next = 1;
  const queuedOpen = new Map<number, { ticket: string; query: string }>();
  /*
   * The channel to main, which is the one thing here that can be slow: main is
   * the loop that stalls for 5-31 s, and it reads this pipe. `process.stdout.write`
   * buffers without limit (measured: 5 MB accepted into a pipe nobody read, no
   * signal), so a stalled main would grow this process unboundedly. A FileSink's
   * `flush()` returns a promise exactly while the pipe is full, which is the
   * signal used here. Terminal bytes never wait on it: they go to the window.
   *   - Critical (open, msg, closed, spawned, failed, exited): always written,
   *     but a window whose own frames pile up past HARD_BYTES while main is
   *     blocked is closed (4413) rather than buffered.
   *   - Informational (keys, output nudges): DROPPED while blocked. A nudge is
   *     remembered as a flag per window and re-sent once the pipe drains; keys
   *     are only a "someone is typing" hint and are not replayed. The `tap`
   *     copy of output (prompt parsing in main) keeps its newest TAP_CAP bytes
   *     per window and loses older ones: a missed prompt mark, never output.
   */
  const sink = Bun.stdout.writer();
  const HARD_BYTES = 4 * 1024 * 1024;
  const TAP_CAP = 256 * 1024;
  let blocked = false;
  let queued = 0;
  const owing = new Set<number>();
  const drain = () => {
    const f = sink.flush();
    if (f instanceof Promise) { f.then(drain, drain); return; }
    blocked = false; queued = 0;
    for (const id of [...owing]) { owing.delete(id); const c = conns.get(id); if (c) flushTap(c); }
  };
  const say = (m: FromRelay): boolean => {
    const line = JSON.stringify(m) + "\n";
    sink.write(line); queued += line.length;
    const f = sink.flush();
    if (f instanceof Promise) { if (!blocked) { blocked = true; f.then(drain, drain); } } else if (!blocked) queued = 0;
    return true;
  };
  const sayInfo = (m: FromRelay): boolean => (blocked ? false : say(m));

  const server = Bun.serve<{ id: number }>({
    // Loopback only: this socket carries no credential of its own, the ticket
    // is the whole door, so the door is only on this machine.
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/pty") return new Response("not found", { status: 404 });
      // One layer beyond the ticket: a page on another site has an Origin that is not ours.
      if (!relayOriginOk(req.headers.get("origin"))) return new Response("origin refused", { status: 403 });
      const t = url.searchParams.get("t") ?? "";
      if (url.search.length > MAX_QUERY || !tickets.burn(t)) return new Response("ticket refused", { status: 401 });
      url.searchParams.delete("t");
      const id = next++;
      // Set first: `open` reads it, and main hears about the socket from there.
      queuedOpen.set(id, { ticket: t, query: url.searchParams.toString() });
      if (!srv.upgrade(req, { data: { id } })) { queuedOpen.delete(id); return new Response("upgrade failed", { status: 426 }); }
      return undefined as unknown as Response;
    },
    websocket: {
      // A frame is a keystroke or a control message; nothing legitimate is large.
      maxPayloadLength: 4 * 1024 * 1024,
      idleTimeout: 255,
      open(ws) {
        const q = queuedOpen.get(ws.data.id); queuedOpen.delete(ws.data.id);
        const c: Conn = { id: ws.data.id, ws, closed: false, tap: false, tapHeld: [], tapBytes: 0, nudge: null, lastKeys: 0, pending: [], pendingBytes: 0 };
        conns.set(c.id, c);
        say({ op: "open", conn: c.id, ticket: q?.ticket ?? "", query: q?.query ?? "" });
      },
      message(ws, raw) {
        const c = conns.get(ws.data.id);
        if (!c || c.closed) return;
        if (!c.proc) {
          // Main has not answered `spawn` yet (or is stalled): bounded, not unbounded.
          c.pendingBytes += typeof raw === "string" ? raw.length : raw.length;
          if (c.pending.length >= 64 || c.pendingBytes > 1024 * 1024) { ws.close(4413, "server busy"); return; }
          c.pending.push(raw); return;
        }
        frame(c, raw);
      },
      close(ws) {
        const c = conns.get(ws.data.id);
        if (!c) return;
        c.closed = true;
        say({ op: "closed", conn: c.id });
        // Main hangs the shell up on `closed`. If main is wedged or gone the
        // stdin EOF below does it, so a closed window never leaves a shell.
        if (c.nudge) clearTimeout(c.nudge);
        // Hang the shell up here too, not only in main: a window that closes
        // before main has heard the bridge's pid, or while main is stalled,
        // must not leave a shell behind. Main's own SIGHUP and its SIGKILL
        // escalation still run; a second SIGHUP is harmless.
        hup(c);
        conns.delete(c.id);
      },
    },
  });

  // A keystroke goes straight to the pty; the rest is main's business.
  function frame(c: Conn, raw: string | Buffer) {
    const text = typeof raw === "string" ? raw : raw.toString();
    // Every `in` frame is parsed here, whatever its spelling, so keystrokes
    // have exactly one path to the pty and cannot be reordered by main.
    if (text.charCodeAt(0) === 123 /* { */ && text.includes('"in"')) {
      try {
        const m = JSON.parse(text) as { t?: string; d?: unknown };
        if (m.t === "in" && typeof m.d === "string" && m.d) {
          const sink = c.proc?.stdin as { write?: (b: Uint8Array) => void; flush?: () => void } | undefined;
          sink?.write?.(enc.encode(m.d));
          sink?.flush?.();
          const now = Date.now();
          if (now - c.lastKeys > 250) { c.lastKeys = now; sayInfo({ op: "keys", conn: c.id }); }
          return;
        }
      } catch { /* fall through: main decides what a malformed frame is */ }
    }
    if (blocked && queued > HARD_BYTES) { try { c.ws.close(4413, "server busy"); } catch { /* closed */ } return; }
    say({ op: "msg", conn: c.id, text });
  }

  function startLane(c: Conn, m: Extract<ToRelay, { op: "spawn" }>) {
    c.tap = m.tap;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(m.argv, { cwd: m.cwd, env: m.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (e) { say({ op: "failed", conn: c.id, error: String(e) }); return; }
    c.proc = proc;
    say({ op: "spawned", conn: c.id, pid: proc.pid });
    for (const p of c.pending.splice(0)) frame(c, p);

    const pump = async (readable: ReadableStream<Uint8Array> | null | undefined) => {
      if (!readable) return;
      const reader = readable.getReader();
      let held: Uint8Array[] = [];
      let size = 0;
      let backedUp = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!held.length) return;
        const out = held.length === 1 ? held[0] : (() => {
          const all = new Uint8Array(size);
          let at = 0;
          for (const x of held) { all.set(x, at); at += x.length; }
          return all;
        })();
        held = []; size = 0;
        if (c.closed) return;
        try { if (c.ws.send(out) === -1) backedUp = true; } catch { /* socket gone */ }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || c.closed) break;
          if (value?.length) {
            held.push(value); size += value.length;
            if (size >= BIG) flush(); else if (!timer) timer = setTimeout(flush, FRAME_MS);
            outputHappened(c, value);
          }
          // Same bounded wait as the in-process pump: a client that never
          // drains is a dead one, and holding the shell for it forever is worse.
          let waited = 0;
          while (!c.closed && waited < 10_000 && (backedUp || c.ws.getBufferedAmount() > HIGH_WATER)) {
            flush();
            await Bun.sleep(4);
            waited += 4;
            backedUp = c.ws.getBufferedAmount() > HIGH_WATER;
          }
        }
      } catch { /* stream torn down */ }
      finally { flush(); }
    };

    (async () => {
      await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
      const code = await proc.exited;
      flushTap(c);
      say({ op: "exited", conn: c.id, code });
    })();
  }

  // Tell main output happened, at most every OUT_NUDGE_MS, carrying the bytes
  // only for a lane whose prompts main parses.
  function outputHappened(c: Conn, v: Uint8Array) {
    if (c.tap) {
      c.tapHeld.push(v); c.tapBytes += v.length;
      while (c.tapBytes > TAP_CAP && c.tapHeld.length > 1) c.tapBytes -= c.tapHeld.shift()!.length;
    }
    if (c.nudge) return;
    c.nudge = setTimeout(() => { c.nudge = null; flushTap(c); }, OUT_NUDGE_MS);
  }
  function flushTap(c: Conn) {
    if (c.nudge) { clearTimeout(c.nudge); c.nudge = null; }
    if (blocked) { owing.add(c.id); return; }
    if (c.tap && c.tapHeld.length) {
      const all = Buffer.concat(c.tapHeld); c.tapHeld = []; c.tapBytes = 0;
      say({ op: "out", conn: c.id, b64: all.toString("base64") });
    } else if (!c.tap) say({ op: "out", conn: c.id });
  }

  function hup(c: Conn) {
    const pid = c.proc?.pid;
    // Never after the bridge was reaped: the pid may be somebody else's now.
    if (pid && c.proc?.exitCode === null) { try { process.kill(-pid, "SIGHUP"); } catch { try { process.kill(pid, "SIGHUP"); } catch { /* gone */ } } }
  }
  function killAll() { for (const c of conns.values()) hup(c); }

  const split = lineSplitter();
  const onLine = (line: string) => {
    let m: ToRelay;
    try { m = JSON.parse(line) as ToRelay; } catch { return; }
    if (m.op === "ticket") { tickets.add(m.id); return; }
    const c = conns.get(m.conn);
    if (!c) return;
    if (m.op === "spawn") startLane(c, m);
    else if (m.op === "send") { try { c.ws.send(m.text); } catch { /* closed */ } }
    else if (m.op === "write") { try { (c.proc?.stdin as { write?: (b: Uint8Array) => void } | undefined)?.write?.(Buffer.from(m.b64, "base64")); } catch { /* shell gone */ } }
    else if (m.op === "close") { try { c.ws.close(m.code, m.reason); } catch { /* closed */ } }
  };

  say({ op: "ready", port: server.port as number });
  // Main going away closes this pipe: take every shell down with it, then go.
  // `stream`: a JSON line from main can carry any text (an env value, a control
  // frame), and a character cut by a chunk boundary must not become two wrong ones.
  for await (const chunk of Bun.stdin.stream()) for (const l of split(dec.decode(chunk, { stream: true }))) onLine(l);
  killAll();
  process.exit(0);
}
