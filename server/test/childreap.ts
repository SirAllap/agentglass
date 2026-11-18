/*
 * The suite takes the processes it started with it when it goes.
 *
 * tmpsweep.ts removes the scratch directories a run made. The processes are the
 * other half: 236 files start `server/src/index.ts` (or Chrome, or a stub agent)
 * with `Bun.spawn` and stop it in their own `afterAll`. A file that fails in its
 * `beforeAll`, a hook that times out, or a run stopped with Ctrl-C never gets
 * there, and the server it started keeps its port, its database and a few
 * hundred MB of RAM with nobody left to stop it.
 *
 * One preload rather than 236 `afterAll`s, for the same reason as tmpsweep.ts:
 * cleanup written at the call site is cleanup the next file forgets.
 *
 * The rule that keeps this safe: only pids THIS PROCESS spawned, recorded as
 * they are handed out, and never a match by name or pattern. Several agents run
 * the suite at once on this machine; a `pkill -f src/index.ts` would take their
 * servers too. A pid leaves the record as soon as its exit is seen, and an
 * unreaped child still holds its pid, so a pid in the record cannot belong to a
 * stranger by reuse.
 *
 * `node:child_process` is patched through `createRequire`, like `node:fs` in
 * tmpsweep.ts: the ESM namespace is frozen, the CommonJS object behind it is not.
 */
import { afterAll } from "bun:test";
import { createRequire } from "node:module";

type Exitable = { pid?: number; exited?: Promise<unknown>; once?: (e: string, f: () => void) => unknown };

/** Children this process started that have not been seen to exit. */
const live = new Set<number>();

/** Exposed for the guard test only: what is recorded right now. */
export const recordedChildren = (): number[] => [...live];

function track<T extends Exitable>(child: T): T {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return child;
  live.add(pid);
  const gone = () => { live.delete(pid); };
  if (child.exited) child.exited.then(gone, gone);
  else child.once?.("exit", gone);
  return child;
}

const bun = Bun as unknown as { spawn: (...a: unknown[]) => Exitable };
const realBunSpawn = bun.spawn;
bun.spawn = (...a: unknown[]) => track(realBunSpawn(...a));

type Cp = { spawn: (...a: unknown[]) => Exitable };
const cp = createRequire(import.meta.url)("node:child_process") as Cp;
const realCpSpawn = cp.spawn;
cp.spawn = (...a: unknown[]) => track(realCpSpawn(...a));

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * TERM first, so a server runs its own exit hook and stops the helpers it
 * started (volumes.ts); KILL whatever is still there after `graceMs`.
 * Synchronous on purpose: an `exit` or signal handler cannot await.
 */
export function reapChildren(graceMs = 1_000): void {
  const pids = [...live];
  live.clear();
  if (pids.length === 0) return;
  for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const until = Date.now() + graceMs;
  while (Date.now() < until && pids.some(alive)) Bun.sleepSync(20);
  for (const pid of pids) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

/* A root hook from a preload: runs once, after the last test of the run. */
afterAll(() => reapChildren());
process.on("exit", () => reapChildren(0));
/* Listed before tmpsweep.ts in bunfig.toml, so these run before its handler
   calls process.exit. Re-raised the same way so the exit code still says why. */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { reapChildren(); process.exit(sig === "SIGINT" ? 130 : 143); });
}
