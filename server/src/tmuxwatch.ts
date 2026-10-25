// A push channel for the tab strip: tmux says when something moved.
//
// The strip used to ask. `terminal.ts` swept `list-clients` + `list-windows -a`
// + `list-panes -a` in one spawn every 500 ms while anything moved and every
// 2 s once it had been quiet for ten sweeps — 1 800 spawns an hour per open
// panel while nothing happens, and a new tab was up to two seconds late.
//
// tmux's control mode is the other half of that conversation. A client started
// with `-C attach -f no-output,ignore-size` receives no pane bytes (`no-output`
// — every byte of terminal traffic stays on the PTY the panel already has) and
// does not join size negotiation (`ignore-size` — measured: window sizes were
// unchanged with it attached next to a real client). What it does receive is
// tmux's notifications (`%window-add`, `%layout-change`, `%session-window-
// changed`, …) the instant they happen, and `refresh-client -B` subscriptions
// for the fields that have no notification of their own (bell and activity
// flags, the bar, `@agx-*` options, the active pane's directory), which tmux
// pushes rate-limited to one a second.
//
// This is a SIDECAR, not a conversion. The panel's shell keeps the PTY it has;
// if this client dies the strip falls back to the poll and the terminal never
// notices. Nothing here is ever typed into a shell: stdin is a pipe to a tmux
// client, and a tmux that goes away ends the pipe rather than running our
// commands at a prompt.
//
// What the sidecar costs, and what it does not do:
//
//  - It is a tty-less client on the session, so `#{session_attached}` counts
//    it. It is therefore opened only on a session a real client is already on
//    (the sweep's own client), and closed the moment that client goes.
//  - It is opened only on the app's own tmux server (`onEngine`), whose config
//    is ours. On somebody's own server a `client-attached` hook of theirs
//    would run for it; they keep the poll. Widening this is one condition in
//    `terminal.ts`.
//  - Subscriptions need tmux >= 3.2. `tmux -V` is read once; older (or a
//    `refresh-client -B` the server answers with "unknown flag") and the
//    sidecar stands down for good — no restart loop against a tmux that will
//    never answer. Any other error is an ordinary failure with a backoff.
//  - `attach-session` starts a server when there is none. After a power cut
//    that would boot an empty server, loading the person's config, before the
//    restore gets there. So every start is gated on `has-session`, which
//    starts nothing, and a sidecar that never reaches "up" stops trying after
//    MAX_FAILS.
//  - It reports THAT something changed, not what. The frame the sweep reads is
//    the one source of truth for the strip; a change just makes the sweep run
//    now instead of later, and the sweep already de-duplicates.
import { sidecarAllowed, tmuxEnv } from "./tmuxctl.ts";
import { validSessionName } from "./tmuxpane.ts";

/** The poll's rhythm when nothing pushes: 500 ms while anything moves, 2 s
 *  after QUIET_SWEEPS unchanged answers. See `arm` in terminal.ts. */
export const QUIET_SWEEPS = 10;
export const SLOW_MS = 2000;
/** The poll's rhythm while the sidecar is up. Not a poll for tabs any more —
 *  a safety net for what tmux does not announce (a session renamed from
 *  another client, a client that attaches elsewhere). One spawn per 30 s. */
export const HEARTBEAT_MS = 30_000;

/** Give up waiting for the first reply and treat the sidecar as down. */
const READY_MS = 3000;
/** A `%begin` whose `%end` never comes would swallow every line after it. */
const BLOCK_MS = 5000;
/** Restart delays: 1 s, 2 s, 4 s … 60 s. Never a tight loop. */
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** An attach that held this long was a working one; the next failure starts
 *  the backoff over instead of continuing it. */
const STABLE_MS = 30_000;
/** Starts in a row that never reached "up" (session gone, socket dead) before
 *  the sidecar stops asking. The poll carries on; a new panel tries again. */
const MAX_FAILS = 5;

/**
 * The fields the sweep reads that tmux has no notification for. Every
 * subscription is a format tmux evaluates itself and pushes when the string
 * changes; the content is never read here, only the change.
 *
 * `all` loops over EVERY session and window (`#{S:#{W:…}}`), because the sweep
 * reads the whole server (`list-windows -a`) and `@agx-ask` — "an agent needs
 * you" — is set on windows of sessions this client is not attached to. A
 * subscription on `@*` would see only the attached session's windows. Measured
 * on tmux 3.8: setting `@agx-ask` on a window of another session was pushed
 * within the second.
 */
const SUBSCRIPTIONS = [
  `refresh-client -B all::"#{S:#{W:#{window_id}=#{window_index}|#{window_name}|#{window_active}|#{window_raw_flags}|#{window_zoomed_flag}|#{window_layout}|#{@agx-ask}|#{@agx-group}|#{@agx-pin}|#{pane_current_path};}}"`,
  `refresh-client -B bar::"#{session_name}|#{status}|#{@agx-owned}"`,
];

/** Notifications that mean the strip may have moved. `%output`, `%begin`,
 *  `%end`, `%exit` and friends are not among them. */
const MOVED = /^%(?:subscription-changed|window-|unlinked-window-|layout-change|session-|sessions-changed|client-|pane-mode-changed)/;
/** What older tmux says to `refresh-client -B`. Anything else is not "too old". */
const TOO_OLD = /unknown (?:flag|command)|usage:/i;

export type WatchEvent = "change" | "up" | "down";

export interface SessionWatch {
  /** The sidecar is attached and subscribed: the poll may stand down. */
  alive(): boolean;
  /** Stop listening; the last release closes the client. */
  release(): void;
}

export interface WatchOptions {
  /** The tmux invocation up to the socket flags. A test adds `-f /dev/null`. */
  bin?: string[];
  /** First restart delay, doubling. A test shortens it; nothing else should. */
  backoffMs?: number;
}

interface Shared {
  key: string;
  bin: string[];
  socket: string[];
  session: string;
  listeners: Set<(ev: WatchEvent) => void>;
  up: boolean;
  /** tmux too old for subscriptions: never retried. */
  unsupported: boolean;
  /** Starts since the last "up" that did not reach one. */
  fails: number;
  proc: ReturnType<typeof Bun.spawn> | null;
  backoff: number;
  first: number;
  restart: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const shared = new Map<string, Shared>();

/** Start (or join) the sidecar for a session on a socket. `on` hears every
 *  change, and `up`/`down` as the sidecar comes and goes. Returns null when a
 *  sidecar must not run here at all (observe-only, a refused socket, a name
 *  tmux would resolve onto something else). */
export function watchSession(socket: string[], session: string, on: (ev: WatchEvent) => void, opts: WatchOptions = {}): SessionWatch | null {
  if (!validSessionName(session) || !sidecarAllowed(socket)) return null;
  const bin = opts.bin ?? ["tmux"];
  const key = `${bin.join(" ")}\0${socket.join(" ")}\0${session}`;
  let s = shared.get(key);
  if (!s) {
    const first = opts.backoffMs ?? BACKOFF_FIRST_MS;
    s = { key, bin, socket, session, listeners: new Set(), up: false, unsupported: false, fails: 0, proc: null, backoff: first, first, restart: null, closed: false };
    shared.set(key, s);
    void start(s);
  }
  s.listeners.add(on);
  const mine = s;
  let released = false;
  return {
    alive: () => mine.up && !mine.closed,
    release() {
      if (released) return;
      released = true;
      mine.listeners.delete(on);
      if (mine.listeners.size === 0) close(mine);
    },
  };
}

const emit = (s: Shared, ev: WatchEvent) => { for (const l of Array.from(s.listeners)) { try { l(ev); } catch { /* a listener's fault is not the sidecar's */ } } };

function close(s: Shared): void {
  s.closed = true;
  s.up = false;
  if (s.restart) { clearTimeout(s.restart); s.restart = null; }
  shared.delete(s.key);
  const p = s.proc;
  s.proc = null;
  if (!p) return;
  // EOF on stdin is how a control client is told to detach; the kill is for a
  // tmux that does not take the hint. By PID of the process we started.
  try { (p.stdin as { end?: () => void } | undefined)?.end?.(); } catch { /* already closed */ }
  try { p.kill(); } catch { /* already gone */ }
}

function down(s: Shared): void {
  const was = s.up;
  s.up = false;
  s.proc = null;
  if (was) emit(s, "down");
  else s.fails++;
  if (s.closed || s.unsupported || s.listeners.size === 0 || s.fails >= MAX_FAILS) return;
  const wait = s.backoff;
  s.backoff = Math.min(BACKOFF_MAX_MS, s.backoff * 2);
  s.restart = setTimeout(() => { s.restart = null; if (!s.closed) void start(s); }, wait);
}

/** Whether `tmux -V` is a tmux with subscriptions (>= 3.2). Unparseable
 *  (`master`, `next-3.5`) is taken as new: those builds are newer than 3.2. */
const versions = new Map<string, Promise<boolean>>();
function subscriptions(bin: string[]): Promise<boolean> {
  const key = bin.join(" ");
  let v = versions.get(key);
  if (!v) {
    v = (async () => {
      try {
        const p = Bun.spawn([...bin, "-V"], { stdout: "pipe", stderr: "ignore", env: tmuxEnv() });
        const out = await new Response(p.stdout).text();
        await p.exited;
        const m = /(\d+)\.(\d+)/.exec(out);
        return !m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2);
      } catch { return true; }
    })();
    versions.set(key, v);
  }
  return v;
}

/** `has-session` answers without starting a server; `attach-session` would. */
async function sessionExists(s: Shared): Promise<boolean> {
  try {
    const p = Bun.spawn([...s.bin, ...s.socket, "has-session", "-t", `=${s.session}`], { stdout: "ignore", stderr: "ignore", env: tmuxEnv() });
    return (await p.exited) === 0;
  } catch { return false; }
}

async function start(s: Shared): Promise<void> {
  if (!(await subscriptions(s.bin))) { s.unsupported = true; return; }
  if (s.closed) return;
  if (!(await sessionExists(s))) { if (!s.closed) down(s); return; }
  if (s.closed) return;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...s.bin, ...s.socket, "-C", "attach-session", "-t", `=${s.session}`, "-f", "no-output,ignore-size"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: tmuxEnv(),
    });
  } catch { down(s); return; }
  s.proc = proc;
  const startedAt = Date.now();
  const stdin = proc.stdin as { write(d: string): unknown; flush?(): unknown };
  const kill = () => { try { proc.kill(); } catch { /* gone */ } };
  let pending = SUBSCRIPTIONS.length;
  let block: { triple: string; ours: boolean; text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const ready = setTimeout(() => { if (s.proc === proc && !s.up) kill(); }, READY_MS);
  const endBlock = () => { if (block) { clearTimeout(block.timer); block = null; } };

  const line = (raw: string) => {
    if (s.proc !== proc) return;
    const l = raw.replace(/\r$/, "");
    if (block) {
      /* The whole `%end <time> <num> <flags>` triple against the `%begin` that
         opened the block, because `%end` can appear inside a payload. */
      const m = /^%(end|error) (.*)$/.exec(l);
      if (m && m[2] === block.triple) {
        const { ours, text } = block;
        endBlock();
        if (!ours) return;
        if (m[1] === "error") {
          // Only "this tmux does not know -B" is final; any other refusal is a
          // failure like the rest, and the backoff decides how often to ask.
          if (TOO_OLD.test(text)) s.unsupported = true;
          kill();
          return;
        }
        if (--pending === 0) {
          clearTimeout(ready);
          s.up = true;
          s.fails = 0;
          emit(s, "up");
          emit(s, "change");
        }
        return;
      }
      /* A notification line cannot be payload: tmux does not interleave them
         with a reply, so one means the `%end` was lost. Close the block rather
         than swallow the stream behind it. */
      if (/^%(?:subscription-changed|exit)/.test(l)) {
        const lost = block.ours;
        endBlock();
        if (lost) { kill(); return; }
      } else {
        block.text += `${l}\n`;
        return;
      }
    }
    const b = /^%begin (\d+ \d+ (\d+))$/.exec(l);
    if (b) {
      /* Flag bit 0 is "client-originated". The first block after attach has
         it clear and answers nothing we sent; counting it would take someone
         else's reply for ours, for good. */
      block = { triple: b[1], ours: (Number(b[2]) & 1) === 1, text: "", timer: setTimeout(() => { if (s.proc === proc) kill(); }, BLOCK_MS) };
      return;
    }
    if (s.up && MOVED.test(l)) emit(s, "change");
  };
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
    } catch { /* the pipe ended */ }
    clearTimeout(ready);
    endBlock();
    if (s.proc !== proc) return;
    if (Date.now() - startedAt >= STABLE_MS) s.backoff = s.first;
    down(s);
  })();
  try {
    for (const cmd of SUBSCRIPTIONS) stdin.write(`${cmd}\n`);
    stdin.flush?.();
  } catch { /* the exit above does the cleanup */ }
}
