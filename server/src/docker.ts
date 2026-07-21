// Live docker adapter — the backend for agentglass's lazydocker-style panel.
// Shells out to the `docker` CLI with arg arrays (never a shell string), reads
// JSON-lines output, and gates every mutating op behind
// AGENTGLASS_DOCKER_WRITE_DISABLED=1. Container ids/names are validated before
// they reach the CLI.

import { basename } from "node:path";
import type {
  DockerContainer, DockerStat, DockerImage, DockerVolume, DockerNetwork,
  DockerOverview, DockerScope, DockerActionResult,
} from "../../shared/types.ts";
import { workspaceRoot, scopeRoots } from "./config.ts";

export const DOCKER_WRITE_ENABLED = process.env.AGENTGLASS_DOCKER_WRITE_DISABLED !== "1";
// Container id (hex) or name (compose names: letters/digits . _ -).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

type Res = { code: number; stdout: string; stderr: string };
function docker(args: string[], timeoutMs = 8000): Res {
  try {
    const proc = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return { code: proc.exitCode ?? 1, stdout: proc.stdout?.toString() ?? "", stderr: proc.stderr?.toString() ?? "" };
  } catch (e) {
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

/** Awaited variant, so independent queries can run at once. Each `docker`
 *  invocation pays the CLI's own startup before it talks to the daemon, and
 *  the overview needs five of them — serially that cost is paid five times
 *  over, on a poll. */
async function dockerAsync(args: string[], timeoutMs = 8000): Promise<Res> {
  try {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: code ?? 1, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

function jsonLines(out: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return rows;
}

let cachedVersion: string | null = null;
let versionCheckedAt = 0;
const VERSION_RETRY_MS = 15_000;
/** The daemon version doesn't change while we run, so a success is cached for
 *  good. A *failure* is cached too, briefly: re-probing on every poll meant a
 *  stopped daemon cost a blocking spawn — up to the 4s timeout — several times
 *  a minute, freezing the single-threaded server each time. */
export async function dockerVersion(): Promise<string | null> {
  if (cachedVersion) return cachedVersion;
  if (versionCheckedAt && Date.now() - versionCheckedAt < VERSION_RETRY_MS) return null;
  versionCheckedAt = Date.now();
  const r = await dockerAsync(["version", "--format", "{{.Server.Version}}"], 4000);
  cachedVersion = r.code === 0 ? r.stdout.trim() || null : null;
  return cachedVersion;
}

// Every field is named explicitly instead of using `{{json .}}`, which looks
// equivalent but silently includes `Size` — and asking for a container's size
// makes the daemon walk its filesystem layers. That one field took this call
// from 19ms to 4.9s here, on a poll, blocking every other request behind it.
// The panel doesn't show per-container size, so it isn't requested.

// --- project scope ----------------------------------------------------------
// The rest of the cockpit (events, sessions, git, diffs) narrows to the open
// project; the docker panel used to be the one surface that still showed the
// whole machine, which made "my containers" a hunt through everything else
// running on the host.
//
// Compose is the only thing that records which directory a container came from,
// so its labels are the key. `working_dir` is the strong signal — it is the
// absolute path of the compose file's directory — but it is only set by
// reasonably recent compose versions, so the project name is kept as a fallback
// for containers that carry just that.
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

// Compose lowercases the project name and drops everything outside [a-z0-9_-],
// so a checkout at ~/code/My.App runs as project "myapp". Comparing the raw
// basename would miss exactly those repos, which is the confusing half of the
// bug rather than the obvious half.
const normalizeProject = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "");

export interface DockerScopeKey { dir: string; project: string }
const trimSlash = (p: string) => p.replace(/\/+$/, "");

/** The open project expressed the way container labels express it, or null when
 *  this instance is machine-wide. */
export function dockerScopeKey(root: string | null): DockerScopeKey | null {
  if (!root) return null;
  const dir = trimSlash(root);
  return { dir, project: normalizeProject(basename(dir)) };
}

/**
 * Whether a container belongs to the open project.
 *
 * Either signal is enough. A directory match is authoritative — that stack was
 * literally launched from inside this checkout, whatever it named itself. A
 * name match is looser (two checkouts of the same repo in different directories
 * both answer to "myapp") but it is the only thing older compose versions give
 * us, and showing a sibling checkout's container is a far smaller failure than
 * showing none of them.
 */
export function containerInScope(c: { project: string | null; workingDir: string | null }, s: DockerScopeKey): boolean {
  const wd = trimSlash(c.workingDir || "");
  if (wd && (wd === s.dir || wd.startsWith(s.dir + "/"))) return true;
  return !!s.project && normalizeProject(c.project || "") === s.project;
}

// Carries the working-dir label alongside the wire shape; it is a matching
// input, not something the panel renders, so it is stripped before serving.
type ScopedContainer = DockerContainer & { workingDir: string | null };
const strip = (c: ScopedContainer): DockerContainer => {
  const { workingDir: _wd, ...rest } = c;
  return rest;
};

/**
 * Apply the scope to a container list.
 *
 * When a scope is set but nothing matches, the full list is returned with
 * `showingAll` set rather than an empty one. An empty panel is indistinguishable
 * from a broken daemon, and plenty of perfectly normal containers carry no
 * compose labels at all (`docker run`, Podman, k3d) — silently hiding them would
 * teach people the panel is unreliable. Degrading to the host view *and saying
 * so* keeps the panel honest in both directions.
 */
export function applyScope(all: ScopedContainer[], keyIn: DockerScopeKey | DockerScopeKey[] | null): { containers: DockerContainer[]; scope?: DockerScope } {
  // A list, because a project is its main checkout *and* its linked worktrees.
  // A stack brought up from ~/code/orbit-WEB-1042 has that as its working_dir
  // and `orbit-web-1042` as its compose project — neither matches `orbit` by
  // path or by name, so scoping to the project used to hide the containers the
  // user had just started. The first key is the project itself, and it names
  // the scope in the UI.
  const keys = keyIn ? (Array.isArray(keyIn) ? keyIn : [keyIn]) : [];
  if (!keys.length) return { containers: all.map(strip) };
  const mine = all.filter((c) => keys.some((k) => containerInScope(c, k)));
  const scope: DockerScope = { workspace: keys[0].dir, project: keys[0].project, matched: mine.length, showingAll: mine.length === 0 };
  return { containers: (mine.length ? mine : all).map(strip), scope };
}

// One column per field, tab-separated, and every label asked for **by name**.
//
// Not hand-built JSON: a container whose name, image or labels contain a quote
// or a backslash produces invalid JSON, jsonLines() drops the row silently, and
// the container vanishes from the panel with no error. Real labels do this (a
// cloudflared image here embeds a JSON blob in one).
//
// And not `{{.Labels}}` either, which is where the labels used to come from.
// That field is every label joined with commas and no escaping, so a value
// containing a comma cannot be read back: `desc=a,b` splits into `desc=a` and a
// stray `b`, and a value containing both a comma and an `=` invents a key that
// was never on the container. Harmless-looking until you remember scoping now
// *depends* on reading these labels correctly — a working_dir label sitting
// next to a comma-bearing one is a container that quietly stops matching its
// own project. `{{.Label "x"}}` asks the daemon for one label and gets its value
// verbatim, which sidesteps the ambiguity rather than trying to parse it.
const PS_COLUMNS = [
  ["id", "{{.ID}}"],
  ["name", "{{.Names}}"],
  ["image", "{{.Image}}"],
  ["state", "{{.State}}"],
  ["status", "{{.Status}}"],
  ["ports", "{{.Ports}}"],
  ["runningFor", "{{.RunningFor}}"],
  ["project", `{{.Label "com.docker.compose.project"}}`],
  ["service", `{{.Label "com.docker.compose.service"}}`],
  ["workingDir", `{{.Label "${WORKING_DIR_LABEL}"}}`],
] as const;
const PS_FORMAT = PS_COLUMNS.map(([, tmpl]) => tmpl).join("\t");

/** One `docker ps` line to a container. Exported for the tests: the interesting
 *  failures here are label values that a joined-and-split format destroys. */
export function parsePsLine(line: string): ScopedContainer | null {
  if (!line.trim()) return null;
  const parts = line.split("\t");
  const col = (name: string) => parts[PS_COLUMNS.findIndex(([n]) => n === name)] ?? "";
  return {
    id: col("id").slice(0, 12),
    name: col("name"),
    image: col("image"),
    state: col("state").toLowerCase(),
    status: col("status"),
    ports: col("ports"),
    project: col("project") || null,
    service: col("service") || null,
    workingDir: col("workingDir") || null,
    runningFor: col("runningFor"),
    size: "",
  };
}

async function containers(): Promise<ScopedContainer[]> {
  const r = await dockerAsync(["ps", "--all", "--no-trunc", "--format", PS_FORMAT]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map(parsePsLine).filter((c): c is ScopedContainer => !!c);
}

async function images(): Promise<DockerImage[]> {
  const r = await dockerAsync(["images", "--format", "{{json .}}"]);
  if (r.code !== 0) return [];
  return jsonLines(r.stdout).map((i) => ({
    id: i.ID || "",
    repository: i.Repository || "",
    tag: i.Tag || "",
    size: i.Size || "",
    created: i.CreatedSince || "",
    containers: i.Containers || "",
    dangling: (i.Repository || "") === "<none>",
  }));
}

async function volumes(): Promise<DockerVolume[]> {
  const r = await dockerAsync(["volume", "ls", "--format", "{{json .}}"]);
  if (r.code !== 0) return [];
  return jsonLines(r.stdout).map((v) => ({ name: v.Name || "", driver: v.Driver || "" }));
}

async function networks(): Promise<DockerNetwork[]> {
  const r = await dockerAsync(["network", "ls", "--format", "{{json .}}"]);
  if (r.code !== 0) return [];
  return jsonLines(r.stdout).map((n) => ({ id: (n.ID || "").slice(0, 12), name: n.Name || "", driver: n.Driver || "", scope: n.Scope || "" }));
}

// The panel polls the overview every few seconds. Four CLI round-trips run
// back to back cost more than the interval on a busy daemon, so the poll was
// never idle — it just queued. They're independent, so they go together, and
// the result is held long enough to absorb a second viewer or a panel reopen.
const OVERVIEW_CACHE_MS = 2_000;
// The scope is part of the cache identity: the project picker can switch
// workspaces mid-poll, and serving the previous project's containers for the
// next two seconds looks like the switch didn't take.
let overviewCache: { at: number; root: string | null; data: DockerOverview } | null = null;

export async function overview(): Promise<DockerOverview> {
  const root = workspaceRoot();
  if (overviewCache && overviewCache.root === root && Date.now() - overviewCache.at < OVERVIEW_CACHE_MS) return overviewCache.data;
  const version = await dockerVersion();
  if (!version) {
    const down: DockerOverview = { available: false, writeEnabled: DOCKER_WRITE_ENABLED, version: null, containers: [], images: [], volumes: [], networks: [], error: "docker not available (is the daemon running?)" };
    overviewCache = { at: Date.now(), root, data: down };
    return down;
  }
  const [c, i, v, n] = await Promise.all([containers(), images(), volumes(), networks()]);
  // Only containers are scoped. Images, volumes and networks are host-global
  // resources shared between projects — an image layer isn't "owned" by the
  // checkout that happened to build it — so filtering them would hide things
  // the user can legitimately act on without telling them anything true.
  // Every checkout of the project, so a stack started in a worktree is still
  // this project's stack.
  const { containers: scoped, scope } = applyScope(c, scopeRoots(root).map(dockerScopeKey).filter((k): k is DockerScopeKey => !!k));
  const data: DockerOverview = { available: true, writeEnabled: DOCKER_WRITE_ENABLED, version, containers: scoped, images: i, volumes: v, networks: n, ...(scope ? { scope } : {}) };
  overviewCache = { at: Date.now(), root, data };
  return data;
}

const pct = (s?: string) => { const n = parseFloat((s || "").replace("%", "")); return Number.isFinite(n) ? n : 0; };

let statsCache: { at: number; key: string; data: DockerStat[] } | null = null;
/** Long enough that a 5s poll never lands on a cold cache twice in a row. */
const STATS_TTL_MS = 4000;

/**
 * Live-ish resource stats (a single --no-stream sample).
 *
 * Async, and it matters more here than anywhere else in this file: the command
 * takes about two seconds, and run synchronously it stopped the whole server
 * for that long — this process serves the terminal's PTY bytes on the same
 * event loop, so an open Docker panel meant the terminal froze for two seconds
 * out of every five and then dumped everything you had typed at once.
 *
 * Cached for the same reason `overview()` is: a 5s poll of a 2s command is
 * close enough to continuous that two clients would otherwise keep one running
 * permanently.
 */
export async function stats(ids?: string[]): Promise<DockerStat[]> {
  // Sample the containers the panel is showing, not the machine.
  //
  // `docker stats` with no arguments samples every running container on the
  // host, and the panel then threw away the ones it had already decided not to
  // show. That is work the daemon does on a five-second poll, growing with
  // everything else running on the machine and having nothing to do with this
  // project — and a panel that has scoped itself is still touching containers
  // it scoped out, which is the part that shouldn't be true.
  //
  // An explicitly empty list means "nothing in scope is running", and the right
  // number of daemon round-trips for that is zero. `undefined` still means the
  // whole host, so a caller with no scope to offer keeps the old behaviour.
  const targets = ids ? [...new Set(ids)].filter((id) => ID_RE.test(id)) : null;
  if (targets && !targets.length) return [];
  const key = targets ? targets.join(",") : "*";
  if (statsCache && statsCache.key === key && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.data;
  const r = await dockerAsync(["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", ...(targets ?? [])], 12000);
  // A container removed between the overview and this call takes the whole
  // command down with it ("No such container"). Falling back to the host sample
  // costs one extra round-trip on a rare race and keeps the panel populated,
  // which beats blanking every gauge until the next poll.
  if (r.code !== 0) return targets ? stats() : [];
  const data = jsonLines(r.stdout).map((s) => ({
    id: (s.ID || "").slice(0, 12),
    cpu: pct(s.CPUPerc),
    mem: pct(s.MemPerc),
    memUsage: s.MemUsage || "",
    netIO: s.NetIO || "",
    blockIO: s.BlockIO || "",
    pids: parseInt(s.PIDs || "0", 10) || 0,
  }));
  statsCache = { at: Date.now(), key, data };
  return data;
}

/** Last `tail` log lines for a container (bounded). Docker writes logs to stderr. */
export function logs(id: string, tail = 400): { ok: boolean; text: string; error?: string } {
  if (!ID_RE.test(id)) return { ok: false, text: "", error: "invalid container id" };
  const n = Math.max(1, Math.min(5000, tail | 0));
  const r = docker(["logs", "--tail", String(n), "--timestamps", id], 10000);
  // A container writes its own logs to stderr with exit 0; a non-zero exit is a
  // real failure (e.g. "No such container") — surface it as an error, not logs.
  if (r.code !== 0) return { ok: false, text: "", error: r.stderr.trim() || "docker logs failed" };
  // Interleave: docker sends stdout+stderr separately; concatenate both.
  return { ok: true, text: (r.stdout + r.stderr) };
}

function guard(id: string): DockerActionResult | null {
  if (!DOCKER_WRITE_ENABLED) return { ok: false, error: "docker write is disabled (AGENTGLASS_DOCKER_WRITE_DISABLED=1)" };
  if (!ID_RE.test(id)) return { ok: false, error: "invalid container id" };
  return null;
}
function action(verb: string, id: string, extra: string[] = []): DockerActionResult {
  const g = guard(id); if (g) return g;
  const r = docker([verb, ...extra, id], 20000);
  // The panel refetches right after acting; without dropping the cache it gets
  // the pre-action snapshot back and the container looks unchanged, as though
  // the button did nothing.
  overviewCache = null;
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `docker ${verb} failed` };
  return { ok: true, output: r.stdout.trim() || `${verb} ${id.slice(0, 12)}` };
}

export const startContainer = (id: string) => action("start", id);
export const stopContainer = (id: string) => action("stop", id);
export const restartContainer = (id: string) => action("restart", id);
export const removeContainer = (id: string) => action("rm", id); // non-force: fails if running (stop first)

/**
 * The three things lazydocker shows that we did not.
 *
 * `env` and `config` come from one `inspect` — asking twice for the same JSON
 * to render two tabs would double the latency of switching between them for no
 * gain. `top` is a live process list, so it is its own call.
 */
export function inspect(id: string): { ok: boolean; env: string[]; config: string; error?: string } {
  if (!ID_RE.test(id)) return { ok: false, env: [], config: "", error: "invalid container id" };
  const r = docker(["inspect", id], 10000);
  if (r.code !== 0) return { ok: false, env: [], config: "", error: r.stderr.trim() || "docker inspect failed" };
  let env: string[] = [];
  let config = r.stdout;
  try {
    const parsed = JSON.parse(r.stdout);
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    env = Array.isArray(one?.Config?.Env) ? one.Config.Env : [];
    // Re-serialised at a readable indent: docker's own output is already
    // pretty, but only sometimes, depending on version.
    config = JSON.stringify(one, null, 2);
  } catch { /* keep the raw text — unparseable is still readable */ }
  return { ok: true, env, config };
}

export function top(id: string): { ok: boolean; text: string; error?: string } {
  if (!ID_RE.test(id)) return { ok: false, text: "", error: "invalid container id" };
  const r = docker(["top", id], 10000);
  // A stopped container cannot be topped, and saying that is better than an
  // empty table that looks like "no processes".
  if (r.code !== 0) return { ok: false, text: "", error: r.stderr.trim() || "the container is not running" };
  return { ok: true, text: r.stdout };
}
