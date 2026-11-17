/*
 * The orphan sweep: images and named volumes that no container uses and whose owner (a checkout, a commit) is gone.
 *
 * Why it exists: a repository's build tags an image with the short sha of the commit it was built at, or names a cache
 * volume for the checkout it was made for. Neither the repository's teardown nor Docker ever removes the one a later
 * commit or a deleted checkout left behind, and each is gigabytes. Only agentglass knows which checkouts and commits are
 * still live.
 *
 * What it will never list, whatever the settings say: anonymous volumes (64 hex characters, they hold database data),
 * anything a container (running OR stopped) mounts or runs, and a volume whose name matches the repo's `orphanKeep` list.
 * Volumes are listed only when the person wrote a pattern for them (`orphanVolumePatterns`, default empty), and removed by
 * `removeOrphanVolume` below, never by dockerprune.removeVolume, which keeps refusing data volumes: this one is opt-in by
 * pattern, for cache volumes like `app-cache-{slug}`.
 *
 * The decision is pure (`decideOrphans`); `listOrphans` gathers the facts through an injected runner.
 */
import { shaInAny, slugForTag, tagTemplateRegex, checkTagTemplate } from "../../shared/dockerTag.ts";
import type { Runner } from "./diskclean.ts";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VOL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ANON_VOLUME = /^[0-9a-f]{64}$/i;
/** A tag slug is only trusted as a checkout's when it is shaped like a card id (`orbit-1042`): `latest` and `dev` are no checkout. */
const CARD_SLUG = /^[a-z]+-\d+/;

export interface LiveCheckouts {
  /** The main checkout's path. */
  main: string;
  /** Full 40-char HEADs of the main checkout and every live worktree. */
  heads: string[];
  /** Slugs a tag can spell for those checkouts (branch, card id of the branch, folder name), already normalised. */
  slugs: string[];
}

/** `git worktree list --porcelain` read for what the sweep and the cleanup keep: the full HEADs and the slugs. `skip` is a checkout about to go. */
export function parseLiveCheckouts(porcelain: string, skip?: string | null): LiveCheckouts | null {
  const heads: string[] = [], slugs = new Set<string>();
  let main = "", path = "", head = "", branch = "", first = true;
  const flush = () => {
    if (!path) return;
    if (first) main = path;
    if (path === skip && !first) { path = head = branch = ""; first = false; return; }
    first = false;
    if (/^[0-9a-f]{40}$/i.test(head)) heads.push(head.toLowerCase());
    for (const s of [branch, /^([A-Za-z]+-\d+)/.exec(branch)?.[1] ?? "", path.split("/").filter(Boolean).pop() ?? ""]) if (s) slugs.add(slugForTag(s));
    path = head = branch = "";
  };
  for (const l of porcelain.split("\n")) {
    if (l.startsWith("worktree ")) { flush(); path = l.slice(9); }
    else if (l.startsWith("HEAD ")) head = l.slice(5);
    else if (l.startsWith("branch ")) branch = l.slice(7).replace("refs/heads/", "");
    else if (!l) flush();
  }
  flush();
  return main ? { main, heads, slugs: [...slugs].filter(Boolean) } : null;
}

export async function liveCheckouts(run: Runner, repo: string, skip?: string | null): Promise<LiveCheckouts | null> {
  const r = await run("git", ["-C", repo, "worktree", "list", "--porcelain"], { timeoutMs: 20_000 });
  return r.code === 0 ? parseLiveCheckouts(r.stdout, skip) : null;
}

/** A glob (`*`, `?`) as an anchored regex; every other character is literal. */
export function globToRegex(g: string): RegExp {
  return new RegExp(`^${g.split(/([*?])/).map((p) => (p === "*" ? ".*" : p === "?" ? "." : escapeRe(p))).join("")}$`);
}
const kept = (name: string, keep: readonly string[]) => keep.some((g) => globToRegex(g).test(name));

/** `app-cache-{slug}` as a regex that captures the slug; null when the pattern does not hold `{slug}` exactly once. */
export function volumePatternRegex(p: string): RegExp | null {
  if (p.split("{slug}").length !== 2) return null;
  return new RegExp(`^${p.split("{slug}").map(escapeRe).join("(?<slug>.+?)")}$`, "i");
}

export interface OrphanInput {
  template: string;
  volumePatterns: readonly string[];
  keep: readonly string[];
  images: { id: string; ref: string; bytes: number | null }[];
  volumes: { name: string; bytes: number | null }[];
  /** `docker ps -a`: image refs/ids in use, and named volumes mounted, by any container, running or stopped. */
  usedImages: ReadonlySet<string>;
  mountedVolumes: ReadonlySet<string>;
  live: Pick<LiveCheckouts, "heads" | "slugs">;
}

export interface Orphan { kind: "image" | "volume"; target: string; id?: string; bytes: number | null; reason: string }

const usedBy = (used: ReadonlySet<string>, ref: string, id: string) =>
  used.has(ref) || [...used].some((u) => /^(sha256:)?[0-9a-f]{12,64}$/i.test(u) && (id.startsWith(u.replace(/^sha256:/, "").slice(0, 12)) || u.replace(/^sha256:/, "").startsWith(id)));

export function decideOrphans(i: OrphanInput): Orphan[] {
  const out: Orphan[] = [];
  const rx = i.template && checkTagTemplate(i.template).ok ? tagTemplateRegex(i.template) : null;
  const liveSlugs = new Set(i.live.slugs);
  if (rx) {
    for (const im of i.images) {
      const g = rx.exec(im.ref)?.groups;
      if (!g) continue;
      const slug = g.slug ? slugForTag(g.slug) : "", sha = g.sha ?? "";
      if (usedBy(i.usedImages, im.ref, im.id)) continue;
      if (slug && !sha && !CARD_SLUG.test(slug)) continue;
      const why: string[] = [];
      if (slug && !liveSlugs.has(slug)) why.push(`no checkout is on ${g.slug}`);
      if (sha && !shaInAny(sha, i.live.heads)) why.push(`built at ${sha}, which no checkout is on`);
      if (why.length) out.push({ kind: "image", target: im.ref, id: im.id, bytes: im.bytes, reason: why.join("; ") });
    }
  }
  const pats = i.volumePatterns.map((p) => volumePatternRegex(p));
  for (const v of i.volumes) {
    if (ANON_VOLUME.test(v.name) || i.mountedVolumes.has(v.name) || kept(v.name, i.keep)) continue;
    for (const p of pats) {
      const slug = p?.exec(v.name)?.groups?.slug;
      if (!slug) continue;
      if (!liveSlugs.has(slugForTag(slug))) out.push({ kind: "volume", target: v.name, bytes: v.bytes, reason: `no checkout is on ${slug}` });
      break;
    }
  }
  return out;
}

export interface OrphanUsage {
  perImage: { id: string; repository: string; tag: string; bytes: number | null; unique: number | null }[];
  perVolume: { name: string; bytes: number | null }[];
}

/** Containers (running or stopped): the image each uses and the named volumes each mounts. Null when docker did not answer. */
export async function containerUse(run: Runner): Promise<{ images: Set<string>; volumes: Set<string> } | null> {
  const ps = await run("docker", ["ps", "-a", "--no-trunc", "--format", "{{.Image}}\t{{.Mounts}}"], { timeoutMs: 20_000 });
  if (ps.code !== 0) return null;
  const images = new Set<string>(), volumes = new Set<string>();
  for (const l of ps.stdout.split("\n")) {
    const [image = "", mounts = ""] = l.split("\t");
    if (image) images.add(image.trim());
    for (const m of mounts.split(",")) if (m.trim()) volumes.add(m.trim());
  }
  return { images, volumes };
}

export interface OrphanSettings { template: string; volumePatterns: string[]; keep: string[] }

/**
 * One pass: the facts, then the decision. When docker or git did not answer the result says so (`error`): a failed read must
 * never look like "no leftovers", and it is never a guess.
 */
export async function listOrphans(run: Runner, repo: string, cfg: OrphanSettings, usage: OrphanUsage): Promise<{ orphans: Orphan[]; error?: string }> {
  if (!cfg.template && !cfg.volumePatterns.length) return { orphans: [] };
  const [live, use] = await Promise.all([liveCheckouts(run, repo), containerUse(run)]);
  if (!live || !use) return { orphans: [], error: `could not check: ${!live ? "git did not list the live checkouts" : "docker did not list the containers"}` };
  return { orphans: decideOrphans({
    template: cfg.template, volumePatterns: cfg.volumePatterns, keep: cfg.keep,
    images: usage.perImage.filter((i) => i.repository && i.repository !== "<none>" && i.tag && i.tag !== "<none>").map((i) => ({ id: i.id, ref: `${i.repository}:${i.tag}`, bytes: i.unique ?? i.bytes })),
    volumes: usage.perVolume,
    usedImages: use.images, mountedVolumes: use.volumes, live,
  }) };
}

export interface VolumeRemoval { ok: boolean; error?: string }

/**
 * Remove one named volume of the sweep. All of these hold, or nothing is removed: the name matches a pattern the person
 * wrote, it is not anonymous, it is not on the keep list, and no container (stopped ones too) mounts it, read again right
 * before `docker volume rm`. No `-f`: Docker still refuses a volume a container holds.
 */
export async function removeOrphanVolume(run: Runner, name: string, cfg: Pick<OrphanSettings, "volumePatterns" | "keep">): Promise<VolumeRemoval> {
  if (!VOL_ID.test(name) || ANON_VOLUME.test(name)) return { ok: false, error: `${name} is not a volume this sweep may remove` };
  if (!cfg.volumePatterns.some((p) => volumePatternRegex(p)?.test(name))) return { ok: false, error: `${name} matches no orphanVolumePatterns entry` };
  if (kept(name, cfg.keep)) return { ok: false, error: `${name} is on the keep list` };
  const ps = await run("docker", ["ps", "-a", "--filter", `volume=${name}`, "--format", "{{.Names}}"], { timeoutMs: 20_000 });
  if (ps.code !== 0) return { ok: false, error: "docker did not answer, so it is not known whether a container mounts it" };
  const users = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (users.length) return { ok: false, error: `container ${users[0]} mounts ${name}` };
  const rm = await run("docker", ["volume", "rm", name], { timeoutMs: 30_000 });
  return rm.code === 0 ? { ok: true } : { ok: false, error: (rm.stderr.trim().split("\n")[0] || "docker refused").replace(/^Error response from daemon: /, "") };
}
