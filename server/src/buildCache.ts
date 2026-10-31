// The Docker build cache: shared by every project on the machine, tens of GB,
// and not a leftover of any one pull request. So it is NOT in the per-PR plan
// (cleanup.ts) and never runs by itself: a person asks for its size, and a
// person prunes it. The next build of every project is slower afterwards.
//
// `docker buildx du` prints a table and a trailer (`Reclaimable:  49.12GB`,
// `Total:  52.3GB`); `docker builder prune -a -f` ends with `Total:  12.3GB`.
// Measured: Reclaimable counts the shared records too, and a plain prune (no --all)
// keeps those, so it freed 17.7 GB of the 31.6 GB it had offered and offered the
// rest again. The prune is --all so the size offered is the size freed.
// Both go through the injected Runner, so a test fakes docker.
import { parseDockerSize, type Runner } from "./diskclean.ts";

export interface BuildCacheSize { ok: true; reclaimableBytes: number; totalBytes: number }
export interface BuildCachePruned { ok: true; freedBytes: number; remainingBytes?: number }
export type BuildCacheError = { ok: false; error: string; status: number };

const trailer = (out: string, label: string): number | null => {
  const m = new RegExp(`^${label}:\\s*(\\S+)`, "mi").exec(out);
  return m ? parseDockerSize(m[1]) : null;
};
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

export async function buildCacheSize(run: Runner): Promise<BuildCacheSize | BuildCacheError> {
  const r = await run("docker", ["buildx", "du"], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, error: `docker could not read the build cache: ${firstLine(r.stderr) || "not installed"}`, status: 502 };
  const total = trailer(r.stdout, "Total"), rec = trailer(r.stdout, "Reclaimable");
  // An empty cache prints no trailer on some versions: that is zero, not a failure.
  return { ok: true, totalBytes: total ?? 0, reclaimableBytes: rec ?? total ?? 0 };
}

export async function pruneBuildCache(run: Runner): Promise<BuildCachePruned | BuildCacheError> {
  const r = await run("docker", ["builder", "prune", "-a", "-f"], { timeoutMs: 600_000 });
  if (r.code !== 0) return { ok: false, error: `docker could not prune the build cache: ${firstLine(r.stderr) || `exit ${r.code}`}`, status: 502 };
  // What is left, read again; a failed read leaves it out rather than guess.
  const after = await buildCacheSize(run);
  return { ok: true, freedBytes: trailer(r.stdout, "Total") ?? 0, ...(after.ok ? { remainingBytes: after.totalBytes } : {}) };
}
