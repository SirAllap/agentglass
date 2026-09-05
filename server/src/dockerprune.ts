/*
 * Reclaiming disk, with the consequence written down.
 *
 * Every one of these is a delete, and the difference between them is enormous
 * and completely invisible in a UI that offers them as three identical buttons:
 *
 *   - build cache older than N days:  nothing breaks; the next build is slower.
 *   - an image nothing is using:      nothing breaks unless you wanted that tag.
 *   - `docker volume prune`:          takes every node_modules volume on the
 *                                     machine and hands 25 worktrees a cold
 *                                     install each.
 *
 * So this module exposes the first two and NOT the third. Not because the third
 * cannot be done — one command, and the user knows it — but because a button
 * for it in a panel is an invitation, and the thing it destroys is measured in
 * hours of other people's afternoons.
 */
import { dockerBin } from "./docker.ts";
import { parseSize } from "./dockervolumes.ts";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/;

export interface PruneResult {
  ok: boolean;
  /** Bytes docker says it reclaimed. Null when it did not say. */
  freed: number | null;
  /** What was removed, for the sentence afterwards. */
  removed: string[];
  error?: string;
}

async function run(args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn([dockerBin() ?? "docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { code: code ?? 1, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

/**
 * What docker says it freed — its accounting, not ours.
 *
 * Two shapes, because the two commands print differently: `docker system
 * prune` ends with "Total reclaimed space: 41.23GB" and `docker buildx prune`
 * with a bare "Total:\t111GB" after the list of what it removed.
 */
export function reclaimedFrom(stdout: string): number | null {
  const m = /Total reclaimed space:\s*([\d.]+\s*[KMGTP]?i?B)/i.exec(stdout)
    ?? /^Total:\s*([\d.]+\s*[KMGTP]?i?B)\s*$/im.exec(stdout);
  return m ? parseSize(m[1]) : null;
}

/**
 * Keep the build cache under a budget, pruning least-recently-used first.
 *
 * A budget and not an age filter, because the age filters do not work. Measured
 * on docker 29.7.2 / buildkit v0.32.2 with 177GB of cache, 96GB of it last used
 * MONTHS ago:
 *
 *     docker builder prune --filter until=720h        →  0B
 *     docker buildx  prune --filter unused-for=720h   →  0B
 *     docker buildx  prune --max-used-space 170GB     →  0B   (human size)
 *     docker buildx  prune --max-used-space 170000000000  →  2.5GB  (raw bytes)
 *
 * So: raw bytes, and a cap rather than a cutoff. The one that shipped here
 * first was `--filter until=720h`, which would have been a button that freed
 * nothing and said so cheerfully — worse than no button, because it teaches
 * people the panel is lying about something they cannot check.
 */
export async function capBuildCache(bytes: number): Promise<PruneResult> {
  // Floor at 1GB: a cap small enough to empty the cache is not a budget, it is
  // `prune --all` with extra steps, and the whole point of the budget is that
  // what you use every day survives.
  const budget = Math.max(Math.floor(bytes) || 60_000_000_000, 1_000_000_000);
  const r = await run(["buildx", "prune", "--force", "--max-used-space", String(budget)]);
  if (r.code !== 0) return { ok: false, freed: null, removed: [], error: r.stderr.trim() || "docker buildx prune failed" };
  return { ok: true, freed: reclaimedFrom(r.stdout), removed: [`build cache above ${Math.round(budget / 1e9)}GB`] };
}

/**
 * Remove images by id or tag.
 *
 * One call per image on purpose: `docker rmi a b c` stops at the first failure
 * and leaves the rest untouched, which reads as "the button did nothing". Here
 * an image that is still in use fails alone and says so, and the others go.
 */
export async function removeImages(refs: string[]): Promise<PruneResult> {
  const wanted = refs.filter((r) => ID_RE.test(r)).slice(0, 100);
  if (!wanted.length) return { ok: false, freed: null, removed: [], error: "nothing to remove" };
  const removed: string[] = [];
  const failed: string[] = [];
  for (const ref of wanted) {
    const r = await run(["image", "rm", ref], 60_000);
    if (r.code === 0) removed.push(ref);
    else failed.push(`${ref}: ${(r.stderr.trim().split("\n")[0] || "refused").replace(/^Error response from daemon: /, "")}`);
  }
  return {
    ok: removed.length > 0,
    freed: null,                       // `image rm` does not total it up
    removed,
    ...(failed.length ? { error: failed.join("; ") } : {}),
  };
}
