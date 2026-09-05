/*
 * The facts a row needs that `docker ps` does not hand over.
 *
 * Three of them — health, how long it has been up, how many times it has died
 * and come back — decide whether a row is worth looking at, and today the panel
 * has none of the three. What it has is `status`, a sentence written for humans
 * ("Up 4 hours (healthy)"), and the honest half of this file reads that
 * sentence rather than paying for a second docker call.
 *
 * The other half needs `docker inspect`, and that is where the cost discipline
 * lives. One inspect per container per poll would be twelve processes every two
 * seconds; instead the caller batches every visible container into ONE inspect
 * on a slower clock, because none of these numbers change fast: a restart count
 * that is fifteen seconds stale has never misled anybody, and a health check
 * that just failed is already visible in `status`.
 */

/** What the panel colours a row by. `null` means the container declares no
 *  health check at all — different from "not healthy", and it must not be
 *  drawn as a warning. */
export type Health = "healthy" | "unhealthy" | "starting" | null;

/**
 * Health, out of the status sentence. Free: the string is already in the poll.
 *
 * Docker writes it three ways — `(healthy)`, `(unhealthy)`, `(health: starting)`
 * — and everything else is a container without a check.
 */
export function healthOf(status: string | null | undefined): Health {
  const s = status ?? "";
  if (/\(health:\s*starting\)/i.test(s)) return "starting";
  if (/\(unhealthy\)/i.test(s)) return "unhealthy";
  if (/\(healthy\)/i.test(s)) return "healthy";
  return null;
}

/**
 * The human part of the status, without the health parenthesis: "Up 4 hours",
 * "Exited (0) 2 hours ago".
 *
 * Kept as docker's own words instead of being recomputed from a timestamp. The
 * timestamp version reads better right up until the clock drifts or the
 * container is in a state that has no start time, and then it reads as a bug.
 */
export function uptimeOf(status: string | null | undefined): string {
  // Only the health parenthesis, never any other one: `Exited (137) 5 minutes
  // ago` has to survive intact, and an alternation that forgets to close the
  // first branch eats the `)` and leaves the rest.
  return (status ?? "").replace(/\s*\((?:un)?healthy\)|\s*\(health:[^)]*\)/i, "").trim();
}

/** True while docker is restarting the container in a loop — the state that
 *  looks "up" in a list and is anything but. */
export const isRestarting = (state: string | null | undefined): boolean => (state ?? "").toLowerCase() === "restarting";

/** What one `docker inspect` gives us that ps does not. */
export interface ContainerFacts {
  /** ISO timestamp of the current start, for an exact uptime in the detail. */
  startedAt: string | null;
  /** How many times docker has restarted it since it was created. Zero is the
   *  normal case and is still worth serving: absent and zero are different. */
  restarts: number;
  /** The last health probe's own output, trimmed. This is the line that says
   *  WHY something is unhealthy, and today it takes a trip to `docker inspect`
   *  to read — which is exactly the trip nobody makes. */
  healthError: string | null;
  /** Consecutive failing probes, as docker counts them. */
  healthFailures: number;
  /** Read-write volume mounts, by volume name. The list side of "who is holding
   *  this volume", without a second call. */
  volumes: { name: string; rw: boolean; destination: string }[];
}

const EMPTY: ContainerFacts = { startedAt: null, restarts: 0, healthError: null, healthFailures: 0, volumes: [] };

/**
 * Parse `docker inspect a b c` — always an array, one entry per container.
 *
 * Tolerant on purpose: a field docker renames between versions costs that one
 * field, not the whole row. Anything unreadable is simply absent, and absent is
 * a state the UI already has to draw for a container that has never been
 * inspected.
 */
export function parseFacts(stdout: string): Map<string, ContainerFacts> {
  const out = new Map<string, ContainerFacts>();
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return out; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    const one = row as Record<string, any>;
    const id = typeof one?.Id === "string" ? one.Id.slice(0, 12) : "";
    if (!id) continue;
    const health = one?.State?.Health;
    const log = Array.isArray(health?.Log) ? health.Log[health.Log.length - 1] : null;
    out.set(id, {
      startedAt: typeof one?.State?.StartedAt === "string" && !one.State.StartedAt.startsWith("0001-")
        ? one.State.StartedAt
        : null,
      restarts: Number.isFinite(one?.RestartCount) ? Number(one.RestartCount) : 0,
      // The probe's output, first line only: these end in a stack trace often
      // enough that the whole thing would push the row off screen.
      healthError: typeof log?.Output === "string" && log.Output.trim() && Number(log?.ExitCode) !== 0
        ? log.Output.trim().split("\n")[0]!.slice(0, 200)
        : null,
      healthFailures: Number.isFinite(health?.FailingStreak) ? Number(health.FailingStreak) : 0,
      volumes: Array.isArray(one?.Mounts)
        ? one.Mounts
            .filter((m: any) => m?.Type === "volume" && typeof m?.Name === "string")
            .map((m: any) => ({ name: String(m.Name), rw: m.RW !== false, destination: String(m.Destination ?? "") }))
        : [],
    });
  }
  return out;
}

/** The facts for one container, or the honest empty set. Callers never have to
 *  branch on "have we inspected this yet". */
export const factsFor = (map: Map<string, ContainerFacts>, id: string): ContainerFacts => map.get(id) ?? EMPTY;
