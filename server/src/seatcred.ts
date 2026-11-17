/*
 * The socket a browser CLI asks over when its window's env carries
 * `AGENTGLASS_BROWSER_OFF` but the pane running it IS the project's seat —
 * adopted or self-started, before this fix shipped, whose environment was
 * fixed at exec and can never be handed a credential now that tmux is
 * running it.
 *
 * The first version of this fix wrote the credential to a file named by
 * `TMUX_PANE`. Rejected: `TMUX_PANE` is a plain environment variable, a
 * worker can export it to the seat pane's own value, and the credential
 * directory was readable from a worker's sandbox — so any worker could take
 * the seat's token by forging one string. Nothing the caller SAYS is trusted
 * here. The only fact this reads is the kernel's own peer credentials of the
 * connecting socket (`SO_PEERCRED`), which a process cannot lie about, and
 * the `/proc` parent chain walked from that PID. A worker's sandbox blocks
 * unix sockets outright — part of the same door closing, not a gap in it —
 * so a worker asking this socket never connects at all; only a real shell
 * with a real kernel process tree gets an answer.
 */
import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { everySeat, seated } from "./seat.ts";
import { paneIdentity } from "./agentops.ts";
import { mintSeatFlightToken, mintWorkerToken } from "./auth.ts";

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}

/** A private 0600 socket, in the same config dir every other per-user
 *  private file here lives in — never the credential directory a worker's
 *  sandbox can read, which is the whole reason the file version was refused. */
export function seatCredSocketPath(): string {
  return join(configDir(), "seat-cred", "seat-cred.sock");
}

/**
 * The PID at the other end of `socket`, via `SO_PEERCRED` — Linux only, and
 * the one fact a connecting process cannot fake: the kernel fills it in from
 * the file descriptor's own credentials at `connect()`, not from anything
 * the client sent. `struct ucred { pid, uid, gid }` is three native ints;
 * only `pid` is read.
 *
 * `socket._handle.fd` is not a public Node API, but there is no other way to
 * reach the raw descriptor a `getsockopt` needs, and `inotify.ts` already
 * leans on `bun:ffi` + libc the same way for the same reason (no portable
 * wrapper exists). Null on anything that fails: a caller this cannot
 * identify gets no credential, never the benefit of the doubt.
 */
function peerPid(socket: Socket): number | null {
  if (process.platform !== "linux") return null;
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return null;
  try {
    const { symbols: c } = dlopen("libc.so.6", {
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    const cred = new Int32Array(3); // pid, uid, gid
    const len = new Uint32Array([12]);
    const rc = c.getsockopt(fd, /* SOL_SOCKET */ 1, /* SO_PEERCRED */ 17, ptr(cred), ptr(len));
    return rc === 0 && cred[0]! > 0 ? cred[0]! : null;
  } catch {
    return null;
  }
}

/** `pid`'s parent, read fresh from `/proc/<pid>/stat` field 4 — the comm
 *  field (2) is parenthesised and may itself contain spaces or `)`, so the
 *  fields are counted from the last `)`, the same parse `machine.ts` and
 *  `tmuxrestore.ts` already use for this file. 0 (never a real pid) on
 *  anything unreadable, which stops the walk rather than guessing a parent.
 *  Exported for the test: a real `/proc` read, on a real spawned process, is
 *  worth more here than a fake one. */
export function parentOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const ppid = Number(rest[1]); // rest[0] is field 3 (state); field 4 is rest[1]
    return Number.isFinite(ppid) && ppid > 0 ? ppid : 0;
  } catch {
    return 0;
  }
}

/** Bounded so a wrong `ppid` (see `machine.ts`) cannot loop this forever;
 *  deeper than any real shell-under-tmux-under-shell chain gets. */
const MAX_ANCESTORS = 48;

/** `pid` and every ancestor up to init or the depth cap. Exported: the test
 *  walks a real spawned process's chain with this, not a stub. */
export function ancestry(pid: number): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < MAX_ANCESTORS && cur > 1; i++) {
    out.push(cur);
    cur = parentOf(cur);
  }
  return out;
}

export interface SeatCandidate {
  root: string;
  name: string;
  /** The pane's own OS pid, read fresh from tmux — never anything the asking
   *  process claims about itself. */
  livePid: number;
}

/**
 * The pure decision: the seat whose `livePid` is one of `callerPid`'s
 * ancestors, or null. Nothing about `callerPid` beyond its kernel-reported
 * ancestry is read here — in particular never an environment variable — so
 * a sibling process that forges `TMUX_PANE` to the seat's own pane id gains
 * nothing: its ancestry still does not contain the candidate's `livePid`.
 */
export function matchingSeat(callerPid: number, candidates: readonly SeatCandidate[]): SeatCandidate | null {
  return matchingSeatInChain(new Set(ancestry(callerPid)), candidates);
}

/**
 * Same decision as `matchingSeat`, taking an already-walked chain. Exists so
 * the chain can be captured the instant `SO_PEERCRED` hands back a pid —
 * before `liveSeatCandidates` runs its own awaits (tmux round-trips per
 * seat) — rather than walked lazily after that delay, when the kernel may
 * have recycled the pid for an unrelated process.
 */
export function matchingSeatInChain(chain: ReadonlySet<number>, candidates: readonly SeatCandidate[]): SeatCandidate | null {
  if (!chain.size) return null;
  for (const c of candidates) if (chain.has(c.livePid)) return c;
  return null;
}

/**
 * Whether a seat row is even worth asking `seated()` about: not stood down.
 * Liveness itself — a real pane, versus one that died or was never there —
 * is `seated()`'s own verdict, not this row's `adoptedPane` column: a seat
 * this app STARTED ITSELF (never adopted, so that column is empty) is just
 * as resolvable through `seated()` as one that was adopted, via
 * `AgentOps.agentNamed()`. Gating on `adoptedPane` here used to turn every
 * self-started chair's rescue into a silent no-candidate, indistinguishable
 * from a genuinely dead seat — the asymmetry `liveSeatCandidates` had.
 */
export function seatCandidateEligible(row: { endedAt: number | null }): boolean {
  return row.endedAt === null;
}

/**
 * Every seat still sitting in its chair, as a `SeatCandidate` — or skipped,
 * never guessed, when it has none to offer. Checked through `seated()`, the
 * same liveness-and-identity verdict `reapDeadSeatTokens` trusts: a %id tmux
 * handed to an unrelated pane after a restart answers "dead" there and
 * never becomes a candidate here, and a seat with no live pane (closed,
 * crashed, never started) offers nothing — which is how a dead seat is
 * refused, with no special case for it anywhere in this file.
 *
 * This walk does not, on its own, tell a worker's descendant apart from the
 * seat's own typed-into shell: both are same-user OS descendants of the
 * seat's live pane. Measured here before reaching for one: a worker's
 * cgroup carries no stable, same-across-runtimes marker this file could read
 * from a bare pid, and `/proc/<pid>/environ` is exactly the caller-supplied
 * fact this socket was built to never trust (see the file header). The real
 * fence is the sandbox refusing the socket's `connect()` outright for a
 * worker process; this file has no second, independent check of its own
 * against a future spawn path that escapes it.
 */
async function liveSeatCandidates(): Promise<SeatCandidate[]> {
  const out: SeatCandidate[] = [];
  for (const row of everySeat()) {
    if (!seatCandidateEligible(row)) continue;
    const agent = await seated(row.root);
    if (!agent?.paneId) continue;
    const livePid = Number((await paneIdentity(agent.paneId))?.split(".")[0]);
    if (Number.isFinite(livePid)) out.push({ root: row.root, name: agent.name, livePid });
  }
  return out;
}

let candidatesFor = liveSeatCandidates;

/** Test seam: swap the real tmux/db-backed lookup for a fixed list, so the
 *  security-critical comparison (`matchingSeat`) can be driven end to end
 *  over a real socket without a real adopted seat. `null` restores it. */
export function __setSeatCandidates(fn: (() => Promise<SeatCandidate[]>) | null): void {
  candidatesFor = fn ?? liveSeatCandidates;
}

let server: ReturnType<typeof createServer> | null = null;

/** Read, parsed and answered once per connection: a client writes one line
 *  and the reply ends the socket, so there is no protocol beyond "ask, get
 *  an answer, done" to get wrong on either side. */
async function handleConnection(socket: Socket): Promise<void> {
  const reply = (body: Record<string, unknown>) => {
    try {
      socket.end(`${JSON.stringify(body)}\n`);
    } catch {
      /* the caller already went away */
    }
  };
  // A throw anywhere in here used to leave the caller with no reply at all
  // (the socket just closed): nothing below was wrapped, and `candidatesFor()`
  // rejecting had no `.catch`. Every exit now replies, so a caller is always
  // told why rather than reading a bare close as "the socket is gone".
  const fail = (e: unknown) => {
    const error = e instanceof Error ? e.message : String(e);
    console.error("seat-cred socket:", error);
    reply({ ok: false, error });
  };
  let buf = "";
  socket.on("data", (chunk) => {
    try {
      buf += chunk.toString("utf8");
      if (!buf.includes("\n")) return;
      socket.removeAllListeners("data");
      const pid = peerPid(socket);
      if (pid === null) {
        reply({ ok: false, error: "could not read the caller's identity (SO_PEERCRED unavailable)" });
        return;
      }
      // Walked NOW, from the pid SO_PEERCRED just handed back — not after the
      // await below. `liveSeatCandidates` makes a tmux round-trip per adopted
      // seat, and a short-lived connecting process can exit and have its pid
      // recycled by the kernel in that window; walking the chain later would
      // read an unrelated process's ancestry under this same pid.
      const chain = new Set(ancestry(pid));
      candidatesFor().then((candidates) => {
        const seat = matchingSeatInChain(chain, candidates);
        if (!seat) {
          reply({ ok: false, error: "no adopted seat's pane is an ancestor of this process" });
          return;
        }
        // A fresh, narrow credential each ask — never the seat's own `st_`
        // token (full machine scope), which this socket has no reason to hand
        // to a browser CLI call. A minute is long enough for one CLI
        // invocation and short enough that a leaked answer is stale fast.
        // `profile` MUST be the exact name the token was minted for:
        // browserdrive.ts's `agentAskRefusal` folds a worker's own container
        // to the name on its token (`caller.worker`) and refuses a mint that
        // asks for anything else, so a reply where the two strings differ
        // would hand back a credential the CLI's own first call then 403s on.
        // `replace: false`: two close asks from the same seat must not revoke
        // each other's still-live token mid-flight.
        // `seat-flight` asks for the seat itself, narrowed to the plan verbs: the kernel named the caller, so this is the seat's own credential and not a name.
        if (buf.trim() === "seat-flight") {
          const row = everySeat().find((x) => x.root === seat.root);
          reply({ ok: true, token: mintSeatFlightToken(seat.root, row?.powers ?? "speak") });
          return;
        }
        const workerName = `seat-cred:${seat.name}`;
        const token = mintWorkerToken(workerName, 60_000, false);
        reply({ ok: true, token, profile: workerName });
      }).catch(fail);
    } catch (e) {
      fail(e);
    }
  });
  socket.on("error", () => {
    /* a client that vanished mid-ask is not a thing to log */
  });
}

/** Starts the socket once; a no-op on every call after the first. Linux
 *  only — `SO_PEERCRED` has no portable equivalent, and off that floor there
 *  is no safe answer to give, so the socket simply does not exist elsewhere. */
export function startSeatCredSocket(): void {
  if (server || process.platform !== "linux") return;
  const path = seatCredSocketPath();
  // Its own directory, chmod'ed 0700 every start: mkdirSync's mode is ignored
  // for a directory that already exists, and the config dir is often 0755.
  // The socket file itself is chmod'ed only after bind, so for a moment it
  // carries the umask's mode; the directory is what keeps another user out.
  const sockDir = dirname(path);
  mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  chmodSync(sockDir, 0o700);
  try {
    rmSync(path, { force: true });
  } catch {
    /* nothing stale to remove */
  }
  const s = createServer((socket) => void handleConnection(socket));
  // `node:net`'s `Server` type, without `@types/node` installed, is missing
  // `EventEmitter`'s methods under this project's `bun-types`-only tsconfig;
  // the object itself emits `error` at runtime same as always.
  (s as unknown as { on(event: "error", cb: (e: Error) => void): void }).on("error", () => {
    server = null;
  });
  s.listen(path, () => {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* the containing directory (0700) is the real fence */
    }
  });
  server = s;
}

export function stopSeatCredSocket(): void {
  if (!server) return;
  try {
    server.close();
  } catch {
    /* already gone */
  }
  try {
    rmSync(seatCredSocketPath(), { force: true });
  } catch {
    /* fine */
  }
  server = null;
}

/** Test seam: forget the running server so a test can start a fresh one
 *  against a different `XDG_CONFIG_HOME`. */
export function __forgetSeatCredSocket(): void {
  server = null;
}
