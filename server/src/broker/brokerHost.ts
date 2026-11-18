// Main-server side of the spawn broker: starts it, keeps it alive, and gives
// git.ts and prs.ts one call that runs a command there instead of forking the
// server. Imports nothing that opens the database. See wire.ts for why the
// broker exists and brokerMain.ts for what it does.
import { readFileSync } from "node:fs";
import { relayArgv } from "../relay/relayHost.ts";
import { lineSplitter, restartDelay } from "../relay/wire.ts";
import { BROKER_MARK, envDelta } from "./wire.ts";
import type { BrokerDone, FromBroker, ToBroker } from "./wire.ts";

/** A run's answer as the host hands it on. `lost`: the broker died with the request in it. */
export type BrokerAnswer = BrokerDone & { lost: boolean };

export type BrokerRequest = {
  argv: string[];
  cwd?: string;
  /** The whole environment the child should see, as the in-process spawn was given it. */
  env: Record<string, string | undefined>;
  timeoutMs: number;
  graceMs?: number;
  stdin?: string;
  maxBytes: number;
  /**
   * True only for a command that is safe to run twice (a read). A run the
   * host gives up on while the broker still answers frees its caller at once
   * only when it is a read. Anything else keeps the slot until its own answer
   * or the broker's death arrives: the git may still be running, and a retry
   * would run the same write twice.
   */
  read?: boolean;
};

let child: ReturnType<typeof Bun.spawn> | null = null;
let ready = false;
/** The environment the running broker was started with: requests send only what differs. */
let baseEnv: Record<string, string | undefined> = {};
let nextId = 1;
let sent = 0;
let log: (line: string) => void = (l) => console.warn(l);
const pending = new Map<number, (a: BrokerAnswer) => void>();
const deaths: number[] = [];
let stopping = false;
let wanted = false;
const READY_MS = 5000;
/**
 * How long past a run's own budget and grace the host waits for its answer.
 * The limit and the kill run in the broker; a broker that is alive but not
 * answering (stopped, stuck in the kernel, a stuck event loop) never exits, so
 * nothing else would settle the request, and the caller would hold its spawn
 * slot for good. Past this the broker is killed, as the reader's host does.
 */
const HOST_MARGIN_MS = 3000;
/** The grace given to a run that names none. */
const HOST_GRACE_MS = 2000;
/** How long a broker asked "are you there?" has to answer before it counts as stuck. */
const PROBE_MS = 500;
/** When main last read a line from the running broker (performance.now()). */
let heard = 0;
const upWaiters: (() => void)[] = [];

/** The process group `pid` is in, or null when /proc cannot say. */
const groupOf = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const g = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    return Number.isInteger(g) ? g : null;
  } catch { return null; }
};

/**
 * Kill a broker that stopped answering, and every process it started. The
 * broker is started in its own process group, so its git and gh children are
 * in it: killing only the broker left them running with no limit (the limit
 * lives in the broker), and a stuck push kept the repository's index.lock.
 * SIGKILL: a stopped process or one stuck in the kernel answers no other
 * signal in time. The group is signalled only when it is the broker's own and
 * this process is not in it (killTree's spareSelf rule); otherwise only the
 * broker is.
 */
function killBroker(me: ReturnType<typeof Bun.spawn> | null): void {
  if (!me) return;
  if (child === me) ready = false;
  const pid = me.pid;
  // An exited broker's pid may belong to someone else now: never SIGKILL a group by it.
  if (me.exitCode !== null) return;
  if (groupOf(pid) === pid && groupOf(process.pid) !== pid) {
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall back to the broker alone */ }
  }
  try { me.kill("SIGKILL"); } catch { /* gone */ }
}

export const brokerPid = (): number | null => child?.pid ?? null;
/** How many runs have been handed to a broker since this process started. */
export const brokerSent = (): number => sent;
/** True while a broker is up and has said so. False means: spawn in-process, as before. */
export const brokerReady = (): boolean => !!child && ready;

const send = (m: ToBroker): boolean => {
  const stdin = child?.stdin as { write(s: string): void; flush(): void } | undefined;
  if (!stdin) return false;
  try { stdin.write(JSON.stringify(m) + "\n"); stdin.flush(); return true; } catch { return false; }
};

type Late = { answered: () => void; lose: (why: string) => void };
/** Runs past their deadline, waiting on the one shared ping. */
const late = new Map<number, Late>();
/** The ping in flight for every late run, if one is. */
let probe: ReturnType<typeof setTimeout> | null = null;
/** How many times a main that stalled again may ask once more before the broker is judged stuck. */
const PROBE_RETRIES = 2;
let pings = 0;
/** How many "are you there?" pings the host has sent since this process started. */
export const brokerPings = (): number => pings;

/**
 * Ask the broker once whether it is there, for every run that is late. One
 * ping and one timer however many runs are late: fifty runs expiring
 * together after a stall sent fifty pings and armed fifty timers.
 */
function askBroker(me: ReturnType<typeof Bun.spawn> | null, tries = 0): void {
  if (probe) return;
  // A pipe that refuses the ping: the broker is going or gone; its exit settles the runs.
  if (!send({ op: "ping" })) { if (child === me) killBroker(me); return; }
  pings++;
  const asked = performance.now();
  // loop-ok: one probe for every late run
  probe = setTimeout(() => {
    probe = null;
    if (child !== me) return;
    const alive = heard >= asked;
    // Main stalled again while it waited: the broker had no fair chance to
    // answer. Ask once more, at most PROBE_RETRIES times; past that, it is stuck.
    if (!alive && performance.now() - asked > PROBE_MS * 2 && tries < PROBE_RETRIES) { askBroker(me, tries + 1); return; }
    // A run answered while it waited is no longer late.
    const runs = [...late].filter(([id]) => pending.has(id)).map(([, l]) => l);
    late.clear();
    if (alive) { for (const l of runs) l.answered(); return; }
    for (const l of runs) l.lose("and the broker is killed");
    killBroker(me);
  }, PROBE_MS);
}

/**
 * Run a command in the broker. Null when there is no broker to run it (off,
 * starting, dead, or the pipe refused the line): the caller then spawns
 * in-process exactly as it did before, so the flag being on never makes a
 * command impossible.
 *
 * A request that was SENT and whose broker then died answers `lost: true` and
 * is not run again here. Whether a second run is safe depends on the command
 * (a read is, a commit or a posted comment is not), and only the caller knows
 * which it sent.
 */
export function brokerExec(r: BrokerRequest): { id: number; done: Promise<BrokerAnswer> } | null {
  if (!brokerReady()) return null;
  const id = nextId++;
  const { env, unset } = envDelta(baseEnv, r.env);
  const me = child;
  let settle!: (a: BrokerAnswer) => void;
  const done = new Promise<BrokerAnswer>((res) => { settle = res; });
  const budget = r.timeoutMs + (r.graceMs ?? HOST_GRACE_MS) + HOST_MARGIN_MS;
  let timer: ReturnType<typeof setTimeout>;
  let again = false;
  const lose = (why: string) => {
    pending.delete(id);
    log(`[spawnbroker] run ${id} not answered in ${budget} ms; it is reported lost ${why}`);
    settle(lostAnswer(id));
  };
  // The deadline and the reader of the broker's answers share main's loop.
  // After a stall on OUR side (a long sync job, swap) the answer can sit
  // unread in the pipe when the deadline fires. So the deadline does not
  // blame the broker yet: it joins the one shared "are you there?" (askBroker)
  // and lets the loop read.
  const expire = () => {
    if (!pending.has(id) || child !== me) return;
    late.set(id, { answered, lose });
    askBroker(me);
  };
  // The broker answered the shared ping, so it is not stuck.
  const answered = () => {
    if (!pending.has(id) || child !== me) return;
    // Give the run one more margin, then end only this run and keep the broker for everyone else.
    // loop-ok: one more margin for one pending run
    if (!again) { again = true; timer = setTimeout(expire, HOST_MARGIN_MS); return; }
    send({ op: "kill", id });
    if (r.read) { lose("(a read; the broker answers, so it is kept)"); return; }
    // A write: it is ended there, and its own answer, with the signal, is
    // what frees the caller. No answer in one more margin, and the broker is
    // stuck after all: killing its group ends the git, and its exit settles the run.
    log(`[spawnbroker] run ${id} (a write) not answered in ${budget} ms; it is ended there and its answer awaited`);
    // loop-ok: one last margin for one pending write
    timer = setTimeout(() => { if (pending.has(id) && child === me) killBroker(me); }, HOST_MARGIN_MS);
  };
  // loop-ok: answers one pending run
  timer = setTimeout(expire, budget);
  pending.set(id, (a) => { clearTimeout(timer); settle(a); });
  const taken = send({
    op: "run", id, argv: r.argv, cwd: r.cwd, env, unset, timeoutMs: r.timeoutMs,
    // Always a grace: a healthy broker then answers before the deadline above,
    // which only a broker that stopped answering can reach. Without one, a
    // grandchild holding the pipe kept a killed run open with no end.
    graceMs: r.graceMs ?? HOST_GRACE_MS,
    ...(r.stdin === undefined ? {} : { stdin: r.stdin }),
    maxBytes: r.maxBytes,
  });
  if (!taken) { clearTimeout(timer); pending.delete(id); return null; }
  sent++;
  return { id, done };
}

/** End a run early (a newer request made it pointless). Its answer still arrives, with the signal. */
export function brokerKill(id: number): void {
  if (pending.has(id)) send({ op: "kill", id });
}

const lostAnswer = (id: number): BrokerAnswer =>
  ({ id, code: null, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, held: false, lost: true });

function onMessage(m: FromBroker) {
  if (m.op === "ready") { ready = true; log("[spawnbroker] up"); for (const w of upWaiters.splice(0)) w(); return; }
  if (m.op !== "done") return;
  const settle = pending.get(m.id);
  if (!settle) return;
  pending.delete(m.id);
  settle({ ...m, lost: false });
}

/** What starts the broker. A test may start a stand-in that speaks the wire. */
let brokerArgv: string[] | null = null;

function launch(): boolean {
  const argv = brokerArgv ?? relayArgv(process.execPath, new URL("../index.ts", import.meta.url).pathname);
  // The whole environment, unlike the relay's three names: git and gh read the
  // user's (credentials helper, ssh agent, proxy, XDG), and they ran with the
  // server's until now.
  const env: Record<string, string | undefined> = { ...process.env, [BROKER_MARK]: "1" };
  // The relay's mark would send the child into the relay role first (gate order).
  delete env.AGENTGLASS_RELAY_CHILD;
  try {
    // detached: its own process group, so killBroker can take its children with it.
    child = Bun.spawn(argv, { env: env as Record<string, string>, stdin: "pipe", stdout: "pipe", stderr: "inherit", detached: true });
  } catch (e) { child = null; log(`[spawnbroker] cannot start (${String(e)}); commands are started in-process`); return false; }
  const me = child;
  ready = false;
  baseEnv = env;
  // A broker that hangs before `ready` never exits on its own; killing it counts as a death below.
  // loop-ok: kills one child
  const hung = setTimeout(() => { if (child === me && !ready) { log("[spawnbroker] no ready in 5 s; killing it"); killBroker(me); } }, READY_MS);
  (async () => {
    const split = lineSplitter();
    const dec = new TextDecoder();
    try { for await (const chunk of me.stdout as ReadableStream<Uint8Array>) { if (child === me) heard = performance.now(); for (const l of split(dec.decode(chunk, { stream: true }))) { try { onMessage(JSON.parse(l) as FromBroker); } catch { /* not ours */ } } } } catch { /* ended */ }
  })();
  me.exited.then(() => {
    clearTimeout(hung);
    if (child !== me) return;
    child = null; ready = false;
    late.clear();
    if (probe) { clearTimeout(probe); probe = null; }
    // Whatever it was running has no one to report to: say so to each caller.
    for (const [id, settle] of [...pending]) {
      pending.delete(id);
      settle(lostAnswer(id));
    }
    if (stopping) return;
    deaths.push(Date.now());
    const wait = restartDelay(deaths, Date.now());
    if (wait === null) { log("[spawnbroker] died 4 times in a minute; commands are started in-process until the server restarts"); return; }
    log(`[spawnbroker] exited; restarting in ${wait} ms (commands are started in-process meanwhile)`);
    // loop-ok: relaunches one child
    setTimeout(() => { if (!stopping && wanted && !child) launch(); }, wait);
  });
  return true;
}

export function startBroker(logLine?: (l: string) => void, argv?: string[]): void {
  if (logLine) log = logLine;
  brokerArgv = argv ?? null;
  stopping = false;
  wanted = true;
  if (!child) launch();
}

export function stopBroker(): void {
  stopping = true;
  wanted = false;
  try { (child?.stdin as { end(): void } | undefined)?.end(); } catch { /* gone */ }
}

/** Resolves true once the broker has said it is up, false after `ms`. */
export function brokerUp(ms = READY_MS): Promise<boolean> {
  if (brokerReady()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = () => { clearTimeout(t); resolve(true); };
    // loop-ok: drops one waiter
    const t = setTimeout(() => { const i = upWaiters.indexOf(done); if (i >= 0) upWaiters.splice(i, 1); resolve(false); }, ms);
    upWaiters.push(done);
  });
}
