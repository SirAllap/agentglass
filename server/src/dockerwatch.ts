/*
 * Watching containers finish, so the ledger can say who wrote what.
 *
 * `docker events` is the only place the daemon volunteers "this container just
 * ended". Everything else about volume ownership follows from that moment: the
 * container that is exiting still exists, so it can be inspected, and its
 * read-write volume mounts plus its compose `working_dir` label are exactly the
 * pair the ledger needs.
 *
 * Deliberately small and deliberately quiet:
 *
 *   - one process for the whole machine, not one per panel;
 *   - one `docker inspect` per container that ENDS, which on a normal day is a
 *     handful, and zero while nothing is happening;
 *   - it never blocks anything. If the watcher is not running, volumes simply
 *     read "unknown", which is the state the app has been in since it existed.
 */
import { basename } from "node:path";
import { dockerBin } from "./docker.ts";
import { branchOfCheckout } from "./dockerowner.ts";
import { noteWrite } from "./dockerledger.ts";

/** What one container's exit tells us. Exported for the test, which drives this
 *  with recorded docker output rather than a daemon. */
export interface ExitFacts {
  /** Volume names the container mounted READ-WRITE. Read-only mounts are not
   *  writes and must not claim ownership of anything. */
  volumes: string[];
  /** The compose working_dir label — the checkout it was brought up from. */
  workingDir: string | null;
  /** Compose service name where there is one: `install-app-keypad` says far
   *  more in a tooltip than a hex id. */
  name: string;
}

/** Pull the facts out of `docker inspect` for one container. */
export function exitFacts(stdout: string): ExitFacts | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const one = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any> | undefined;
  if (!one) return null;
  const labels = one?.Config?.Labels ?? {};
  const volumes = Array.isArray(one?.Mounts)
    ? one.Mounts
        .filter((m: any) => m?.Type === "volume" && typeof m?.Name === "string" && m.RW !== false)
        .map((m: any) => String(m.Name))
    : [];
  return {
    volumes,
    workingDir: typeof labels["com.docker.compose.project.working_dir"] === "string"
      ? labels["com.docker.compose.project.working_dir"]
      : null,
    name: String(labels["com.docker.compose.service"] || one?.Name || "").replace(/^\//, "") || "a container",
  };
}

/**
 * Record one container's exit.
 *
 * Split from the transport so the interesting half — what counts as a write,
 * and what happens when the checkout is unknown — can be tested without a
 * daemon, and so a change to docker's event format cannot silently stop the
 * ledger from filling.
 */
export function recordExit(facts: ExitFacts | null, now: () => Date = () => new Date()): boolean {
  if (!facts || !facts.volumes.length) return false;
  // No working_dir label: a `docker run` by hand, or an old compose. The write
  // happened and the volume is no longer pristine, but nobody can be named for
  // it — and naming the wrong checkout is worse than naming none.
  const dir = facts.workingDir;
  if (!dir) return false;
  noteWrite(facts.volumes, {
    worktree: basename(dir) || dir,
    branch: branchOfCheckout(dir),
    at: now().toISOString(),
    via: facts.name,
  });
  return true;
}

/* -------------------------------------------------------------------------
 * The transport.
 * ---------------------------------------------------------------------- */

let proc: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;
let restartAt = 0;

/** Is the watcher running? Exported for the status surface and the tests. */
export const watching = (): boolean => proc !== null;

/**
 * Start watching, if it is not already.
 *
 * Called from the overview rather than at boot: a server nobody has asked about
 * docker should not be holding a docker process open. Idempotent, so the poll
 * can call it every time without thinking about it.
 */
export function startVolumeWatch(): void {
  if (proc || stopping) return;
  if (Date.now() < restartAt) return;            // backing off after a failure
  const bin = dockerBin();
  if (!bin) return;

  try {
    proc = Bun.spawn([bin, "events", "--filter", "type=container", "--filter", "event=die", "--format", "{{json .}}"], {
      stdout: "pipe", stderr: "ignore",
    });
  } catch {
    // No daemon, no permission, no docker: try again later, say nothing. This
    // is a nicety, not a feature anybody is waiting on.
    restartAt = Date.now() + 60_000;
    return;
  }

  const child = proc;
  void (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) await onEvent(line, bin);
      }
    } catch { /* the process died; the exit handler below deals with it */ }
  })();

  void child.exited.then(() => {
    if (child === proc) proc = null;
    // A daemon restart kills this. Come back, but not in a hot loop.
    if (!stopping) restartAt = Date.now() + 5_000;
  });
}

/** Stop watching — used at shutdown and by the tests. */
export function stopVolumeWatch(): void {
  stopping = true;
  try { proc?.kill(); } catch { /* already gone */ }
  proc = null;
  stopping = false;
}

async function onEvent(line: string, bin: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let id = "";
  try {
    const ev = JSON.parse(text) as { id?: string; Actor?: { ID?: string } };
    id = String(ev.id || ev.Actor?.ID || "");
  } catch { return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) return;

  // The container is exiting, not gone: inspect still works, and this is the
  // only moment its mounts and its checkout are both still readable.
  try {
    const p = Bun.spawn([bin, "inspect", id], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return;
    recordExit(exitFacts(out));
  } catch { /* the container was removed first: nothing to record */ }
}
