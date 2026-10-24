// Guided disk cleanup: what is eating the disk, whether it is safe to remove,
// and the one narrow door that removes it.
//
// Measured, on one laptop with 5 GB free of 224: the first answer was "almost
// all of it is Docker", and round one removed 173 GB of images and build cache
// while the full disk gained 3.2 GB. Docker lived on a SECOND disk. So every
// line here carries the mount it lives on (df of the path, Docker's root dir
// included) and the report carries the free space of each mount: the person
// sees which disk is the full one before anything is offered.
//
// Three halves, like orphans.ts. The classifiers are pure (facts in, verdict
// and plain-words reason out), so every rule is a table row in a test. The
// scanner is the I/O, every external program through an injected `Runner`, so a
// test puts fake docker/git/gh/df/du on PATH and asserts the shim ran. The
// deleter takes a TARGET the scan produced and refuses everything else.
//
// Cost, stated because the repo counts: nothing here runs on a poll. A scan is
// one `docker system df`, `ps`, `images` and `inspect` (the last for every
// container, to read --rm, exit code and image), one git worktree list and one `gh pr
// list` per repo, about four git calls per worktree, and `du` in batches of 20
// paths; it is cached for five minutes and `?fresh=1` may not rescan faster than
// every 30 s. A clean reuses a scan younger than that instead of making a second.
//
// WHAT IT CANNOT DO, on purpose: it never removes a Docker volume, a
// worktree that is not merged and clean, anything under ~/.claude, or anything
// that needs root (it says "needs sudo" and stops). An `ask` line is shown and
// has no target: this build has no confirm-per-line flow to hang one on.
//
// Docker containers are removed by the ids the scan showed (`docker rm <ids>`,
// each re-checked just before), never by a prune, and only when started with
// --rm: exit 0 alone is also how a shell you left or a database you stopped ends.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parseWorktreeList, worktreeLeftovers } from "./gitwork.ts";
import type {
  DiskCleanKind, DiskCleanLine, DiskCleanLineResult, DiskCleanMount, DiskCleanReport, DiskCleanRunResult, DiskCleanTarget, DiskCleanVerdict,
} from "../../shared/types.ts";

// ------------------------------------------------------------------ I/O ----

export interface RunOut { code: number; stdout: string; stderr: string; missing?: boolean }
export type Runner = (cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }) => Promise<RunOut>;

/** The real runner. `Bun.which` first, so a program that is not installed is
 *  `missing` rather than a thrown ENOENT; bounded by a timeout on every call. */
export const spawnRunner: Runner = async (cmd, args, o = {}) => {
  if (!Bun.which(cmd)) return { code: 127, stdout: "", stderr: `${cmd}: not found`, missing: true };
  try {
    const p = Bun.spawn([cmd, ...args], {
      cwd: o.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeoutMs ?? 20_000, killSignal: "SIGKILL",
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  } catch (e) { return { code: 1, stdout: "", stderr: String(e) }; }
};

export interface DiskCtx {
  home: string;
  now: number;
  run: Runner;
  /** Main checkouts whose worktrees are looked at, besides the git repos found directly under ~/code. */
  repos?: string[];
  /** Session ids known to be running, besides the ones `ps` and tmux name. */
  liveSessions?: () => Promise<Set<string>>;
  /** /proc/swaps and the snapshots directory, injected so a test does not read the machine's. */
  swaps?: () => string;
  snapshotsDir?: string;
  /** The tmux servers besides the default one (`-S <path>` pairs), injected by the server that knows its sockets. */
  tmuxSockets?: () => string[][];
  /** Where processes' cwd links are read; /proc unless a test says otherwise. */
  procDir?: string;
  /** The ignored files a removal of a checkout would delete; gitwork's worktreeLeftovers unless a test says otherwise. */
  leftovers?: (repo: string, path: string) => Promise<{ names: string[]; more: number; error?: string }>;
}

export function defaultDiskCtx(over: Partial<DiskCtx> = {}): DiskCtx {
  return { home: homedir(), now: Date.now(), run: spawnRunner, ...over };
}

// ----------------------------------------------------------- constants ----

const MB = 1024 * 1024;
/** Below this a line is noise: a hundred 40 KB scratch folders are not a decision. */
export const MIN_LINE_BYTES = MB;
/** A Claude temp folder younger than this may belong to a session that is about to resume. */
export const CLAUDE_TEMP_MIN_AGE_MS = 24 * 3600_000;
export const SCAN_TTL_MS = 5 * 60_000;
export const SCAN_MIN_RESCAN_MS = 30_000;
/** Pull requests asked for per repository in one call. */
const PR_BATCH = 200;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const UUID_DIR = new RegExp(`^${UUID.source}$`);

/** Caches that come back by themselves. Each is also an allowed deletion root. */
export const PACKAGE_CACHES: { id: string; rel: string; label: string }[] = [
  { id: "uv", rel: ".cache/uv", label: "uv (Python) download cache" },
  { id: "pnpm", rel: ".local/share/pnpm/store", label: "pnpm package store" },
  { id: "npm", rel: ".npm/_cacache", label: "npm download cache" },
  { id: "pip", rel: ".cache/pip", label: "pip download cache" },
  { id: "go-build", rel: ".cache/go-build", label: "Go build cache" },
  { id: "node-compile", rel: ".cache/node-compile-cache", label: "Node compile cache" },
  { id: "debuginfod", rel: ".cache/debuginfod_client", label: "debugger symbol downloads" },
  { id: "bun", rel: ".bun/install/cache", label: "Bun package cache" },
  // Never the folder above these two: it is HF_HOME, and holds the login token, the stored tokens and accelerate's config.
  { id: "huggingface-hub", rel: ".cache/huggingface/hub", label: "Hugging Face model downloads" },
  { id: "huggingface-xet", rel: ".cache/huggingface/xet", label: "Hugging Face chunk cache" },
];
const CLAUDE_TEMP_REL = ".cache/claude-tmp";
const TRASH_REL = ".local/share/Trash/files";
/** Beside Trash/files: one .trashinfo per file in it. Emptying only the files leaves entries a file manager lists as ghosts. */
const TRASH_INFO_REL = ".local/share/Trash/info";

/** The directories a deletion may live in, absolute, with whether the directory
 *  itself may be emptied (it is recreated) or only things inside it. */
export function allowedFsRoots(home: string): Map<string, boolean> {
  const m = new Map<string, boolean>();
  m.set(join(home, CLAUDE_TEMP_REL), false);
  m.set(join(home, TRASH_REL), true);
  m.set(join(home, TRASH_INFO_REL), true);
  for (const c of PACKAGE_CACHES) m.set(join(home, c.rel), true);
  return m;
}

/** Shown, never deletable. Only listed when present and big enough to matter. */
const EXPLAIN: { id: string; kind: DiskCleanKind; rel: string; label: string; why: string }[] = [
  { id: "logins-browser", kind: "logins", rel: ".config/agentglass-electron/Partitions", label: "agentglass browser sign-ins and site data",
    why: "Holds the sites you are signed in to. Deleting it signs you out everywhere, so it is yours to decide." },
  { id: "logins-zen", kind: "logins", rel: ".config/zen", label: "Zen browser profile",
    why: "Your browser profile: bookmarks, sign-ins, history. Not something to clean from here." },
  { id: "logins-firefox", kind: "logins", rel: ".mozilla", label: "Firefox profile",
    why: "Your browser profile: bookmarks, sign-ins, history. Not something to clean from here." },
  { id: "mise", kind: "toolchain", rel: ".local/share/mise", label: "mise toolchains (language versions)",
    why: "Installed versions of node, python and the like. Removing one can break a project that pins it; `mise prune` drops only the ones nothing uses." },
  { id: "tracker3-cache", kind: "tracker", rel: ".cache/tracker3", label: "Desktop file indexer (cache)",
    why: "The desktop search index. It rebuilds itself, but it is in use while the indexer runs." },
  { id: "tracker3-data", kind: "tracker", rel: ".local/share/tracker", label: "Desktop file indexer (data)",
    why: "The desktop search index. It rebuilds itself, but it is in use while the indexer runs." },
  { id: "claude-memory", kind: "memory", rel: ".claude", label: "Claude memory and conversation history",
    why: "Everything Claude remembers about your projects. agentglass never touches it." },
];

// -------------------------------------------------------------- parsing ----

const UNIT: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

/** "109.5GB", "4.096kB", "59.37GB (54%)" -> bytes; Docker prints SI units. */
export function parseDockerSize(s: unknown): number {
  const m = /^\s*([\d.]+)\s*([kKMGTP]?B)/.exec(String(s ?? ""));
  if (!m) return 0;
  return Math.round(Number(m[1]) * (UNIT[m[2]!.toUpperCase()] ?? 1));
}

export interface DockerDfRow { total: number; active: number; size: number; reclaimable: number }
/** `docker system df --format '{{json .}}'`: one JSON object per line, one per Type. */
export function parseDockerDf(stdout: string): Record<string, DockerDfRow> {
  const out: Record<string, DockerDfRow> = {};
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      out[String(j.Type)] = { total: Number(j.TotalCount) || 0, active: Number(j.Active) || 0, size: parseDockerSize(j.Size), reclaimable: parseDockerSize(j.Reclaimable) };
    } catch { /* a line that is not ours */ }
  }
  return out;
}

export interface DockerPs {
  running: number; stopped: number;
  /** Stopped containers that belong to a compose project (stopping a database or service exits 0 too), and the projects. */
  stoppedServices: number; stoppedProjects: string[];
  projects: string[];
  /** Every container's id, for the one `docker inspect` that follows. */
  ids: string[];
  /** Stopped, exit 0, no compose label. Exit 0 proves nothing: a shell you left or a database you stopped ends that way too. */
  exitedClean: { id: string; name: string }[];
  /** The ids (full, from inspect) of the stopped containers that are provably runs that remove themselves. Filled by the scan, not by parseDockerPs. */
  selfRemoving: string[];
}
/** `docker ps -a --format '{{json .}}'`, reduced to what the verdicts need. */
export function parseDockerPs(stdout: string): DockerPs {
  const r: DockerPs = { running: 0, stopped: 0, stoppedServices: 0, stoppedProjects: [], projects: [], ids: [], exitedClean: [], selfRemoving: [] };
  const projects = new Set<string>(), stoppedProjects = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const p = /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(String(j.Labels ?? ""));
      const id = CONTAINER_ID.test(String(j.ID ?? "")) ? String(j.ID) : "";
      if (id) r.ids.push(id);
      if (p) projects.add(p[1]!);
      if (j.State === "running" || j.State === "restarting" || j.State === "paused") r.running++;
      else {
        r.stopped++;
        if (p) { r.stoppedServices++; stoppedProjects.add(p[1]!); }
        else if (String(j.Status ?? "").startsWith("Exited (0)")) r.exitedClean.push({ id, name: String(j.Names ?? "") || id.slice(0, 12) });
      }
    } catch { /* a line that is not ours */ }
  }
  r.projects = [...projects].sort();
  r.stoppedProjects = [...stoppedProjects].sort();
  return r;
}

/** A container id as docker prints it: hex only, so it can never be read as a flag. */
export const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
/** One line per container: id, image id, running, exit code, --rm, compose project. */
export const INSPECT_FORMAT = '{{.Id}} {{.Image}} {{.State.Running}} {{.State.ExitCode}} {{.HostConfig.AutoRemove}} {{index .Config.Labels "com.docker.compose.project"}}';
export interface InspectRow { id: string; image: string; running: boolean; exit: number; autoRemove: boolean; compose: string }
export function parseInspect(stdout: string): InspectRow[] {
  const out: InspectRow[] = [];
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(" ");
    if (f.length >= 5 && CONTAINER_ID.test(f[0]!)) out.push({ id: f[0]!, image: (f[1] ?? "").replace(/^sha256:/, ""), running: f[2] === "true", exit: Number(f[3]), autoRemove: f[4] === "true", compose: f[5] ?? "" });
  }
  return out;
}
/** The one signal that a stopped container is disposable: it was started with --rm, finished with 0 and belongs to no compose project. */
export const selfRemoves = (r: InspectRow): boolean => !r.running && r.exit === 0 && r.autoRemove && !r.compose;

export interface DockerImage { id: string; name: string; hasDigest: boolean }
/** `docker images --digests --format '{{json .}}'`. */
export function parseDockerImages(stdout: string): DockerImage[] {
  const out: DockerImage[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const repo = String(j.Repository ?? ""), tag = String(j.Tag ?? ""), id = String(j.ID ?? "").replace(/^sha256:/, "");
      if (id) out.push({ id, name: repo && repo !== "<none>" ? `${repo}${tag && tag !== "<none>" ? `:${tag}` : ""}` : id.slice(0, 12), hasDigest: !!j.Digest && j.Digest !== "<none>" });
    } catch { /* a line that is not ours */ }
  }
  return out;
}
/** Images no container uses that exist nowhere else: built here, `docker load`ed or `docker commit`ted. Pruning them is not undoable. */
export function localOnlyImages(images: DockerImage[], containerImageIds: Iterable<string>): string[] {
  const used = [...containerImageIds];
  return images.filter((i) => !i.hasDigest && !used.some((u) => u.startsWith(i.id) || i.id.startsWith(u))).map((i) => i.name);
}

/** `df -P -B1 <path>`: the disk the path lives on. */
export function parseDf(stdout: string): { source: string; size: number; free: number; mount: string } | null {
  const row = stdout.trim().split("\n").slice(1).pop() ?? "";
  const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(row);
  return m ? { source: m[1]!, size: Number(m[2]), free: Number(m[4]), mount: m[5]! } : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const span = (ms: number) => ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86400_000 ? `${Math.floor(ms / 3600_000)} h` : `${Math.floor(ms / 86400_000)} days`;

// ---------------------------------------------------------- classifiers ----

export interface Verdict { verdict: DiskCleanVerdict; why: string }

export interface WorktreeFacts {
  branch: string;
  head: string;
  locked: boolean;
  /** Files git reports as changed or untracked; null: git could not say. */
  dirty: number | null;
  /** Commits on no remote branch; null: git could not say. */
  unpushed: number | null;
  /** The pull request that came from the branch. null: none. */
  pr: { number: number; state: "OPEN" | "MERGED" | "CLOSED"; headSha: string } | null;
  /** false: GitHub could not be asked, which is not the same as "no pull request". */
  prKnown: boolean;
  /** Something runs inside the checkout right now: a terminal pane or a process whose cwd is in it. */
  busy: boolean;
  /** Ignored files git never lists and `worktree remove` deletes without a word. null: not looked at. */
  leftovers: { names: string[]; more: number; error?: string } | null;
}

/**
 * Safe only when the pull request is MERGED or CLOSED, nothing is uncommitted,
 * and nothing exists only here. A pull request whose head commit IS this
 * checkout's HEAD has already pushed everything, which matters because GitHub
 * deletes the branch after a merge and `--not --remotes` then counts the
 * commits as unpushed.
 */
export function classifyWorktree(f: WorktreeFacts): Verdict {
  if (f.locked) return { verdict: "inuse", why: "Git has this checkout locked, which means something is using it." };
  if (f.busy) return { verdict: "inuse", why: "A terminal or a program is running inside this checkout right now (often an agent that just finished its pull request)." };
  if (f.dirty === null || f.unpushed === null) return { verdict: "ask", why: "Git could not read this checkout, so it is kept until you look." };
  if (f.pr?.state === "OPEN") return { verdict: "inuse", why: `Pull request #${f.pr.number} is still open.` };
  if (f.dirty > 0) return { verdict: "ask", why: `${plural(f.dirty, "file")} with changes that are not committed.` };
  if (!f.prKnown) return { verdict: "ask", why: "GitHub could not be asked whether its pull request is finished." };
  if (!f.pr) return { verdict: "ask", why: `No pull request was found for ${f.branch === "(detached)" ? "this checkout" : `branch ${f.branch}`}.` };
  const unpushed = f.pr.headSha && f.pr.headSha === f.head ? 0 : f.unpushed;
  if (unpushed > 0) return { verdict: "ask", why: `${plural(unpushed, "commit")} exist only on this machine.` };
  // Measured: `git worktree remove` deletes a gitignored `.env` or a page of local notes with exit 0 and no warning.
  if (!f.leftovers) return { verdict: "ask", why: "The files git ignores in this checkout were not looked at, so it is kept until you look." };
  if (f.leftovers.error) return { verdict: "ask", why: "The files git ignores in this checkout could not be listed, so it is kept until you look." };
  if (f.leftovers.names.length) {
    const shown = f.leftovers.names.slice(0, 3).join(", "), rest = f.leftovers.names.length - 3 + f.leftovers.more;
    return { verdict: "ask", why: `Removing it would also delete files git ignores and no other copy has: ${shown}${rest > 0 ? ` and ${rest} more` : ""}.` };
  }
  return { verdict: "safe", why: `Pull request #${f.pr.number} is ${f.pr.state.toLowerCase()}, nothing is uncommitted and nothing is unpushed. The branch stays in the repository.` };
}

/** Session scratch folders: removable only when old AND no running session names it. */
export function classifyClaudeTemp(f: { ageMs: number; live: boolean }): Verdict {
  if (f.live) return { verdict: "inuse", why: "A Claude session that is running right now uses this folder." };
  if (f.ageMs < CLAUDE_TEMP_MIN_AGE_MS) return { verdict: "ask", why: `Touched ${span(f.ageMs)} ago. No session is running in it, but one may resume; it is cleanable after 24 hours.` };
  return { verdict: "safe", why: `Scratch files of a Claude session that ended ${span(f.ageMs)} ago. The session's memory and history live elsewhere and are not touched.` };
}

export type LineDraft = Omit<DiskCleanLine, "mount">;

function stoppedWhy(ps: DockerPs): string {
  const failed = ps.stopped - ps.exitedClean.length - ps.stoppedServices;
  const names = ps.exitedClean.map((c) => c.name);
  return [
    `${plural(ps.stopped, "container")} stopped.`,
    names.length ? `${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""} exited with 0, which is also how a shell you left or a database you stopped ends, and removing one drops what it kept outside a volume.` : "",
    ps.stoppedServices ? `${ps.stoppedServices} belong to compose project ${ps.stoppedProjects.join(", ")}: a database or service that was stopped also exits 0, and removing it drops what it kept outside a volume.` : "",
    failed ? `${failed} ended with an error; their logs may be what you need.` : "",
    "Look first.",
  ].filter(Boolean).join(" ");
}

/** Docker's four numbers become lines. Volumes are never deletable. */
export function classifyDocker(df: Record<string, DockerDfRow>, ps: DockerPs, localOnly: string[] | null = []): LineDraft[] {
  const out: LineDraft[] = [];
  const put = (d: LineDraft) => { if (d.bytes === null || d.bytes > 0 || d.kind === "docker-containers") out.push(d); };
  const dk = (what: "images" | "cache"): DiskCleanTarget => ({ via: "docker", what });

  const img = df.Images;
  if (img) {
    const unused = `${plural(Math.max(0, img.total - img.active), "image")} are not used by any container, running or stopped.`;
    const kept = localOnly === null
      ? "Docker would not list them, so there is no telling which exist nowhere else; kept until you look."
      : `${plural(localOnly.length, "image")} exist only on this machine (${localOnly.slice(0, 3).join(", ")}${localOnly.length > 3 ? ` and ${localOnly.length - 3} more` : ""}): built here, loaded from a file or made with docker commit. Removing them is permanent, so none is removed from here.`;
    const hold = localOnly === null || localOnly.length > 0;
    put({ id: "docker:images", kind: "docker-images", label: "Docker images no container uses", bytes: img.reclaimable, verdict: hold ? "ask" : "safe", target: hold ? null : dk("images"),
      why: hold ? `${unused} ${kept}` : `${unused} They download or rebuild when needed.` });
    put({ id: "docker:images-used", kind: "docker-images", label: "Docker images in use", bytes: Math.max(0, img.size - img.reclaimable), verdict: "inuse", target: null,
      why: `${plural(img.active, "image")} belong to containers (${ps.running} running), so they stay.` });
  }
  const bc = df["Build Cache"];
  if (bc) {
    put({ id: "docker:cache", kind: "docker-cache", label: "Docker build cache", bytes: bc.reclaimable, verdict: "safe", target: dk("cache"),
      why: "Layers kept from earlier builds. The next build recreates what it needs, a little slower." });
    put({ id: "docker:cache-used", kind: "docker-cache", label: "Docker build cache in use", bytes: Math.max(0, bc.size - bc.reclaimable), verdict: "inuse", target: null,
      why: "Docker counts this part as still in use (layers that images share, or a build in progress), so it stays." });
  }
  const ct = df.Containers;
  if (ct && ps.stopped > 0) {
    // Safe only when EVERY stopped container is provably a run that removes itself (--rm); anything else is a person's to look at.
    const clean = ps.selfRemoving.length === ps.stopped;
    put({ id: "docker:containers", kind: "docker-containers", label: clean ? "Docker containers that finished" : "Docker containers that stopped", bytes: ct.reclaimable,
      verdict: clean ? "safe" : "ask", target: clean ? { via: "docker", what: "containers", ids: ps.selfRemoving } : null,
      why: clean
        ? `${plural(ps.stopped, "container")} were started to remove themselves (docker run --rm) and finished with exit 0. Only these are removed; their images and volumes are not touched.`
        : stoppedWhy(ps) });
  }
  if (ct && ps.running > 0) {
    put({ id: "docker:containers-running", kind: "docker-containers", label: "Docker containers running", bytes: Math.max(0, ct.size - ct.reclaimable), verdict: "inuse", target: null,
      why: `${plural(ps.running, "container")} running right now.` });
  }
  const vol = df["Local Volumes"];
  if (vol) {
    const of = ps.projects.length ? ` Projects with containers: ${ps.projects.join(", ")}.` : "";
    put({ id: "docker:volumes-used", kind: "docker-volumes", label: "Docker volumes in use", bytes: Math.max(0, vol.size - vol.reclaimable), verdict: "inuse", target: null,
      why: `${plural(vol.active, "volume")} are attached to containers; this is where databases live.${of}` });
    put({ id: "docker:volumes-spare", kind: "docker-volumes", label: "Docker volumes no container uses", bytes: vol.reclaimable, verdict: "explain", target: null,
      why: "Not attached right now, but one may be a database you still want. agentglass never deletes Docker volumes; remove one yourself if you know it is spare." });
  }
  return out;
}

// -------------------------------------------------------------- scanner ----

/** Run `fn` over `items`, `n` at a time, keeping order. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = Array.from<R>({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

interface Scan { ctx: DiskCtx; mounts: Map<string, DiskCleanMount>; mountOf: Map<string, string>; problems: string[] }

/** The disk a path lives on, via df of its nearest existing ancestor. */
async function mountFor(sc: Scan, path: string): Promise<string> {
  let p = path;
  while (p !== "/" && !existsSync(p)) p = dirname(p);
  const hit = sc.mountOf.get(p);
  if (hit) return hit;
  const r = await sc.ctx.run("df", ["-P", "-B1", p], { timeoutMs: 10_000 });
  const d = parseDf(r.stdout);
  const mount = d?.mount ?? "/";
  if (d && !sc.mounts.has(mount)) sc.mounts.set(mount, { mount, source: d.source, size: d.size, free: d.free, safeBytes: 0 });
  sc.mountOf.set(p, mount);
  return mount;
}

/** Bytes per path, `du` 20 paths at a time. A path du could not read is absent. */
async function sizesOf(sc: Scan, paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += 20) batches.push(paths.slice(i, i + 20));
  await pool(batches, 3, async (b) => {
    // Output kept whatever the exit code: du exits 1 on one unreadable file and still sizes the rest.
    const r = await sc.ctx.run("du", ["-sb", ...b], { timeoutMs: 60_000 });
    for (const line of r.stdout.split("\n")) {
      const m = /^(\d+)\t(.+)$/.exec(line);
      if (m) sizes.set(m[2]!, Number(m[1]));
    }
  });
  return sizes;
}

async function liveSessionIds(ctx: DiskCtx): Promise<Set<string>> {
  const socks: string[][] = [[], ...(ctx.tmuxSockets?.() ?? [])];
  const [ps, extra, ...tmux] = await Promise.all([
    ctx.run("ps", ["-eo", "args="], { timeoutMs: 10_000 }),
    ctx.liveSessions ? ctx.liveSessions().catch(() => new Set<string>()) : Promise.resolve(new Set<string>()),
    ...socks.map((sk) => ctx.run("tmux", [...sk, "list-panes", "-a", "-F", "#{pane_current_path} #{pane_start_command}"], { timeoutMs: 5_000 })),
  ]);
  const ids = new Set<string>(extra);
  for (const t of [ps.stdout, ...tmux.map((r) => r.stdout)]) for (const m of t.matchAll(UUID)) ids.add(m[0]);
  return ids;
}

/** Directories something runs in right now: every tmux pane on the default server and on each known socket, and every process's cwd; with `fds`, the files every process holds open too. */
async function busyDirs(ctx: DiskCtx, fds = false): Promise<string[]> {
  const socks: string[][] = [[], ...(ctx.tmuxSockets?.() ?? [])];
  const panes = await Promise.all(socks.map((s) => ctx.run("tmux", [...s, "list-panes", "-a", "-F", "#{pane_current_path}"], { timeoutMs: 5_000 })));
  const dirs = panes.flatMap((r) => (r.code === 0 ? r.stdout.split("\n").filter((l) => l.startsWith("/")) : []));
  const proc = ctx.procDir ?? "/proc";
  let pids: string[] = [];
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { /* no /proc here */ }
  for (const pid of pids) {
    try { dirs.push(readlinkSync(join(proc, pid, "cwd"))); } catch { /* gone, or not ours to read */ }
    if (!fds) continue;
    try { for (const fd of readdirSync(join(proc, pid, "fd"))) { try { dirs.push(readlinkSync(join(proc, pid, "fd", fd))); } catch { /* closed meanwhile */ } } } catch { /* not ours to read */ }
  }
  return dirs;
}

/** Is any of `dirs` the checkout or a folder inside it? Both spellings of the checkout, since a link may name it. */
function anyInside(dirs: string[], checkout: string): boolean {
  const spell = new Set([checkout]);
  try { spell.add(realpathSync(checkout)); } catch { /* gone */ }
  return dirs.some((d) => [...spell].some((c) => d === c || d.startsWith(`${c}/`)));
}

/** Names of the ignored files a removal would delete, as the classifier wants them. */
async function leftoversOf(ctx: DiskCtx, repo: string, path: string) {
  if (ctx.leftovers) return ctx.leftovers(repo, path);
  const l = await worktreeLeftovers(repo, path);
  return { names: l.entries.map((e) => e.path), more: l.more, ...(l.error ? { error: l.error } : {}) };
}

/** Newest write anywhere in the first three levels of a folder: a running session keeps touching files deep inside its scratchpad while the top levels stay old. */
function newestWrite(dir: string, now: number): number {
  let t = 0, seen = 0;
  const walk = (d: string, depth: number): boolean => {
    let st;
    try { st = lstatSync(d); } catch { return true; }
    t = Math.max(t, st.mtimeMs);
    if (depth >= 3 || !st.isDirectory()) return true;
    let kids: string[] = [];
    try { kids = readdirSync(d); } catch { return true; }
    for (const k of kids) {
      // shortcut: a folder with more than NEWEST_WRITE_CAP entries in its top levels counts as just written, so it asks instead of being removed unread.
      if (seen++ >= NEWEST_WRITE_CAP) { t = now; return false; }
      if (!walk(join(d, k), depth + 1)) return false;
    }
    return true;
  };
  walk(dir, 0);
  return t;
}
const NEWEST_WRITE_CAP = 2000;

/**
 * The session folders under claude-tmp. Measured layout: claude-tmp/claude-<uid>/<project>/<uuid>;
 * the older one, claude-tmp/<project>/<uuid>, is read too. Links are not followed.
 */
function claudeSessionDirs(root: string): { path: string; rel: string; id: string }[] {
  const out: { path: string; rel: string; id: string }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let kids: string[] = [];
    try { kids = readdirSync(dir); } catch { return; }
    for (const k of kids) {
      const path = join(dir, k);
      try { if (!lstatSync(path).isDirectory()) continue; } catch { continue; }
      if (UUID_DIR.test(k)) { if (depth > 0) out.push({ path, rel: `${rel}/${k}`, id: k }); }
      else if (depth < 2) walk(path, rel ? `${rel}/${k}` : k, depth + 1);
    }
  };
  walk(root, "", 0);
  return out;
}

async function scanClaudeTemp(sc: Scan): Promise<LineDraftAt[]> {
  const root = join(sc.ctx.home, CLAUDE_TEMP_REL);
  const found = claudeSessionDirs(root);
  if (!found.length) return [];
  // A session started without its id on the command line, idle for a day, is still named by what its processes have open.
  const [sizes, live, busy] = await Promise.all([sizesOf(sc, found.map((f) => f.path)), liveSessionIds(sc.ctx), busyDirs(sc.ctx, true)]);
  const out: LineDraftAt[] = [];
  for (const f of found) {
    const bytes = sizes.get(f.path) ?? 0;
    if (bytes < MIN_LINE_BYTES) continue;
    const v = classifyClaudeTemp({ ageMs: Math.max(0, sc.ctx.now - newestWrite(f.path, sc.ctx.now)), live: live.has(f.id) || anyInside(busy, f.path) });
    out.push({
      id: `claude-temp:${f.rel}`, kind: "claude-temp", label: `Claude session scratch ${f.id.slice(0, 8)}`, bytes, ...v,
      target: v.verdict === "safe" ? { via: "fs", root, path: f.path } : null, at: f.path,
    });
  }
  return out;
}

async function scanFsSimple(sc: Scan): Promise<LineDraftAt[]> {
  const { home } = sc.ctx;
  const items: { id: string; kind: DiskCleanKind; path: string; label: string; verdict: DiskCleanVerdict; why: string; deletable: boolean }[] = [];
  for (const c of PACKAGE_CACHES) {
    items.push({ id: `cache:${c.id}`, kind: "package-cache", path: join(home, c.rel), label: c.label, verdict: "safe", deletable: true,
      why: "A download cache. It refills the next time a tool needs something, which costs bandwidth, not data." });
  }
  items.push({ id: "trash", kind: "trash", path: join(home, TRASH_REL), label: "Trash", verdict: "safe", deletable: true,
    why: "Files you already deleted and have not emptied. Cleaning makes them gone for good." });
  for (const e of EXPLAIN) items.push({ id: e.id, kind: e.kind, path: join(home, e.rel), label: e.label, verdict: "explain", why: e.why, deletable: false });
  const present = items.filter((i) => existsSync(i.path));
  const sizes = await sizesOf(sc, present.map((i) => i.path));
  const roots = allowedFsRoots(home);
  const out: LineDraftAt[] = [];
  for (const i of present) {
    const bytes = sizes.get(i.path) ?? 0;
    if (bytes < MIN_LINE_BYTES) continue;
    out.push({ id: i.id, kind: i.kind, label: i.label, bytes, verdict: i.verdict, why: i.why, at: i.path,
      target: i.deletable && roots.has(i.path) ? { via: "fs", root: i.path, path: i.path } : null });
  }
  return out;
}

/** Swap files and btrfs snapshots: cheap to notice, shown only so the numbers add up. */
async function scanSystem(sc: Scan): Promise<LineDraftAt[]> {
  const out: LineDraftAt[] = [];
  let swaps = "";
  try { swaps = sc.ctx.swaps ? sc.ctx.swaps() : readFileSync("/proc/swaps", "utf8"); } catch { /* not Linux */ }
  for (const line of swaps.split("\n").slice(1)) {
    const m = /^(\S+)\s+file\s+(\d+)\s/.exec(line);
    if (m && Number(m[2]) * 1024 >= MIN_LINE_BYTES) {
      out.push({ id: `swap:${m[1]}`, kind: "swapfile", label: "Swap file", bytes: Number(m[2]) * 1024, verdict: "explain", target: null, at: m[1]!,
        why: "Space the system reserves for memory overflow and hibernation. Removing it can break suspend and hibernate; do it yourself from a terminal if you are sure." });
    }
  }
  const snaps = sc.ctx.snapshotsDir ?? "/.snapshots";
  if (existsSync(snaps)) {
    out.push({ id: "snapshots", kind: "snapshots", label: "System snapshots (btrfs)", bytes: null, verdict: "explain", target: null, at: snaps,
      why: "Old copies of the system disk kept by snapper or Timeshift. They can hold a lot without showing up in du, and measuring them needs root: `sudo snapper list`." });
  }
  return out;
}

async function scanWorktrees(sc: Scan): Promise<LineDraftAt[]> {
  const { home } = sc.ctx;
  const code = join(home, "code");
  const repos = new Set(sc.ctx.repos ?? []);
  try {
    for (const d of readdirSync(code)) { try { if (lstatSync(join(code, d, ".git")).isDirectory()) repos.add(join(code, d)); } catch { /* not a repo */ } }
  } catch { /* no ~/code */ }
  const seen = new Set<string>();
  const cands: { repo: string; path: string; branch: string; head: string; locked: boolean }[] = [];
  let gitMissing = false;
  await pool([...repos], 4, async (repo) => {
    const r = await sc.ctx.run("git", ["-C", repo, "worktree", "list", "--porcelain"], { timeoutMs: 15_000 });
    if (r.missing) { gitMissing = true; return; }
    if (r.code !== 0) return;
    const list = parseWorktreeList(r.stdout, repo);
    // The first entry is the main checkout; two repos given as one repo and its worktree list the same set.
    for (const w of list.slice(1)) {
      if (w.bare || w.prunable || seen.has(w.path) || !w.path.startsWith(`${code}/`) || !existsSync(w.path)) continue;
      seen.add(w.path);
      cands.push({ repo: list[0]!.path, path: w.path, branch: w.branch, head: w.head, locked: w.locked });
    }
  });
  if (gitMissing) sc.problems.push("git is not installed, so worktrees were not checked.");
  if (!cands.length) return [];
  const [sizes, busy] = await Promise.all([sizesOf(sc, cands.map((c) => c.path)), busyDirs(sc.ctx)]);
  let ghFailed = false;
  // One `gh pr list` per repository, not per checkout: 30 checkouts of a repo were 30 GitHub calls a scan.
  const ghRows = async (cwd: string, extra: string[]): Promise<Record<string, unknown>[] | null> => {
    const r = await sc.ctx.run("gh", ["pr", "list", ...extra, "--state", "all", "--json", "number,state,headRefOid,headRefName,isCrossRepository,updatedAt"], { cwd, timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    try { const j = JSON.parse(r.stdout); return Array.isArray(j) ? j : null; } catch { return null; }
  };
  const batches = new Map<string, Promise<Record<string, unknown>[] | null>>();
  const batchOf = (repo: string) => batches.get(repo) ?? (batches.set(repo, ghRows(repo, ["--limit", String(PR_BATCH)])), batches.get(repo)!);
  const out = await pool(cands, 4, async (c): Promise<LineDraftAt> => {
    const g = (args: string[]) => sc.ctx.run("git", ["-C", c.path, ...args], { timeoutMs: 20_000 });
    const [st, up, head] = await Promise.all([g(["status", "--porcelain"]), g(["rev-list", "--count", "HEAD", "--not", "--remotes"]), g(["rev-parse", "HEAD"])]);
    const detached = c.branch === "(detached)";
    let pr: WorktreeFacts["pr"] = null, prKnown = true;
    if (!detached) {
      let rows = await batchOf(c.repo);
      // A repository with more pull requests than the batch holds may have this branch's only beyond it: ask for the branch alone.
      if (rows && rows.length >= PR_BATCH && !rows.some((x) => x.headRefName === c.branch)) rows = await ghRows(c.path, ["--head", c.branch, "--limit", "5"]);
      if (!rows) { prKnown = false; ghFailed = true; }
      else {
        const mine = rows.filter((x) => x.isCrossRepository !== true && x.headRefName === c.branch)
          .sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || String(b.updatedAt).localeCompare(String(a.updatedAt)));
        const best = mine[0];
        if (best) pr = { number: Number(best.number), state: best.state === "MERGED" || best.state === "CLOSED" ? best.state : "OPEN", headSha: String(best.headRefOid ?? "") };
      }
    }
    const isBusy = anyInside(busy, c.path);
    const v = classifyWorktree({
      branch: c.branch, head: head.stdout.trim(), locked: c.locked,
      dirty: st.code === 0 ? st.stdout.split("\n").filter(Boolean).length : null,
      unpushed: up.code === 0 ? Number(up.stdout.trim()) || 0 : null,
      pr, prKnown, busy: isBusy,
      leftovers: c.locked || isBusy ? null : await leftoversOf(sc.ctx, c.repo, c.path),
    });
    return {
      id: `worktree:${c.path}`, kind: "worktree", label: `Checkout ${basename(c.path)}${detached ? "" : ` (${c.branch})`}`, bytes: sizes.get(c.path) ?? 0, ...v,
      target: v.verdict === "safe" ? { via: "worktree", repo: c.repo, path: c.path } : null, at: c.path,
    };
  });
  if (ghFailed) sc.problems.push("GitHub did not answer (gh missing or signed out), so some checkouts are kept for you to look at.");
  return out;
}

/**
 * Docker prunes whatever daemon the environment names, while the mounts and df
 * here are measured on THIS disk. A remote DOCKER_HOST, or a context that is not
 * the local default, would have `image prune -a` clean another machine and report
 * this one's numbers. Null: the local daemon.
 */
async function dockerAimedElsewhere(ctx: DiskCtx): Promise<string | null> {
  const host = process.env.DOCKER_HOST?.trim();
  if (host && !host.startsWith("unix://")) return "DOCKER_HOST points Docker at another machine, so its space is not counted and nothing of it is cleaned.";
  const c = await ctx.run("docker", ["context", "show"], { timeoutMs: 10_000 });
  const name = c.stdout.trim();
  if (c.code === 0 && name && name !== "default") return `Docker is set to use the "${name}" context, not this machine's own, so its space is not counted and nothing of it is cleaned.`;
  return null;
}

/**
 * What the verdicts need beyond `docker system df`: the containers (one ps, one
 * inspect for all of them: --rm, exit code, image, compose project) and the
 * images with no registry copy that no container uses. `localOnly` is null when
 * Docker would not list images. The clean asks the same question again right
 * before it prunes, so a verdict made minutes ago is not the one acted on.
 */
async function dockerFacts(ctx: DiskCtx): Promise<{ ps: DockerPs; psOk: boolean; localOnly: string[] | null }> {
  const [psOut, imgOut] = await Promise.all([
    ctx.run("docker", ["ps", "-a", "--format", "{{json .}}"], { timeoutMs: 20_000 }),
    ctx.run("docker", ["images", "--digests", "--format", "{{json .}}"], { timeoutMs: 20_000 }),
  ]);
  const ps = parseDockerPs(psOut.code === 0 ? psOut.stdout : "");
  const rows = ps.ids.length ? parseInspect((await ctx.run("docker", ["inspect", "--format", INSPECT_FORMAT, ...ps.ids], { timeoutMs: 20_000 })).stdout) : [];
  const candidate = new Set(ps.exitedClean.map((c) => c.id));
  ps.selfRemoving = rows.filter((r) => selfRemoves(r) && [...candidate].some((c) => r.id.startsWith(c) || c.startsWith(r.id))).map((r) => r.id);
  return { ps, psOk: psOut.code === 0, localOnly: imgOut.code === 0 && psOut.code === 0 ? localOnlyImages(parseDockerImages(imgOut.stdout), rows.map((r) => r.image)) : null };
}

async function scanDocker(sc: Scan): Promise<LineDraftAt[]> {
  const elsewhere = await dockerAimedElsewhere(sc.ctx);
  if (elsewhere) { sc.problems.push(elsewhere); return []; }
  const info = await sc.ctx.run("docker", ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 15_000 });
  if (info.missing) { sc.problems.push("Docker is not installed, so its space is not counted."); return []; }
  if (info.code !== 0) { sc.problems.push("Docker is installed but did not answer (is it running?), so its space is not counted."); return []; }
  const [df, facts] = await Promise.all([
    sc.ctx.run("docker", ["system", "df", "--format", "{{json .}}"], { timeoutMs: 30_000 }),
    dockerFacts(sc.ctx),
  ]);
  if (df.code !== 0) { sc.problems.push("Docker would not report its space."); return []; }
  const at = info.stdout.trim() || "/var/lib/docker";
  return classifyDocker(parseDockerDf(df.stdout), facts.ps, facts.localOnly).map((d) => ({ ...d, at }));
}

/** A line plus the path whose disk it lives on, before the mount is looked up. */
type LineDraftAt = LineDraft & { at: string };

const RANK: Record<DiskCleanVerdict, number> = { safe: 0, ask: 1, inuse: 2, explain: 3 };

export async function scanDisk(ctx: DiskCtx): Promise<DiskCleanReport> {
  const sc: Scan = { ctx, mounts: new Map(), mountOf: new Map(), problems: [] };
  const parts = await Promise.all([scanDocker(sc), scanWorktrees(sc), scanFsSimple(sc), scanClaudeTemp(sc), scanSystem(sc)]);
  const lines: DiskCleanLine[] = [];
  for (const d of parts.flat()) {
    const { at, ...rest } = d;
    lines.push({ ...rest, mount: await mountFor(sc, at) });
  }
  // The home disk is always shown, even with no line on it: that is the one a person wonders about.
  await mountFor(sc, ctx.home);
  lines.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || (b.bytes ?? 0) - (a.bytes ?? 0));
  let safeBytes = 0;
  for (const l of lines) if (l.verdict === "safe") { safeBytes += l.bytes ?? 0; const m = sc.mounts.get(l.mount); if (m) m.safeBytes += l.bytes ?? 0; }
  return { lines, mounts: [...sc.mounts.values()], safeBytes, at: ctx.now, problems: sc.problems };
}

let last: { at: number; report: DiskCleanReport } | null = null;
let flying: Promise<DiskCleanReport> | null = null;
/** Bumped by every clean: a scan that started before it describes a disk that is gone and must not be cached. */
let generation = 0;

/** Cached; a fresh scan is allowed only when the last one is older than SCAN_MIN_RESCAN_MS. */
export async function diskCleanReport(fresh: boolean, ctx: DiskCtx = defaultDiskCtx()): Promise<DiskCleanReport> {
  const age = last ? Date.now() - last.at : Infinity;
  if (last && (fresh ? age < SCAN_MIN_RESCAN_MS : age < SCAN_TTL_MS)) return last.report;
  if (flying) return flying;
  const gen = generation;
  const p: Promise<DiskCleanReport> = scanDisk({ ...ctx, now: Date.now() })
    .then((report) => { if (gen === generation) last = { at: Date.now(), report }; return report; })
    .finally(() => { if (flying === p) flying = null; });
  flying = p;
  return p;
}

// -------------------------------------------------------------- deleting ----

/** The only Docker prunes a clean may run. No `volume`, no `system`, no `--volumes`, and no `container prune`: containers go by the ids the scan showed, through `docker rm`. */
export const DOCKER_PRUNE: Record<"images" | "cache", string[]> = {
  images: ["image", "prune", "-a", "-f"],
  cache: ["builder", "prune", "-a", "-f"],
};

type Refusal = { ok: false; error: string };
const inside = (child: string, parent: string) => child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
const rawOk = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.startsWith("/") && !p.includes("\0") && !p.split("/").includes("..");

/**
 * The checks every filesystem deletion passes, and what it deletes if it does.
 * Real paths, so a symlink anywhere is judged by where it lands:
 *   - $HOME is a real directory that is not "/";
 *   - the root is one of allowedFsRoots, resolves inside $HOME and not to it,
 *     and resolves to the very place its name says (real $HOME + the same
 *     relative path): a cache folder that is a link to some other folder of
 *     $HOME would otherwise pass every "inside $HOME" test, and the folder it
 *     leads to (~/.claude, say) could be one this never touches. No allowed
 *     root is under ~/.claude, which a test pins;
 *   - the path has no `..`, resolves inside the root (or to it, where the root
 *     may be emptied), so a link pointing out is refused.
 * Not covered here: a swap between this check and the rm. deleteFs looks again
 * right before removing; a local attacker who can write to ~/.cache already
 * owns the user.
 */
export function guardFs(t: { root: unknown; path: unknown }, homeIn: string): { ok: true; real: string; realRoot: string } | Refusal {
  if (!rawOk(homeIn) || homeIn === "/") return { ok: false, error: "no home directory to clean inside" };
  if (!rawOk(t.root) || !rawOk(t.path)) return { ok: false, error: "that is not an absolute path inside the allowed folders" };
  const roots = allowedFsRoots(homeIn);
  const mayEmpty = roots.get(t.root);
  if (mayEmpty === undefined) return { ok: false, error: "that folder is not one agentglass cleans" };
  let home: string, root: string, real: string;
  try { home = realpathSync(homeIn); root = realpathSync(t.root); real = realpathSync(t.path); } catch { return { ok: false, error: "that path no longer exists" }; }
  // `inside` is strict, so a root that resolves to $HOME itself (a link) is refused here too.
  if (!inside(root, home)) return { ok: false, error: "that folder leaves your home directory" };
  if (root !== join(home, relative(homeIn, t.root))) return { ok: false, error: "that folder is a link to somewhere else, so it is not cleaned" };
  if (real === root ? !mayEmpty : !inside(real, root)) return { ok: false, error: "that path is not inside the folder it was listed under" };
  return { ok: true, real, realRoot: root };
}

/**
 * Remove what a passed guard named. A root that may be emptied keeps its own
 * mode, owner and inode: its children go, it stays. A child on another device (a
 * disk or bind mount set up inside a cache folder, as big model stores often
 * are) is skipped and returned by name, not emptied through the mount.
 * shortcut: only the root's children are compared; a mount nested deeper would
 * need a walk of the whole tree before the rm, which a cache of millions of files
 * makes slow. Upgrade if one shows up there.
 */
export function removeGuarded(g: { real: string; realRoot: string }, path: string, devOf: (p: string) => number = (p) => lstatSync(p).dev): string[] {
  // The last look, right before the rm: the path must still be what the guard saw, and not a link.
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== g.real) throw Object.assign(new Error("that path changed while it was being checked"), { code: "ECHANGED" });
  const dev = devOf(g.realRoot), other: string[] = [];
  if (g.real !== g.realRoot) {
    if (devOf(g.real) !== dev) return [basename(g.real)];
    rmSync(g.real, { recursive: true, force: true });
    return [];
  }
  let first: unknown = null;
  // A child that cannot go (root-owned) must not stop the others: remember the first failure and say it at the end.
  for (const e of readdirSync(g.real)) {
    const child = join(g.real, e);
    try {
      if (devOf(child) !== dev) { other.push(e); continue; }
      rmSync(child, { recursive: true, force: true });
    } catch (err) { first ??= err; }
  }
  if (first) throw first;
  return other;
}

async function deleteFs(t: Extract<DiskCleanTarget, { via: "fs" }>, ctx: DiskCtx): Promise<Pick<DiskCleanLineResult, "status" | "detail">> {
  const g = guardFs(t, ctx.home);
  if (!g.ok) return { status: "refused", detail: g.error };
  try {
    const skipped = removeGuarded(g, t.path as string);
    // The trash's index goes with its files, through the same guard.
    if (t.root === join(ctx.home, TRASH_REL)) {
      const info = join(ctx.home, TRASH_INFO_REL), gi = guardFs({ root: info, path: info }, ctx.home);
      if (gi.ok) removeGuarded(gi, info);
    }
    return skipped.length ? { status: "freed", detail: `Left alone, because each is another disk mounted inside: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""}.` } : { status: "freed" };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "EACCES" || code === "EPERM") return { status: "needs-sudo", detail: "Part of it belongs to root (often files a container made). agentglass does not ask for root; remove it with sudo yourself." };
    if (code === "ECHANGED") return { status: "refused", detail: (e as Error).message };
    return { status: "failed", detail: String((e as Error).message ?? e).slice(0, 200) };
  }
}

async function deleteWorktree(t: Extract<DiskCleanTarget, { via: "worktree" }>, ctx: DiskCtx): Promise<Pick<DiskCleanLineResult, "status" | "detail">> {
  const refuse = (detail: string) => ({ status: "refused" as const, detail });
  if (!rawOk(ctx.home) || ctx.home === "/") return refuse("no home directory to clean inside");
  if (!rawOk(t.path) || !rawOk(t.repo)) return refuse("that is not an absolute path");
  let code: string, real: string;
  try { code = realpathSync(join(ctx.home, "code")); real = realpathSync(t.path); } catch { return refuse("that checkout no longer exists"); }
  if (!inside(real, code)) return refuse("that checkout is not under ~/code");
  const list = await ctx.run("git", ["-C", t.repo, "worktree", "list", "--porcelain"], { timeoutMs: 15_000 });
  if (list.code !== 0) return refuse("git could not list the checkouts of that repository");
  const all = parseWorktreeList(list.stdout, t.repo);
  const hit = all.slice(1).find((w) => { try { return realpathSync(w.path) === real; } catch { return false; } });
  if (!hit || hit.bare || hit.locked) return refuse("git does not list that as a removable checkout of the repository");
  // The scan is up to minutes old: look again at what it decided on, right before the removal.
  if (anyInside(await busyDirs(ctx), real)) return refuse("a terminal or a program is running inside that checkout now");
  const left = await leftoversOf(ctx, t.repo, hit.path);
  if (left.error || left.names.length || left.more) return refuse("it holds files git ignores that no other copy has, so it is kept");
  // No --force: git itself refuses a checkout with changes, the last guard.
  const r = await ctx.run("git", ["-C", t.repo, "worktree", "remove", real], { timeoutMs: 120_000 });
  if (r.code === 0) return { status: "freed" };
  if (/permission denied/i.test(r.stderr)) return { status: "needs-sudo", detail: "Files in it belong to root (often made by a container). agentglass does not ask for root; remove it with sudo yourself." };
  return { status: "failed", detail: (r.stderr.trim().split("\n")[0] ?? "git would not remove it").slice(0, 200) };
}

/** `docker rm` of exactly the containers the scan listed, and only those that are still finished runs that remove themselves. No -f, no -v. */
async function removeContainers(ids: unknown, ctx: DiskCtx): Promise<Pick<DiskCleanLineResult, "status" | "detail">> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((i) => typeof i !== "string" || !CONTAINER_ID.test(i))) return { status: "refused", detail: "that is not a list of container ids" };
  const rows = parseInspect((await ctx.run("docker", ["inspect", "--format", INSPECT_FORMAT, ...(ids as string[])], { timeoutMs: 20_000 })).stdout);
  const keep = rows.filter((r) => selfRemoves(r) && (ids as string[]).includes(r.id)).map((r) => r.id);
  if (!keep.length) return { status: "refused", detail: "none of those containers is a finished run that removes itself any more" };
  const r = await ctx.run("docker", ["rm", ...keep], { timeoutMs: 120_000 });
  if (r.code !== 0) return { status: "failed", detail: (r.stderr.trim().split("\n")[0] ?? "docker failed").slice(0, 200) };
  const left = (ids as string[]).length - keep.length;
  return left ? { status: "freed", detail: `${plural(left, "container")} left alone: they are not what the scan showed any more.` } : { status: "freed" };
}

async function deleteDocker(t: Extract<DiskCleanTarget, { via: "docker" }>, ctx: DiskCtx): Promise<Pick<DiskCleanLineResult, "status" | "detail">> {
  const argv = Object.hasOwn(DOCKER_PRUNE, t.what) ? DOCKER_PRUNE[t.what as "images" | "cache"] : undefined;
  if (!argv && t.what !== "containers") return { status: "refused", detail: "agentglass only cleans Docker images, build cache and stopped containers" };
  const elsewhere = await dockerAimedElsewhere(ctx);
  if (elsewhere) return { status: "refused", detail: elsewhere };
  if (!argv) return removeContainers((t as { ids?: unknown }).ids, ctx);
  if (t.what === "images") {
    // The scan is minutes old: an image made or loaded since is not one the plan promised.
    const f = await dockerFacts(ctx);
    if (!f.psOk || f.localOnly === null || f.localOnly.length) return { status: "refused", detail: "some unused images exist only on this machine now (or Docker would not say), so none is removed" };
  }
  const r = await ctx.run("docker", argv, { timeoutMs: 300_000 });
  if (r.missing) return { status: "failed", detail: "Docker is not installed" };
  if (r.code !== 0) return { status: "failed", detail: (r.stderr.trim().split("\n")[0] ?? "docker failed").slice(0, 200) };
  return { status: "freed" };
}

/** The one place a target becomes an effect. Anything not exactly a known shape is refused. */
export async function deleteTarget(t: DiskCleanTarget | null | undefined, ctx: DiskCtx): Promise<Pick<DiskCleanLineResult, "status" | "detail">> {
  if (!t || typeof t !== "object") return { status: "refused", detail: "nothing to remove" };
  if (t.via === "fs") return deleteFs(t, ctx);
  if (t.via === "worktree") return deleteWorktree(t, ctx);
  if (t.via === "docker") return deleteDocker(t, ctx);
  return { status: "refused", detail: "not a kind of target agentglass removes" };
}

async function freeOn(ctx: DiskCtx, mount: string): Promise<number> {
  const d = parseDf((await ctx.run("df", ["-P", "-B1", mount], { timeoutMs: 10_000 })).stdout);
  return d?.free ?? 0;
}

let cleaning = false;

/**
 * Remove the safe lines named by `ids` (all safe lines when omitted), looked up
 * in a FRESH scan: the client's ids pick lines, the paths come from here. A line
 * that is not `safe`, or has no target, is refused. Free space is read on the
 * line's mount before and after each one, so "freed" is what the disk gained.
 */
export async function runDiskClean(idsIn: unknown, opts: { dryRun?: boolean; at?: unknown }, ctx: DiskCtx = defaultDiskCtx()): Promise<DiskCleanRunResult> {
  const dryRun = !!opts.dryRun;
  const fail = (error: string): DiskCleanRunResult => ({ ok: false, error, dryRun, lines: [], mounts: [], freed: 0 });
  let ids: string[] | null = null;
  if (idsIn !== undefined && idsIn !== null) {
    if (!Array.isArray(idsIn) || idsIn.length > 500 || idsIn.some((i) => typeof i !== "string" || !i || i.length > 600)) return fail("ids must be a list of line ids");
    ids = idsIn as string[];
  }
  // `at` is the scan the person is looking at. A clean resolves the ids against THAT scan or refuses: a screen left open for hours
  // shows sizes and verdicts that are no longer true, and the button's label is what they agreed to.
  const seen = typeof opts.at === "number" && Number.isFinite(opts.at) ? opts.at : null;
  if (cleaning) return fail("a clean is already running");
  cleaning = true;
  try {
    // The scan a person just looked at is the plan they confirmed; a second full one would repeat every GitHub and du call.
    generation++; flying = null;
    const reuse = last && (seen !== null ? last.report.at === seen && Date.now() - last.at < SCAN_TTL_MS : Date.now() - last.at < SCAN_MIN_RESCAN_MS) ? last : null;
    const report = reuse ? reuse.report : await scanDisk({ ...ctx, now: Date.now() });
    if (!reuse) last = { at: Date.now(), report };
    if (seen !== null && report.at !== seen) return fail("The disk has changed since this plan was made. Nothing was removed: scan again, look at the new plan, then confirm.");
    const byId = new Map(report.lines.map((l) => [l.id, l]));
    const wanted = ids ?? report.lines.filter((l) => l.verdict === "safe").map((l) => l.id);
    const results: DiskCleanLineResult[] = [];
    const before = new Map<string, number>(), after = new Map<string, number>();
    // Docker's images go before its containers: a container removed first would
    // free its image, and the plan promised only the images nothing used.
    const order = (id: string) => (id === "docker:containers" ? 1 : 0);
    for (const id of [...new Set(wanted)].sort((a, b) => order(a) - order(b))) {
      const line = byId.get(id);
      if (!line) { results.push({ id, label: id, status: "refused", freed: 0, detail: "that line is not in the scan any more" }); continue; }
      if (line.verdict !== "safe" || !line.target) { results.push({ id, label: line.label, status: "refused", freed: 0, detail: `this one is "${line.verdict}", not part of the plan` }); continue; }
      if (dryRun) { results.push({ id, label: line.label, status: "planned", freed: 0 }); continue; }
      const pre = await freeOn(ctx, line.mount);
      if (!before.has(line.mount)) before.set(line.mount, pre);
      const r = await deleteTarget(line.target, ctx);
      const post = await freeOn(ctx, line.mount);
      after.set(line.mount, post);
      const freed = r.status === "freed" ? Math.max(0, post - pre) : 0;
      results.push({ id, label: line.label, status: r.status === "freed" && freed === 0 ? "nothing" : r.status, freed, detail: r.detail });
    }
    // Not after a dry run: nothing changed, and the confirm click that follows reuses this very scan.
    if (!dryRun) { generation++; flying = null; last = null; }
    return {
      ok: true, dryRun, lines: results,
      mounts: [...before].map(([mount, b]) => ({ mount, before: b, after: after.get(mount) ?? b })),
      freed: results.reduce((n, r) => n + r.freed, 0),
    };
  } finally { cleaning = false; }
}
