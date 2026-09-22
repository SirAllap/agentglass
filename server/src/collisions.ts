// Runtime collisions: two live sessions, in two different checkouts, using the
// same thing that lives outside both trees.
//
// A worktree per agent keeps the code apart and nothing else. The dev database,
// the port a server binds, an .env one directory up, a compose project named
// after a folder both checkouts happen to share — those are one of each for the
// whole machine, and a per-session diff cannot show them by construction. Two
// agents migrating one database both finish green; the second one's schema is
// the one that is left.
//
// Everything here is read out of what the sessions already reported — the Bash
// commands and the file tools' paths in `events` — plus `ss`'s listening
// sockets, attributed to the checkout their process runs in. It is a warning
// and nothing more: it never blocks a command, allocates a port or holds a
// lock. It is also a heuristic, and says so where it is shown.
//
// The ceilings, chosen rather than missed:
// - A command is parsed one `&&`/`;`/`|`/newline segment at a time, split
//   outside quotes only, with `cd` followed and heredoc bodies skipped. `$(…)`
//   and backticks are not parsed: a separator inside an unquoted one splits.
// - A path built from a variable or a glob is not guessed at.
// - Ports and database files come from what a process is started with or asked
//   to reach, never from text: the arguments of grep, echo, git and the like,
//   and heredoc bodies, are not read for them. `bash -c "PORT=3000 …"` is text
//   too, and is missed.
// - Ports below 1024 are not claimed: a dev server does not bind one, and the
//   ones that turn up in commands are somebody else's ssh or https.
// - The compose project for a bare `docker compose` is the cwd's basename. The
//   real rule looks upwards for the compose file first; from a subdirectory of
//   the project this names the subdirectory. A `name:` in the compose file and
//   COMPOSE_PROJECT_NAME in an .env are not read: nothing here opens a file.
// - A session counts only inside a git checkout, and its checkout is the one
//   its latest cwd is in: one that cds into another tree takes its window of
//   claims along. A listener is matched to a checkout by its process's cwd,
//   not by which session started it.
// - Listeners come from `ss` and /proc, so the "listening" half is Linux only;
//   on macOS and Windows a collision is read from commands and files alone.
// - Postgres and redis are recognised by URL and by data directory; a bare
//   `psql -d acme_dev` names no host and is not read.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Collision, CollisionKind, CollisionParty } from "../../shared/types.ts";
import { db } from "./db.ts";
import { listPortsAsync } from "./machine.ts";

/**
 * How long a session counts as live without saying anything.
 *
 * Not the dashboard's two minutes. A `Stop` closes a turn, not a session, and
 * the dev server an agent started ten minutes ago is still bound while it sits
 * at its prompt — that quiet stretch is exactly when the other checkout walks
 * into it. Commands older than this are not read either: a port claimed an hour
 * ago says nothing about now.
 */
export const COLLISION_WINDOW_MS = 30 * 60_000;

export interface Claim {
  kind: CollisionKind;
  /** The resource's identity: an absolute path, a port, `host:port/db`. */
  key: string;
}

const MIN_PORT = 1024;
const TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g;

const LOCAL = new Set(["", "localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "::", "[::]"]);
const host = (h: string) => (LOCAL.has(h.toLowerCase()) ? "localhost" : h.toLowerCase());

// Userinfo is matched and dropped; it is never part of a key or of evidence.
const PG_URL = /\bpostgres(?:ql)?(?:\+\w+)?:\/\/(?:[^@\s/'"]*@)?([^/\s?'":]*)(?::(\d+))?(?:\/([\w.-]+))?/gi;
const REDIS_URL = /\brediss?:\/\/(?:[^@\s/'"]*@)?([^/\s?'":]*)(?::(\d+))?(?:\/(\d+))?/gi;
const HOST_PORT = /(?:^|[^\w.])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/g;
const ASSIGN = /^[A-Z_][A-Z0-9_]*=/;

/**
 * Programs whose port flag names the server they connect to, not one they bind.
 *
 * Two checkouts on two databases of the one local Postgres is the normal setup,
 * and `psql -p 5432` in both is not a collision any more than the port inside
 * a database URL is.
 */
const CLIENTS = new Set([
  "ssh", "scp", "sftp", "rsync",
  "psql", "pg_dump", "pg_dumpall", "pg_restore", "pg_isready", "pgcli", "createdb", "dropdb",
  "redis-cli", "redis-benchmark", "mysql", "mysqldump", "mysqladmin", "mariadb", "mongosh", "mongo",
]);

/**
 * Programs whose arguments are text about things, not things in use.
 *
 * `grep localhost:3000`, a commit message that names a port, `git diff -- dev.db`:
 * each would claim the resource for the whole window and flag both checkouts
 * that grep the same README. Their ports and database files are not read. An
 * .env still is — `grep KEY ../.env` reads the file.
 */
const TEXT = new Set([
  "git", "gh", "grep", "egrep", "fgrep", "rg", "ag", "ack", "echo", "printf", "sed", "awk", "gawk",
  "cat", "less", "more", "head", "tail", "wc", "diff", "jq", "tee", "sort", "find", "ls",
]);

/**
 * A command's segments: split on `&&`, `||`, `;`, `|` and newlines, but only
 * outside quotes, and with heredoc bodies left out.
 *
 * A quoted argument can span lines — a commit message or a PR body written
 * without a heredoc — and a heredoc body is text fed to a program. Split
 * naively, each of their lines was read as a command of its own, starting with
 * whatever word the prose started with.
 */
export function segmentsOf(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const pending: string[] = [];
  const cut = () => { out.push(cur); cur = ""; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < command.length && command[i + 1] !== "\n") { cur += c + command[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<") {
      // A heredoc opener: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`.
      // Anything else after `<<` (`$((1<<8))`) is not one.
      const m = /^<<-?[ \t]*(?:\\|(['"]))?([A-Za-z_][\w.-]*)\1?/.exec(command.slice(i));
      if (m) { pending.push(m[2]); cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "\n") {
      cut();
      // The bodies of the heredocs this line opened, each up to its own terminator.
      while (pending.length) {
        const end = pending.shift()!;
        let j = i + 1;
        for (;;) {
          const nl = command.indexOf("\n", j);
          const line = command.slice(j, nl < 0 ? command.length : nl);
          j = nl < 0 ? command.length : nl + 1;
          if (line.trim() === end || nl < 0) break;
        }
        i = j - 1;
      }
      continue;
    }
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) { cut(); i++; continue; }
    if (c === ";" || c === "|") { cut(); continue; }
    cur += c;
  }
  cut();
  return out;
}

const tokensOf = (seg: string) => [...seg.matchAll(TOKEN)].map((m) => m[1] ?? m[2] ?? m[3]);
const guessable = (p: string) => p.length > 0 && !/[$*?`{}]/.test(p);

function resolvePath(p: string, cwd: string | null): string | null {
  if (!guessable(p)) return null;
  if (p === "~" || p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p.startsWith("/")) return resolve(p);
  return cwd ? resolve(cwd, p) : null;
}

const isEnvFile = (p: string) => {
  const b = basename(p);
  return b === ".env" || b.startsWith(".env.");
};
const isSqlite = (p: string) => /\.(?:sqlite3?|db3?)$/i.test(p);
const isSocket = (p: string) => /\.sock$|\/\.s\.PGSQL\.\d+$/.test(p);

/** Which of the path-shaped resources a path is, if any. */
function pathClaim(abs: string): Claim | null {
  if (isEnvFile(abs)) return { kind: "env", key: abs };
  if (isSqlite(abs)) return { kind: "sqlite", key: abs };
  if (isSocket(abs)) return { kind: "socket", key: abs };
  return null;
}

/** The resources a file tool's `file_path` points at. */
export function claimsFromPath(path: string): Claim[] {
  const abs = resolvePath(path, null);
  const c = abs ? pathClaim(abs) : null;
  return c ? [c] : [];
}

const portOk = (n: number) => n >= MIN_PORT && n <= 65_535;

/** Compose's own normalisation of a project name. */
const composeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "");

/** Flags compose takes before its subcommand that carry a value. */
const COMPOSE_VALUED = new Set(["-p", "--project-name", "-f", "--file", "--project-directory", "--env-file", "--profile", "--ansi", "--progress", "--parallel"]);

/** docker's own flags that take a value, which may come before `compose`. */
const DOCKER_VALUED = new Set(["-c", "--context", "--config", "-H", "--host", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);

/** Where `docker-compose` or `docker [flags] compose` is, or -1. */
function composeIndex(toks: string[]): number {
  for (let i = 0; i < toks.length; i++) {
    const b = basename(toks[i]);
    if (b === "docker-compose") return i;
    if (b !== "docker") continue;
    let j = i + 1;
    while (j < toks.length && toks[j].startsWith("-")) j += !toks[j].includes("=") && DOCKER_VALUED.has(toks[j]) ? 2 : 1;
    if (toks[j] === "compose") return j;
  }
  return -1;
}

function composeClaim(toks: string[], at: number, here: string | null): Claim | null {
  let name: string | null = null;
  let dir: string | null = null;
  const env = toks.slice(0, at).find((t) => t.startsWith("COMPOSE_PROJECT_NAME="));
  if (env) name = env.slice("COMPOSE_PROJECT_NAME=".length);
  for (let i = at; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith("-")) break; // the subcommand: flags after it are its own
    const eq = t.indexOf("=");
    const flag = eq > 0 ? t.slice(0, eq) : t;
    const value = eq > 0 ? t.slice(eq + 1) : COMPOSE_VALUED.has(flag) ? toks[++i] : undefined;
    if (value === undefined) continue;
    if (flag === "-p" || flag === "--project-name") name = value;
    else if (flag === "--project-directory") dir = resolvePath(value, here);
    else if ((flag === "-f" || flag === "--file") && dir === null) {
      const file = resolvePath(value, here);
      if (file) dir = dirname(file);
    }
  }
  const project = name ?? (dir ?? here ? basename(dir ?? here!) : null);
  const key = project && guessable(project) ? composeName(project) : "";
  return key ? { kind: "compose", key } : null;
}

/**
 * The resources a Bash command touches.
 *
 * `cwd` is where the command ran; a relative path with no cwd is left alone
 * rather than resolved against the server's own directory.
 */
export function claimsFromCommand(command: string, cwd: string | null): Claim[] {
  const out = new Map<string, Claim>();
  const add = (c: Claim | null) => { if (c) out.set(`${c.kind} ${c.key}`, c); };
  let here = cwd;
  for (const raw of segmentsOf(command)) {
    let seg = raw;
    const toks = tokensOf(seg);
    if (!toks.length) continue;
    if (toks[0] === "cd" || toks[0] === "pushd") {
      here = toks[1] ? resolvePath(toks[1], here) : homedir();
      continue;
    }

    // Database URLs first, and cut out of the segment: the server's port inside
    // one is not a claim of its own — two databases on one server are two
    // databases, not a collision.
    for (const m of seg.matchAll(PG_URL)) add({ kind: "postgres", key: `${host(m[1])}:${m[2] ?? "5432"}/${m[3] ?? ""}` });
    for (const m of seg.matchAll(REDIS_URL)) add({ kind: "redis", key: `${host(m[1])}:${m[2] ?? "6379"}/${m[3] ?? "0"}` });
    seg = seg.replace(PG_URL, " ").replace(REDIS_URL, " ");

    const at = toks.findIndex((t) => !ASSIGN.test(t));
    const prog = at < 0 ? "" : basename(toks[at]);
    const text = TEXT.has(prog);

    // PORT as the environment a process is started with: before the program,
    // or the arguments of `export` and `env`. Anywhere else it is prose.
    const env = at < 0 ? toks : prog === "export" || prog === "env" ? [...toks.slice(0, at), ...toks.slice(at + 1)] : toks.slice(0, at);
    for (const t of env) {
      const m = /^PORT=(\d{2,5})$/.exec(t);
      if (m && portOk(+m[1])) add({ kind: "port", key: m[1] });
    }
    if (!text && !CLIENTS.has(prog)) {
      for (const m of seg.matchAll(HOST_PORT)) if (portOk(+m[1])) add({ kind: "port", key: m[1] });
    }
    const composeAt = composeIndex(toks);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const eq = t.indexOf("=");
      const flag = eq > 0 ? t.slice(0, eq) : t;
      const next = eq > 0 ? t.slice(eq + 1) : toks[i + 1];

      // A listening port by flag. `-p` is a port only as a whole number or a
      // docker publish spec. A client's port is the server it talks to — ssh's
      // is another machine, psql's the one Postgres every checkout shares.
      if ((flag === "--port" || flag === "--publish" || flag === "-p") && next && !CLIENTS.has(prog) && !text) {
        const m = /^(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d{2,5})(?::\d+)?(?:\/\w+)?$/.exec(next);
        const composeProjectFlag = composeAt >= 0 && i > composeAt && flag === "-p" && !toks.slice(composeAt + 1, i).some((x) => !x.startsWith("-"));
        if (m && portOk(+m[1]) && !composeProjectFlag) add({ kind: "port", key: m[1] });
      }

      // A data directory: postgres by -D / --pgdata / PGDATA, redis by --dir.
      if (/^(?:pg_ctl|postgres|initdb|pg_ctlcluster)$/.test(prog) && (flag === "-D" || flag === "--pgdata") && next) {
        const d = resolvePath(next, here);
        if (d) add({ kind: "datadir", key: d });
      }
      if (flag === "PGDATA" && eq > 0) {
        const d = resolvePath(next!, here);
        if (d) add({ kind: "datadir", key: d });
      }
      if (prog === "redis-server" && flag === "--dir" && next) {
        const d = resolvePath(next, here);
        if (d) add({ kind: "datadir", key: d });
      }

      // A path-shaped resource, bare or as a flag's `=value`.
      for (const p of eq > 0 ? [t.slice(eq + 1)] : [t]) {
        if (p.startsWith("-") || (p.includes("://") && !p.startsWith("unix://"))) continue;
        const cand = p.replace(/^unix:\/\//, "").replace(/[),]+$/, "");
        if (!isEnvFile(cand) && (text || (!isSqlite(cand) && !isSocket(cand)))) continue;
        const abs = resolvePath(cand, here);
        if (abs) add(pathClaim(abs));
      }
    }
    if (composeAt >= 0) add(composeClaim(toks, composeAt + 1, here));
  }
  return [...out.values()];
}

/**
 * Masks what a command would hand a reader: URL userinfo, secret-named values,
 * `-u user:pass`, an Authorization header or bearer token, `--password`, and
 * mysql's glued `-p<password>`.
 */
export function maskEvidence(s: string): string {
  const mysql = /\b(?:mysql|mariadb|mysqldump|mysqladmin)\b/.test(s);
  return s
    .replace(/(:\/\/)[^@\s/'"]*@/g, "$1…@")
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*=)\S+/gi, "$1…")
    .replace(/(\s(?:-u|--user)(?:=|\s+)?)[^\s:'"]*:[^\s'"]+/g, "$1…")
    .replace(/(authorization:\s*(?:(?:bearer|token|basic)\s+)?)[^\s'"]+/gi, "$1…")
    .replace(/(\bbearer\s+)(?!…)[^\s'"]+/gi, "$1…")
    .replace(/(--password(?:=|\s+))\S+/gi, "$1…")
    .replace(/(\s-p)(?=\S)(?!…)\S+/g, (m, p1) => (mysql ? `${p1}…` : m))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export interface SessionClaims {
  source_app: string;
  session_id: string;
  /** The checkout the session runs in. */
  root: string;
  claims: (Claim & { ts: number; via: CollisionParty["via"]; evidence: string })[];
}

/** Is `path` the checkout `root` or below it — by the platform's own separator. */
const within = (path: string, root: string) => {
  const r = relative(root, path);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
};

/**
 * The resources two or more checkouts share.
 *
 * Sessions in one checkout already share everything in it — two of them on one
 * port is a single tree, and the warning would fire on every resumed pair. So a
 * collision needs a second checkout, and an .env counts only when it is outside
 * the tree of the session that read it: a checkout's own .env is its own.
 */
export function findCollisions(sessions: SessionClaims[]): Collision[] {
  const byResource = new Map<string, { kind: CollisionKind; parties: Map<string, CollisionParty> }>();
  for (const s of sessions) {
    for (const c of s.claims) {
      if (c.kind === "env" && within(c.key, s.root)) continue;
      const id = `${c.kind} ${c.key}`;
      const r = byResource.get(id) ?? { kind: c.kind, parties: new Map() };
      byResource.set(id, r);
      const pk = `${s.source_app}\0${s.session_id}`;
      const prev = r.parties.get(pk);
      // One row per session, and the most direct evidence it has: a listener
      // outranks a command that mentions the port.
      if (!prev || (c.via === "listening" && prev.via !== "listening") || (prev.via === c.via && c.ts > prev.ts)) {
        r.parties.set(pk, { source_app: s.source_app, session_id: s.session_id, checkout: s.root, via: c.via, evidence: c.evidence, ts: c.ts });
      }
    }
  }
  const out: Collision[] = [];
  for (const [resource, r] of byResource) {
    const parties = [...r.parties.values()];
    if (new Set(parties.map((p) => p.checkout)).size < 2) continue;
    parties.sort((a, b) => b.ts - a.ts);
    out.push({ kind: r.kind, resource, parties });
  }
  return out.sort((a, b) => b.parties[0].ts - a.parties[0].ts);
}

/**
 * The checkout a directory belongs to: the nearest ancestor holding a `.git`,
 * or null when there is none.
 *
 * Not the directory itself as a fallback. A session in the home directory
 * would then own every dev server running anywhere below it, and pair up with
 * whichever agent in a real checkout curled that port.
 */
export function checkoutOf(dir: string, cache = new Map<string, string | null>()): string | null {
  const hit = cache.get(dir);
  if (hit !== undefined) return hit;
  let at = resolve(dir);
  let found: string | null = null;
  for (;;) {
    if (existsSync(resolve(at, ".git"))) { found = at; break; }
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  cache.set(dir, found);
  return found;
}

export interface Listener {
  port: number;
  addr: string;
  pid: number | null;
  proc: string | null;
  cwd: string | null;
}

/**
 * A listener source that loads at most once per `ttlMs`.
 *
 * Every open dashboard polls collisions, and each load is an `ss` plus a few
 * procfs reads per owned socket. One load serves every caller in the window,
 * concurrent ones included; a failed one is dropped rather than kept, and
 * reads as no listeners — the command half of the warning still stands.
 */
export function cachedListeners(
  load: () => Promise<Listener[]>,
  ttlMs: number,
  clock: () => number = Date.now,
): () => Promise<Listener[]> {
  let at = -Infinity;
  let value: Promise<Listener[]> | null = null;
  return () => {
    const t = clock();
    if (!value || t - at >= ttlMs) {
      at = t;
      const p: Promise<Listener[]> = load().catch(() => {
        if (value === p) value = null;
        return [];
      });
      value = p;
    }
    return value;
  };
}

/** Thirty seconds: a dev server that just bound shows up on the next poll or two. */
const listening = cachedListeners(async () => (await listPortsAsync()).ports, 30_000);

// Lowercase: OpenCode names its tools `bash` and `read`, Claude `Bash` and `Read`.
const FILE_TOOLS = new Set(["read", "edit", "write", "multiedit", "notebookedit"]);

/**
 * Collisions among the sessions live right now.
 *
 * Not scoped to the cockpit's project on purpose: the other party to a
 * collision is, more often than not, in a different project's checkout, and a
 * scope that hid it would hide the half you need.
 */
export async function getCollisions(
  now = Date.now(),
  listeners: () => Listener[] | Promise<Listener[]> = listening,
): Promise<Collision[]> {
  const since = now - COLLISION_WINDOW_MS;
  const rows = db
    .query<{ source_app: string; session_id: string; hook_event_type: string; tool_name: string | null; ts: number; cmd: string | null; path: string | null; cwd: string | null }, [number]>(
      `SELECT source_app, session_id, hook_event_type, tool_name, timestamp AS ts,
              json_extract(payload,'$.tool_input.command') AS cmd,
              COALESCE(json_extract(payload,'$.tool_input.file_path'), json_extract(payload,'$.tool_input.filePath')) AS path,
              COALESCE(json_extract(payload,'$.cwd'), json_extract(payload,'$.project_path')) AS cwd
       FROM events
       WHERE timestamp > ? AND hook_event_type IN ('PreToolUse','SessionEnd')
       ORDER BY timestamp`,
    )
    .all(since);

  const roots = new Map<string, string | null>();
  const bySession = new Map<string, SessionClaims & { cwd: string | null; ended: boolean }>();
  for (const r of rows) {
    const k = `${r.source_app}\0${r.session_id}`;
    let s = bySession.get(k);
    if (!s) {
      s = { source_app: r.source_app, session_id: r.session_id, root: "", claims: [], cwd: null, ended: false };
      bySession.set(k, s);
    }
    if (r.cwd) s.cwd = r.cwd;
    // Rows come oldest first, so this settles on the last word: an event after
    // a SessionEnd is a resumed session speaking again.
    s.ended = r.hook_event_type === "SessionEnd";
    if (r.hook_event_type !== "PreToolUse") continue;
    const tool = r.tool_name?.toLowerCase();
    if (tool === "bash" && r.cmd) {
      for (const c of claimsFromCommand(String(r.cmd), r.cwd)) {
        s.claims.push({ ...c, ts: r.ts, via: "command", evidence: maskEvidence(String(r.cmd)) });
      }
    } else if (tool && FILE_TOOLS.has(tool) && r.path) {
      for (const c of claimsFromPath(String(r.path))) {
        s.claims.push({ ...c, ts: r.ts, via: "file", evidence: `${r.tool_name} ${r.path}` });
      }
    }
  }

  // A session outside any checkout has no tree for a resource to be outside of.
  const live = [...bySession.values()].filter((s) => {
    if (s.ended || !s.cwd) return false;
    s.root = checkoutOf(s.cwd, roots) ?? "";
    return s.root !== "";
  });
  if (live.length < 2) return [];

  // A listening socket belongs to every live session in the checkout its
  // process runs in — the deepest one, when checkouts nest.
  for (const l of await listeners()) {
    if (!l.cwd || !portOk(l.port)) continue;
    let best = "";
    for (const s of live) if (within(l.cwd, s.root) && s.root.length > best.length) best = s.root;
    if (!best) continue;
    const evidence = `${l.proc ?? "process"}${l.pid ? ` (pid ${l.pid})` : ""} listening on ${l.addr}:${l.port}`;
    for (const s of live) if (s.root === best) s.claims.push({ kind: "port", key: String(l.port), ts: now, via: "listening", evidence });
  }

  return findCollisions(live);
}
