/*
 * Volumes, as something other than a name.
 *
 * Until now a volume in this panel was `{ name, driver }` — which is to say the
 * two least useful facts about it. What people actually ask is: how big is it,
 * who is holding it, and is what is inside it mine? On a machine where every
 * worktree shares the same global volumes, the last one decides whether the
 * page you are looking at is the code you are editing.
 *
 * All of it is SLOW LANE. `docker system df -v` makes the daemon add up every
 * layer and every volume: measured in seconds on a full machine, which is why
 * it is asked for when a human opens the volumes section and never on the poll.
 * The fast-lane lock (test/docker-fast-lane.test.ts) exists to keep it that way.
 */
import { dockerBin } from "./docker.ts";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

async function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
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
 * Docker's human sizes back to bytes: `1.9GB`, `318MB`, `0B`, `1.317GB`.
 *
 * Its units are decimal (GB, not GiB) whatever the tool that prints them says,
 * so this uses 1000s. Being consistent with `docker system df` matters more
 * than being right about SI: the two numbers sit next to each other on screen.
 */
export function parseSize(text: string | null | undefined): number | null {
  const m = /^\s*([\d.]+)\s*([KMGTP]?i?)B?\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toUpperCase().replace("I", "");
  const mult = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[unit];
  return mult ? Math.round(n * mult) : null;
}

/* The formatting lives in shared/dockerSize.ts: the panel prints these too,
   and two roundings that disagree make one of them look wrong. */
export { humanSize } from "../../shared/dockerSize.ts";

export interface VolumeUsage { name: string; bytes: number | null; links: number }
export interface DiskUsage {
  images: number; containers: number; volumes: number; buildCache: number; reclaimable: number;
  /** Per-volume, from the same call — asking twice would double the cost. */
  perVolume: VolumeUsage[];
  /** Images with no repository tag, and images whose tag names a worktree that
   *  no longer exists, are worked out by the caller: this only carries sizes. */
  /** `bytes` is docker's `Size`, which counts shared layers once per image —
   *  useful for "how big is this image", useless for "how much would I get
   *  back". `unique` is what deleting it actually frees. */
  perImage: { id: string; repository: string; tag: string; bytes: number | null; unique: number | null; containers: number }[];
}

/**
 * The totals line, out of `docker system df` (NOT the verbose one).
 *
 * Measured on a real daemon, and it is the reason this is a separate call: the
 * verbose output has no `Reclaimable` field at all, and its per-image `Size`
 * counts shared layers once per image — summing it gave 300GB on a machine
 * `docker system df` calls 91.89GB. The non-verbose form is one line per type
 * with docker's own arithmetic already done:
 *
 *   {"Type":"Images","Size":"91.89GB","Reclaimable":"45.67GB (49%)", …}
 *
 * Being consistent with the command people compare against is the whole point
 * of the number, so it is taken from there rather than recomputed.
 */
export function parseTotals(stdout: string): Pick<DiskUsage, "images" | "containers" | "volumes" | "buildCache" | "reclaimable"> {
  const totals = { images: 0, containers: 0, volumes: 0, buildCache: 0, reclaimable: 0 };
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let row: any;
    try { row = JSON.parse(t); } catch { continue; }
    // "45.67GB (49%)" — the percentage is docker's, and it is not a size.
    const size = parseSize(row?.Size) ?? 0;
    const free = parseSize(String(row?.Reclaimable ?? "").replace(/\s*\(.*\)$/, "")) ?? 0;
    totals.reclaimable += free;
    switch (String(row?.Type ?? "")) {
      case "Images": totals.images = size; break;
      case "Containers": totals.containers = size; break;
      case "Local Volumes": totals.volumes = size; break;
      case "Build Cache": totals.buildCache = size; break;
    }
  }
  return totals;
}

/**
 * Disk usage: the totals from `docker system df`, the per-item detail from
 * `-v`.
 *
 * Two calls rather than one, because they answer different questions and only
 * the verbose one lists individual volumes. Both are expensive — the daemon
 * walks layers to answer either — which is why this whole module is the slow
 * lane and the caller owns the clock.
 */
export async function diskUsage(): Promise<DiskUsage | null> {
  const [totalsRes, r] = await Promise.all([
    run(["system", "df", "--format", "{{json .}}"], 30_000),
    run(["system", "df", "-v", "--format", "{{json .}}"], 30_000),
  ]);
  if (r.code !== 0) return null;
  let j: any;
  try { j = JSON.parse(r.stdout.trim().split("\n").find((l) => l.trim().startsWith("{")) ?? "null"); } catch { return null; }
  if (!j) return null;

  const images = Array.isArray(j.Images) ? j.Images : [];
  const volumes = Array.isArray(j.Volumes) ? j.Volumes : [];

  return {
    ...parseTotals(totalsRes.code === 0 ? totalsRes.stdout : ""),
    perVolume: volumes.map((v: any) => ({
      name: String(v?.Name ?? ""),
      bytes: parseSize(v?.Size),
      links: Number(v?.Links ?? 0) || 0,
    })).filter((v: VolumeUsage) => v.name),
    perImage: images.map((i: any) => ({
      id: String(i?.ID ?? "").slice(0, 12),
      repository: String(i?.Repository ?? ""),
      tag: String(i?.Tag ?? ""),
      bytes: parseSize(i?.Size),
      unique: parseSize(i?.UniqueSize),
      containers: Number(i?.Containers ?? 0) || 0,
    })).filter((i: { id: string }) => i.id),
  };
}

/** Containers holding a volume right now, running or not. */
export async function mountedBy(name: string): Promise<{ name: string; state: string }[]> {
  if (!ID_RE.test(name)) return [];
  const r = await run(["ps", "--all", "--filter", `volume=${name}`, "--format", "{{.Names}}\t{{.State}}"], 8_000);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [n, state = ""] = l.split("\t");
    return { name: n ?? "", state: state.toLowerCase() };
  }).filter((c) => c.name);
}

/* -------------------------------------------------------------------------
 * Looking inside.
 * ---------------------------------------------------------------------- */

/**
 * Which image to use for a look inside a volume.
 *
 * Never a pull. Downloading an image because somebody clicked a disclosure
 * triangle is exactly the kind of surprise this app should not spring on a
 * metered connection — so if nothing suitable is already here, the answer is a
 * sentence saying so and the command to run by hand.
 *
 * busybox or alpine, and nothing else. The first version fell back to "any
 * image that is already local, since the container only has to run `ls`" —
 * which meant a disclosure triangle could start whatever happened to be on
 * the machine: an image with an ENTRYPOINT of its own, one that expects
 * secrets in its environment, one somebody built and never meant to run
 * against a volume. The two helper images are the only ones whose behaviour
 * this code knows; with neither present the answer is the sentence and the
 * command, not a guess.
 */
export async function peekImage(): Promise<string | null> {
  const r = await run(["images", "--format", "{{.Repository}}:{{.Tag}}"], 8_000);
  if (r.code !== 0) return null;
  return pickPeekImage(r.stdout.split("\n"));
}

/** `busybox` or `alpine` under any tag, `:latest` preferred, official-registry
 *  spellings included — or null. Pure, so the rule is testable without docker. */
const HELPER_IMAGE = /^(?:docker\.io\/)?(?:library\/)?(busybox|alpine):(?!<none>)[^\s:]+$/;
export function pickPeekImage(images: string[]): string | null {
  const local = images.map((l) => l.trim()).filter((l) => l && !l.startsWith("<none>") && HELPER_IMAGE.test(l));
  for (const preferred of ["busybox:latest", "alpine:latest"]) {
    if (local.includes(preferred)) return preferred;
  }
  return local.find((i) => /(^|\/)busybox:/.test(i)) ?? local[0] ?? null;
}

export interface PeekEntry { name: string; dir: boolean; bytes: number | null; when: string }
export interface PeekResult { ok: boolean; entries?: PeekEntry[]; image?: string; error?: string; hint?: string }

/**
 * List what is inside a volume, at a path.
 *
 * Read-only mount, always: this is a viewer, and a container started to answer
 * "what is in here" has no business being able to change the answer. One `ls`,
 * capped — a bundle directory with ten thousand hashed files is not a list
 * anybody reads, and the count is the useful part by then.
 */
export async function peekVolume(name: string, path = ""): Promise<PeekResult> {
  if (!ID_RE.test(name)) return { ok: false, error: "invalid volume name" };
  // A path inside the volume, from the UI's own breadcrumbs. Anything with a
  // quote, a backtick or a traversal in it is refused rather than escaped:
  // there is no legitimate reason for one and it would be going into a shell.
  if (path && (!/^[\w.\-/ ]+$/.test(path) || path.includes(".."))) return { ok: false, error: "invalid path" };

  const image = await peekImage();
  if (!image) {
    return {
      ok: false,
      error: "no helper image (busybox or alpine) is available locally to look inside with — nothing else is run in its place",
      hint: `docker pull alpine && docker run --rm -v ${name}:/v:ro alpine ls -la /v`,
    };
  }

  const inside = `/v${path ? `/${path.replace(/^\/+/, "")}` : ""}`;
  // NOT `ls -l`. Measured against the image this actually picks: alpine ships
  // busybox, busybox's `ls` has no `--time-style`, and its default columns
  // differ from coreutils' — so the listing that parsed on the machine it was
  // written on would have failed on almost every real one. `find` + `stat -c`
  // exists in both with the same flags and prints a format nobody has to guess:
  //
  //     directory|4096|1767880226|/v/keypad
  const r = await run([
    "run", "--rm", "--network", "none", "-v", `${name}:/v:ro`, image,
    "sh", "-c", `find "${inside}" -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} \\; 2>/dev/null | head -400`,
  ], 20_000);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim().split("\n")[0] || "could not read the volume", image };
  return { ok: true, image, entries: parseStat(r.stdout) };
}

/**
 * `stat -c '%F|%s|%Y|%n'`, read.
 *
 * One line per entry, four fields, no column alignment to guess at and no
 * locale in the date. The alternative — parsing `ls -l` — needs a different
 * regex for busybox and coreutils and gets the year wrong on files older than
 * six months, which is most of what is in a volume.
 */
export function parseStat(text: string): PeekEntry[] {
  const out: PeekEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("|");
    if (parts.length < 4) continue;
    const [kind, size, mtime] = parts;
    // The path may contain a `|` — everything after the third field is the name.
    const full = parts.slice(3).join("|");
    const name = full.split("/").filter(Boolean).pop() ?? full;
    const dir = /directory/i.test(kind ?? "");
    const when = Number(mtime);
    out.push({
      name,
      dir,
      bytes: dir ? null : Number(size) || 0,
      // ISO to the minute, in UTC: a listing is compared against other
      // listings, and a local-time string from inside a container is a
      // different clock wearing the same shirt.
      when: Number.isFinite(when) && when > 0 ? new Date(when * 1000).toISOString().slice(0, 16).replace("T", " ") : "",
    });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}
