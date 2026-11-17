/*
 * Server side of the database reader: starts it, keeps it alive, and gives
 * the routes `readVia`, which resolves to the reader's answer or to null.
 * Null is the whole fallback: the caller then runs the same function on the
 * server's own connection, exactly as it did before the reader existed. So
 * the reader being off, not yet up, dead, slow or wrong costs a route nothing
 * it was not already paying.
 *
 * Modelled on relay/relayHost.ts. Imports nothing that opens the database.
 */
import { basename } from "node:path";
import { lineSplitter, restartDelay } from "../relay/wire.ts";
import type { ReadName } from "./reads.ts";

/** The longest a route waits for the reader before doing the read itself. */
export const READ_TIMEOUT_MS = 5000;
const READY_MS = 5000;

let child: ReturnType<typeof Bun.spawn> | null = null;
let ready = false;
let stopping = false;
let nextId = 1;
let dbFile = "";
let log: (line: string) => void = (l) => console.warn(l);
const waiting = new Map<number, (data: unknown | null) => void>();
const deaths: number[] = [];
const counts = { served: 0, fellBack: 0 };

export const readerPid = (): number | null => child?.pid ?? null;
/** For /health: whether it is up, and how often it answered against how often a route fell back. */
export const readerStats = (): { up: boolean; served: number; fellBack: number } => ({ up: ready, ...counts });

/** argv that starts this same program in the reader role (see relayArgv, the same rule). */
export function readerArgv(execPath: string, entry: string): string[] {
  const dev = /^bun(\.exe)?$/.test(basename(execPath));
  return dev ? [execPath, "--no-env-file", "run", entry] : [execPath];
}

/** The reader's whole environment. Its prices and its clock must be the server's, or the two would
 *  answer differently: the price file and the time zone go with it, and nothing else does (no token). */
export function readerEnv(env: Record<string, string | undefined>, path: string): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", AGENTGLASS_DBREADER_CHILD: "1", AGENTGLASS_DBREADER_PATH: path };
  if (env.AGENTGLASS_PRICING) out.AGENTGLASS_PRICING = env.AGENTGLASS_PRICING;
  if (env.TZ) out.TZ = env.TZ;
  return out;
}

/** Whether the reader may answer a read that prices tokens. A table refreshed at run time lives in
 *  the server only (pricing.ts), so with the refresh on the reader's prices could be older. */
export function readerPricesMatch(env: Record<string, string | undefined>): boolean {
  return !!env.AGENTGLASS_PRICING || !/^(1|true|yes|on)$/i.test(env.AGENTGLASS_PRICING_REFRESH ?? "");
}

function settle(id: number, data: unknown | null) {
  const done = waiting.get(id);
  if (!done) return;
  waiting.delete(id);
  if (data === null) counts.fellBack++; else counts.served++;
  done(data);
}

function launch(): boolean {
  const argv = readerArgv(process.execPath, new URL("../index.ts", import.meta.url).pathname);
  try {
    child = Bun.spawn(argv, { env: readerEnv(process.env, dbFile), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  } catch (e) { child = null; log(`[dbreader] cannot start (${String(e)}); reads stay on the server`); return false; }
  const me = child;
  // loop-ok: kills one child
  const hung = setTimeout(() => { if (child === me && !ready) { log("[dbreader] no ready in 5 s; killing it"); try { me.kill(); } catch { /* gone */ } } }, READY_MS);
  (async () => {
    const split = lineSplitter();
    const dec = new TextDecoder();
    try {
      for await (const chunk of me.stdout as ReadableStream<Uint8Array>) {
        for (const l of split(dec.decode(chunk, { stream: true }))) {
          let m: { ready?: boolean; id?: number; ok?: boolean; data?: unknown; error?: string };
          try { m = JSON.parse(l); } catch { continue; }
          if (m.ready) { if (child === me) { ready = true; log("[dbreader] up"); } continue; }
          if (typeof m.id !== "number") continue;
          if (!m.ok) log(`[dbreader] ${String(m.error ?? "read failed").slice(0, 200)}`);
          settle(m.id, m.ok ? (m.data ?? null) : null);
        }
      }
    } catch { /* pipe closed: the exit handler below cleans up */ }
  })();
  me.exited.then(() => {
    clearTimeout(hung);
    if (child !== me) return;
    child = null; ready = false;
    // Whoever was waiting on it does the read itself.
    for (const id of [...waiting.keys()]) settle(id, null);
    if (stopping) return;
    deaths.push(Date.now());
    const wait = restartDelay(deaths, Date.now());
    if (wait === null) { log("[dbreader] died 4 times in a minute; reads stay on the server until it restarts"); return; }
    log(`[dbreader] exited; restarting in ${wait} ms`);
    // loop-ok: relaunches one child
    setTimeout(() => { if (!stopping && !child) launch(); }, wait);
  });
  return true;
}

export function startReader(path: string, logLine?: (l: string) => void): void {
  dbFile = path;
  if (logLine) log = logLine;
  stopping = false;
  launch();
}

export function stopReader(): void {
  stopping = true;
  try { (child?.stdin as { end(): void } | undefined)?.end(); } catch { /* gone */ }
}

/**
 * Ask the reader. Resolves to its answer, or to null when it is not up, has
 * died, answered an error, or took longer than `timeoutMs`.
 *
 * A reader that ran out of time is killed, not left: it is stuck on the disk
 * holding a read mark in the WAL, which keeps the server's checkpoints from
 * trimming the file, and everything queued behind it would time out as well.
 * It comes back through the restart rule.
 */
export function readVia(fn: ReadName, ctx: unknown, args: unknown[], timeoutMs = READ_TIMEOUT_MS): Promise<unknown | null> {
  const me = child;
  if (!me || !ready) { counts.fellBack++; return Promise.resolve(null); }
  const id = nextId++;
  return new Promise((resolve) => {
    // loop-ok: answers one pending read
    const late = setTimeout(() => {
      if (!waiting.has(id)) return;
      log(`[dbreader] ${fn} not answered in ${timeoutMs} ms; the server reads it and the reader is restarted`);
      settle(id, null);
      // SIGKILL: it holds nothing to tidy, and a process stuck in the kernel or stopped answers no other signal in time.
      if (child === me) { try { me.kill("SIGKILL"); } catch { /* gone */ } }
    }, timeoutMs);
    waiting.set(id, (data) => { clearTimeout(late); resolve(data); });
    try {
      const pipe = me.stdin as { write(s: string): void; flush(): void };
      pipe.write(JSON.stringify({ id, fn, ctx, args }) + "\n");
      pipe.flush();
    } catch { settle(id, null); }
  });
}
