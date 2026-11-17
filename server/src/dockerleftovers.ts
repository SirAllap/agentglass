/*
 * Docker leftovers, per repository: what the orphan sweep lists and what the Images view needs to badge an image built at
 * an old commit. Computed when the Docker view loads or refreshes (the caller's trigger), never on a timer of its own.
 * The decisions are in dockerorphans.ts and shared/dockerTag.ts; this file only gathers the repositories and their facts.
 */
import { defaultCleanupCtx, mainCheckout } from "./cleanup.ts";
import { scopeRoots } from "./config.ts";
import { diskRows } from "./docker.ts";
import { liveCheckouts, listOrphans, removeOrphanVolume, type Orphan } from "./dockerorphans.ts";
import { removeImages } from "./dockerprune.ts";
import { cleanupConfigOf } from "./serverSettings.ts";

export interface RepoLeftovers {
  repo: string;
  template: string;
  /** Full HEADs of the main checkout and every live worktree: the web decides the "old commit" badge with them. */
  liveHeads: string[];
  orphans: Orphan[];
  /** Set when the sweep could not read git or docker: the view says so instead of showing "no leftovers". */
  error?: string;
  autoRemove: boolean;
}

/** The repositories of the app's scope that configured a template or a volume pattern, each once (by main checkout). */
async function repos(): Promise<string[]> {
  const cx = defaultCleanupCtx();
  const seen = new Set<string>();
  for (const root of scopeRoots()) {
    try { seen.add(await mainCheckout(root, cx)); } catch { /* not a repository */ }
  }
  return [...seen];
}

async function leftoversOf(repo: string, force: boolean): Promise<RepoLeftovers | null> {
  const cfg = cleanupConfigOf(repo);
  if (!cfg.dockerImageTagTemplate && !cfg.orphanVolumePatterns.length) return null;
  const run = defaultCleanupCtx().run;
  const base = { repo, template: cfg.dockerImageTagTemplate, orphans: [], autoRemove: false };
  const [live, rows] = await Promise.all([liveCheckouts(run, repo), diskRows(force)]);
  if (!live || !rows) return { ...base, liveHeads: [], error: `could not check: ${!live ? "git did not list the live checkouts" : "docker did not report disk usage"}` };
  const r = await listOrphans(run, repo, { template: cfg.dockerImageTagTemplate, volumePatterns: cfg.orphanVolumePatterns, keep: cfg.orphanKeep }, rows);
  return { repo, template: cfg.dockerImageTagTemplate, liveHeads: live.heads, orphans: r.orphans, ...(r.error ? { error: r.error } : {}), autoRemove: cfg.orphanAutoRemove && !r.error };
}

export async function dockerLeftovers(force = false): Promise<RepoLeftovers[]> {
  const out: RepoLeftovers[] = [];
  for (const r of await repos()) { const l = await leftoversOf(r, force); if (l) out.push(l); }
  return out;
}

/**
 * Remove what the person ticked, but only what is STILL listed: the list is read again here, so a container that started
 * since the view loaded keeps its image and its volume. Images go through `removeImages` (one call each), volumes through
 * `removeOrphanVolume`.
 */
export async function removeLeftovers(repoIn: string, images: string[], volumes: string[]): Promise<{ ok: boolean; error?: string; removed: string[] }> {
  const main = await mainCheckout(repoIn, defaultCleanupCtx()).catch(() => null);
  const known = main && (await repos()).includes(main) ? main : null;
  if (!known) return { ok: false, error: "that repository is not one of this app's projects", removed: [] };
  const l = await leftoversOf(known, false);
  const still = new Set((l?.orphans ?? []).map((o) => `${o.kind}:${o.target}`));
  const removed: string[] = [], errors: string[] = [];
  const imgs = images.filter((i) => still.has(`image:${i}`));
  if (imgs.length) { const r = await removeImages(imgs); removed.push(...r.removed); if (r.error) errors.push(r.error); }
  const cfg = cleanupConfigOf(known);
  for (const v of volumes.filter((x) => still.has(`volume:${x}`))) {
    const r = await removeOrphanVolume(defaultCleanupCtx().run, v, { volumePatterns: cfg.orphanVolumePatterns, keep: cfg.orphanKeep });
    if (r.ok) removed.push(v); else errors.push(`${v}: ${r.error}`);
  }
  const skipped = images.length + volumes.length - imgs.length - volumes.filter((x) => still.has(`volume:${x}`)).length;
  if (skipped) errors.push(`${skipped} no longer listed as orphaned, kept`);
  return { ok: removed.length > 0, ...(errors.length ? { error: errors.join("; ") } : {}), removed };
}
