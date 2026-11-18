/*
 * One headless turn of a worker: the argv per engine, and the wrapper that
 * leaves the turn's answer on disk.
 *
 * A worker is one turn in a tmux window. On most engines that is a one-shot with
 * an exit code, so "done", "failed" and "died" are facts and not a guess from a
 * screen; Claude Code runs its own TUI there instead, so its turn ends on the
 * CLI's own transcript marker (`agents/tuiturn.ts`). The argv builders are the
 * chat panels' own where one exists (`codexArgs`, `hermesArgs`,
 * `antigravityArgs`); Claude Code's and OpenCode's are here, because the chat's
 * Claude turn carries chat-only flags.
 *
 * A headless worker cannot be steered inside a turn, only stopped; a follow-up
 * is a new turn that resumes the engine's session.
 *
 * OpenCode's turn is JSON, and a pane of JSON says nothing to the person
 * watching it: the wrapper tees it into `out` and pipes the tab through
 * `opencodeview.py`, which reads the events as lines. The tee comes first, so
 * the raw stream is on disk whether or not the reading worked. Only OpenCode
 * is read this way; the other engines' frames still go to the tab as written.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentProvider } from "../../../shared/agentKinds.ts";
import type { Envelope, Policy } from "../../../shared/orchestration.ts";
import type { WorkerRole } from "../../../shared/workerRoles.ts";
import { antigravityArgs } from "../antigravity.ts";
import { codexArgs } from "../codex.ts";
import { agentglassConfigDirs, realish } from "../config.ts";
import { stateDir } from "../childledger.ts";
import { hermesArgs } from "../hermes.ts";
import { redact } from "../agentprobe.ts";
import { spawnSyncAs } from "../loopwatch.ts";
import { recordOpenCodeTurn } from "../opencodeusage.ts";
import { hookRefusal } from "./hooks.ts";
import { BROWSER_READ_TOOLS, BROWSER_SERVER, COMMIT_SERVER, GH_SERVER, hasCommitDoor, DOORS_FOR_ROLE, browserMcpCommand, appSecretDirs, compileEnvelope, mcpDenyFor, sandboxHolds, unsandboxedBecause } from "./envelope.ts";
import viewScript from "./opencodeview.py" with { type: "file" };

export interface TurnSpec {
  engine: string;
  bin: string;
  model: string;
  role: WorkerRole;
  envelope: Envelope;
  limits: Policy["limits"];
  prompt: string;
  /** The worktree the turn runs in: the sandbox's writable root. */
  cwd: string;
  /** The turn's own folder, the one thing a read-only turn may still write. */
  runDir?: string;
  /** The engine's own session id, to continue it. */
  resume?: string;
  /** Claude only: the mode its turn starts in. Only a mode that never draws a
   *  dialog is valid here (see the comment at the switch's `claude` case) —
   *  `dontAsk` when absent, the shipped default. */
  permissionMode?: "dontAsk" | "bypassPermissions";
  /** Settings ▸ Orchestration ▸ Worker Unix sockets; absent is off, the sandbox's own default. */
  unixSockets?: "off" | "all";
  /** `workers.appDoors.*`: the app doors this project has opened to a worker's shell; absent is none, as the lock always was. */
  openDoors?: readonly string[];
  /** `workers.commands.*` a project switched off: denied on top of the floor. */
  closedCommands?: readonly string[];
  /** The project's `never` shell rules, compiled into the OpenCode lock. */
  /** Commands this project opened on purpose, for an engine that keeps the old floor. */
  legacyOpenCommands?: readonly string[];
  neverCommands?: { prefixes: readonly string[]; exact: readonly string[] };
  /** `workers.gitInternals`: the git paths that run code on the next git command (hooks, config, modules) are open to the shell. Absent is shut, as the sandbox always had them. */
  gitInternals?: boolean;
  /** `workers.unwalledEngines`: the person accepted that an engine with no read wall (Hermes) runs as a worker. Absent is refused. */
  unwalledEngines?: boolean;
  /** Claude only: `workers.projectSkills` (Settings ▸ Orchestration). On (the
   *  default) loads the project's own `.claude/skills` and `.claude/commands`
   *  alongside the person's; off keeps the turn to the person's own, as every
   *  turn ran before this field existed. */
  projectSkills?: boolean;
  /** Claude only: where `projectSkills` is staged from — the project's own
   *  root (`p.policyRoot`), never `cwd`. `cwd` is the turn's worktree, which
   *  for a reviewed checkout (an outside contributor's PR) is untrusted: a
   *  `.claude/skills/<lure>/SKILL.md` committed there must not be staged and
   *  loaded with `Skill` allowed. No staging at all when this is absent. */
  skillsRoot?: string;
  /** Claude only: the MCP servers `workers.mcpServers` (Settings ▸
   *  Orchestration) has switched on for this turn, resolved to their stored
   *  configuration. Empty (the default) gives the turn no server beyond the
   *  app's own browser door. */
  mcpServers?: { name: string; config: Record<string, unknown>; mode?: "readOnly" | "all" }[];
}

export type Turn =
  | { ok: true; argv: string[]; env: Record<string, string>; stdin: "none" | "prompt"; sessionId?: string; partly?: string;
      /** The engine runs its own TUI in the pane: its end is read from its
       *  transcript, not from its exit (`agents/tuiturn.ts`). */
      tui?: true;
      /** The engine's shell is not sandboxed (a lifted network or docker), in
       *  the same words the answer carries. */
      unsandboxed?: string }
  | { ok: false; error: string };

/** Whether this engine can run a worker headless at all, and if not, why. */
export function headlessRefusal(engine: string): string | null {
  const p = agentProvider(engine);
  if (!p) return `${engine} is not an engine this app knows`;
  if (!p.headless) return `${p.title} has no headless form this app knows, so it cannot run as a worker yet`;
  if (!p.envelope) return `what ${p.title} will refuse has not been measured, so it is not offered as a worker yet`;
  return null;
}

/**
 * What a TUI turn may run without asking anybody: the shell it is told to run
 * its checks in, the edit tools of a role that writes, the web tools when
 * the envelope lets it out, and the browser MCP tools of a role with that door.
 * It is a permission prompt's allow list, not the envelope: every `--settings`
 * deny rule outranks an entry here, so a denied command stays denied, and a
 * read-only role is never given an edit tool or an acting browser tool.
 */
export function allowedToolsFor(role: WorkerRole, e: Envelope): string[] {
  const readsOnly = role.readOnly || e.write === "none";
  return [
    "Bash", "Read", "Glob", "Grep",
    ...(!readsOnly ? ["Edit", "Write", "NotebookEdit"] : []),
    ...(e.network ? ["WebFetch", "WebSearch"] : []),
    ...(role.mayStartSubagents ? ["Agent", "Task"] : []),
    ...browserToolsFor(role, e),
  ];
}

/** The browser MCP tools a role may call: none without the door, every tool of
 *  the server for a role that acts, and the reading ones alone for a read-only
 *  role. The server itself is only loaded where the door is open
 *  (`mcpConfigFor`), so an entry here never names a server the turn lacks. */
function browserToolsFor(role: WorkerRole, e: Envelope): string[] {
  const gh = [`mcp__${GH_SERVER}`, ...(hasCommitDoor(role, e) ? [`mcp__${COMMIT_SERVER}`] : [])];
  if (!DOORS_FOR_ROLE[role.base ?? role.id]?.includes(BROWSER_SERVER)) return gh;
  const readsOnly = role.readOnly || e.write === "none";
  return [...gh, ...(readsOnly
    ? BROWSER_READ_TOOLS.map((t) => `mcp__${BROWSER_SERVER}__${t}`)
    : [`mcp__${BROWSER_SERVER}`])];
}

/**
 * The MCP servers a Claude worker is given, and only those: an `--mcp-config`
 * of this app's own browser server where the role has that door, plus every
 * server `chosen` names (`workers.mcpServers`, Settings ▸ Orchestration) —
 * nothing at all otherwise. With `--strict-mcp-config` beside it the CLI loads
 * no other server — not the person's user or project ones, not a checkout's
 * `.mcp.json` — so a `mcp__clickup__*` or `mcp__engram__*` allow rule in a
 * settings file names a server this turn never starts unless `chosen` named it.
 *
 * A `chosen` entry named `agentglass-browser` is dropped (and logged) rather
 * than let it overwrite the forced entry above: the browser door's command
 * is this file's own, never a person's stored config under that same name.
 */
export function mcpConfigFor(role: WorkerRole, chosen: readonly { name: string; config: Record<string, unknown> }[] = [], e?: { write?: string }): { mcpServers: Record<string, unknown> } {
  const browser = browserMcpCommand(role);
  const mcpServers: Record<string, unknown> = browser ? { [BROWSER_SERVER]: { command: browser } } : {};
  /* The read-only GitHub door (ghdoor.ts), for every role: the wall hides the
     keyring, and the app reads GitHub for the worker's own project only. */
  mcpServers[GH_SERVER] = { command: "agentglass-gh-mcp" };
  /* The commit door (ownBranchCommit.ts), builder roles only. It runs
     outside the sandbox and calls the app with the worker's own credential. */
  if (hasCommitDoor(role, e)) mcpServers[COMMIT_SERVER] = { command: "agentglass-commit-mcp" };
  for (const c of chosen) {
    if (c.name === BROWSER_SERVER || c.name === GH_SERVER || c.name === COMMIT_SERVER) { console.warn(JSON.stringify({ event: "worker.mcp.reserved-name-skipped", name: c.name })); continue; }
    mcpServers[c.name] = c.config;
  }
  return { mcpServers };
}

/** `--mcp-config`'s own value: the JSON inline when `chosen` is empty (the
 *  app's own server names no secret), or a file written into the turn's own
 *  folder once a person's configured server is in play — its `env` can carry
 *  a token, and an argv is readable by anything that lists this process.
 *  Without a `runDir` to write that file into, `chosen` is dropped instead of
 *  put inline: only the app's own server (no secret) ever rides argv. */
function mcpConfigArg(role: WorkerRole, chosen: readonly { name: string; config: Record<string, unknown> }[], runDir?: string, e?: { write?: string }): string {
  if (!runDir) return JSON.stringify(mcpConfigFor(role, [], e));
  const path = join(runDir, "mcp-config.json");
  // A file an earlier turn wrote may hold a token this turn was not given,
  // and the run dir is the worker's to read: it goes whenever this turn
  // does not write its own.
  if (!chosen.length) { rmSync(path, { recursive: true, force: true }); return JSON.stringify(mcpConfigFor(role, chosen, e)); }
  mkdirSync(runDir, { recursive: true });
  writeFreshFile(path, JSON.stringify(mcpConfigFor(role, chosen, e)));
  return path;
}

/** Overwrite `path` with content only this turn should ever hold (a secret
 *  can ride in it): whatever sits there first is removed, link included —
 *  the run dir is a worker write root, and a symlink planted in an earlier
 *  turn must never be followed into writing a secret wherever it points —
 *  then the file is made fresh, `wx` so the write refuses a path that
 *  reappeared between the two calls instead of following it either. */
function writeFreshFile(path: string, data: string): void {
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, data, { mode: 0o600, flag: "wx" });
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** `cwd` plus a `.git` file's `gitdir:` text, resolved the way the kernel
 *  would: each name is followed through a symlink before a `..` after it is
 *  applied, so a text like `lnk/../x` where `lnk` is a symlink names what it
 *  really points at. `path.resolve` collapses `lnk/..` to nothing first,
 *  lexically, before any symlink is looked at, and names a different — and
 *  possibly wide open — directory. */
function realGitdirPath(cwd: string, text: string): string {
  const realOf = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  let cur = isAbsolute(text) ? sep : realOf(cwd);
  for (const seg of text.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { cur = dirname(cur); continue; }
    const next = join(cur, seg);
    cur = isLink(next) ? realOf(next) : next;
  }
  return cur;
}

/** The files in a git dir that run, or decide what runs, on the next git
 *  command: a hook, and the two configs a repo can set `core.hooksPath` or a
 *  `core.*` command in (`config.worktree` is read when the repo opts into
 *  `extensions.worktreeConfig`). Only what is there: a deny of a path that does
 *  not exist is not a bind. */
const GIT_CODE = ["hooks", "config", "config.worktree"] as const;

/** `at` sits inside `root`, lexically. */
const insideOf = (root: string, at: string): boolean => resolve(at).startsWith(resolve(root) + sep);

/** `at`, then each directory above it while it is inside `root`; `at` alone
 *  when it is outside. A link on that path is one the worker could have made. */
function pathIn(root: string, at: string): string[] {
  const out: string[] = [];
  for (let p = at; insideOf(root, p); p = dirname(p)) out.push(p);
  return out.length ? out : [at];
}

/** A path's contents, read only if it is a regular file no bigger than
 *  `MAX_REGULAR_FILE_BYTES`: open and fstat the same fd, so nothing the
 *  worker swaps the path for between two syscalls can be read. `O_NONBLOCK`
 *  makes opening (and, for a FIFO, the read) return instead of hanging; a
 *  FIFO fails `isFile()` and is never read. Missing, denied, a FIFO, a
 *  socket, a symlink (`O_NOFOLLOW`), over the size cap, or anything else
 *  that is not a plain file comes back as `null`, same as "absent" — a
 *  worker-writable path (`.gitmodules`, a settings file, a hook script) is
 *  never read in full just because it grew past what this app expects. */
const MAX_REGULAR_FILE_BYTES = 1024 * 1024;

export function readRegularFileSync(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_REGULAR_FILE_BYTES) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** `raw` with a leading `~` or `~/` expanded to the home dir, the way git
 *  expands `core.hooksPath` before using it, or `~user/...` expanded the same
 *  way when `user` is the account this process runs as. Git would resolve
 *  `~user/...` for any other user too (via that user's passwd entry), but
 *  this process has no cheap, sandboxed way to look that up — so any other
 *  `~user` form comes back `null` rather than guessing or passing the text
 *  through unexpanded, which is what let a real `core.hooksPath = ~build/hooks`
 *  slip past `hooksPathDeny` entirely. A value with no leading `~` is
 *  returned unchanged. */
function expandTilde(raw: string): string | null {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  const other = /^~([^/]+)(\/.*)?$/.exec(raw);
  if (other) return other[1] === userInfo().username ? join(homedir(), (other[2] ?? "").slice(1)) : null;
  return raw;
}

/** A git-config value as git reads it: the text between the quotes when it is
 *  quoted, and the text before a trailing comment otherwise. */
function configValue(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('"')) {
    const cut = text.search(/\s[#;]/);
    return (cut < 0 ? text : text.slice(0, cut)).trim();
  }
  let out = "";
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"') return out;
    if (c === "\\" && i + 1 < text.length) { i += 1; out += text[i]!; continue; }
    out += c;
  }
  return out;
}

/** The name-to-path mapping a checkout's `.gitmodules` declares. A submodule's
 *  name need not be its checkout path (`--name orbit-lib` at `vendor/lib`), and
 *  git keeps the module dir under the name while the boundary file is at the
 *  path. Missing or unreadable leaves the map empty, and the name is the path
 *  as git had it before a `.gitmodules` entry said otherwise. */
function submodulePaths(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  try {
    // `file` sits inside the tree the worker writes: `readRegularFileSync`
    // opens and fstats the same fd, so a FIFO swapped in after a path check
    // cannot block this process's sync read.
    const text = readRegularFileSync(file);
    if (text === null) return out;
    for (const line of text.split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#") || text.startsWith(";")) continue;
      // Git allows a comment after the closing bracket, which a line-anchored
      // match would take for another section, quotes a name that holds one
      // (`[submodule "a\"b"]`), and reads a section and a key without regard to
      // case.
      const section = /^\[submodule\s+(.*)\]/i.exec(text);
      if (section) { name = configValue(section[1]!) || null; continue; }
      if (text.startsWith("[")) { name = null; continue; }
      const path = /^path\s*=\s*(.*)$/i.exec(text);
      if (name && path) out.set(name, configValue(path[1]!));
    }
  } catch { /* no .gitmodules */ }
  return out;
}

/** A declared submodule path relative to `base`, when it is relative and stays
 *  under it; null otherwise. `.gitmodules` sits in the tree the worker writes,
 *  so `path = ../outside` would plant a git dir beside the project, `path = .`
 *  would deny the whole metadata dir, and `path = /etc` would reach the disk. */
function insideTree(base: string, p: string): string | null {
  if (!p || isAbsolute(p)) return null;
  return resolve(base, p).startsWith(resolve(base) + sep) ? p : null;
}

/** The checkout paths git's index pins as gitlinks (mode 160000), read before
 *  the turn: the index is git's own record, so a `.gitmodules` a turn deletes
 *  cannot hide a submodule. Both paths are named, so git cannot walk up to a
 *  checkout that holds the same directory, and it starts from the temp folder
 *  with the person's config off because the checkout is the worker's. */
function gitlinkPaths(tree: string, gitdir: string): string[] {
  try {
    // The index is the worker's own file: a FIFO there blocks forever on the
    // read `git` does under this spawn, which blocks this process's whole
    // event loop (it is sync). Skip a non-regular one, and cap the rest.
    const index = join(gitdir, "index");
    if (existsSync(index) && !lstatSync(index).isFile()) return [];
    const p = spawnSyncAs("git ls-files (worker tree)",
      ["git", "-c", "credential.helper=", "-c", "core.fsmonitor=false", "--git-dir", gitdir, "--work-tree", tree, "ls-files", "--stage", "-z"],
      {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
        timeout: 5000, killSignal: "SIGKILL",
      },
    );
    if (p.exitCode !== 0) return [];
    return p.stdout.toString("utf8").split("\0")
      .filter((e) => e.startsWith("160000 "))
      .map((e) => e.slice(e.indexOf("\t") + 1))
      .filter(Boolean);
  } catch { return []; }
}

/** What git says a checkout's submodules are, before a turn can touch it: the
 *  checkout the worker may write, and where git keeps that module's git dir. */
interface ModuleCheckout { tree: string; gitdir: string }

/** The working-tree `.git` files of this checkout's submodules: a plain file in
 *  the writable root that names the module's git dir, which the worker writes to
 *  name a dir it made inside the tree, so the person's next command there runs
 *  that dir's hooks. One that is missing gets the line git itself writes.
 *
 *  The paths are the union of what git records before the turn — the index's
 *  gitlinks, the `.gitmodules` paths inside the tree, and each entry's name —
 *  never the layout of `.git/modules`. Only a pinned path is made: a
 *  `.gitmodules` line over an ordinary directory made the next `git add` record
 *  a nested repository. A checkout that lands outside the tree names nothing. */
function moduleDotGitFiles(cwd: string, dotGit: string, writes: boolean): string[] {
  let root: string;
  try { root = realpathSync(cwd); } catch { return []; }
  const out = new Set<string>();
  const checkouts: ModuleCheckout[] = [{ tree: cwd, gitdir: dotGit }];
  const seen = new Set<string>([dotGit]);
  for (let i = 0; i < checkouts.length; i += 1) {
    const { tree, gitdir } = checkouts[i]!;
    const declared = submodulePaths(join(tree, ".gitmodules"));
    const pinned = new Set(gitlinkPaths(tree, gitdir));
    const wanted = new Map<string, { name: string; write: boolean }>();
    const add = (p: string | null, name: string): void => {
      if (!p) return;
      const at = wanted.get(p);
      if (at) at.write ||= pinned.has(p);
      else wanted.set(p, { name, write: pinned.has(p) });
    };
    for (const [name, path] of declared) { add(name, name); add(insideTree(tree, path), name); }
    for (const p of pinned) add(p, p);
    for (const [p, { name, write }] of wanted) {
      const dir = join(tree, p);
      let real: string;
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        real = realpathSync(dir);
      } catch { continue; }
      if (!real.startsWith(root + sep)) continue;
      const at = join(dir, ".git");
      if (writes && write && !lstatSync(at, { throwIfNoEntry: false })) {
        try { writeFileSync(at, `gitdir: ${relative(dir, join(gitdir, "modules", name))}\n`, { flag: "wx" }); } catch { /* not ours to make */ }
      }
      // Only what is there: a deny of a path that does not exist fails the sandbox.
      if (existsSync(at)) out.add(at);
      // A submodule's own submodules are under its git dir, one level per visit.
      const nested = join(gitdir, "modules", name);
      if (existsSync(nested) && !seen.has(nested)) {
        seen.add(nested);
        checkouts.push({ tree: dir, gitdir: nested });
      }
    }
  }
  return [...out];
}

/** The modules dir of a git dir, shut whole: a worker turn never needs to write
 *  a submodule's git dir, and which entry under it is a module and which a
 *  container is decided by files the worker writes. Made first when it is
 *  missing, so the deny has a path to bind — inside the writable root by
 *  default, or wherever a caller already knows `gitdir` is one of this turn's
 *  own allow roots (a linked worktree's own gitdir, outside `cwd`). */
/** The directory `core.hooksPath` names, read from the config git would
 *  actually use — not from the file text, which this app never lets a worker
 *  change, but the value is effective from before the worker ever saw the
 *  repo (husky, pre-commit, lefthook all set it once, outside any sandbox).
 *  `GIT_CODE`'s `hooks` deny only shuts the default `<gitdir>/hooks`; a repo
 *  that points `core.hooksPath` anywhere else is unguarded without this. Git
 *  resolves a relative value against `cwd` (the worktree root) for a non-bare
 *  repo, so that is what this resolves it against too. Unset or unreadable
 *  (timeout, no git, no such key) denies nothing, same as a missing path. A
 *  value `expandTilde` cannot resolve (`~otheruser/...`) could be any other
 *  account's home, so this fails closed onto the parent directory all of
 *  them share (`/home` on a typical box) rather than denying nothing. */
function hooksPathDir(cwd: string, gitdir: string): string | null {
  try {
    const p = spawnSyncAs("git config (worker hooksPath)",
      ["git", "-c", "credential.helper=", "--git-dir", gitdir, "--work-tree", cwd, "config", "--get", "core.hooksPath"],
      {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
        timeout: 5000, killSignal: "SIGKILL",
      },
    );
    if (p.exitCode !== 0) return null;
    const raw = p.stdout.toString("utf8").trim();
    if (!raw) return null;
    const expanded = expandTilde(raw);
    return resolve(cwd, expanded ?? dirname(homedir()));
  } catch { return null; }
}

/** `hooksPathDir`'s directory, denied when it is there: inside the worktree
 *  (a worker-writable tracked dir such as `.husky/`) or anywhere else that is
 *  not read-only, since denying a path this app cannot write costs nothing. */
function hooksPathDeny(cwd: string, gitdir: string): string[] {
  const at = hooksPathDir(cwd, gitdir);
  return at && existsSync(at) ? [at] : [];
}

function modulesDeny(cwd: string, gitdir: string, writes: boolean, gitdirWritable = insideOf(cwd, gitdir)): string[] {
  const modules = join(gitdir, "modules");
  if (writes && gitdirWritable) {
    try { mkdirSync(modules, { recursive: true }); } catch { /* not ours to make */ }
  }
  return existsSync(modules) ? [modules] : [];
}

/** The project's own tree: `.git` is a directory inside the writable root, so
 *  the sandbox already opens it. What is shut is what runs code on the next git
 *  command in that tree — a hook, or a `core.*` command in the config — plus
 *  `refs` and `logs` for a role without `commit`, because `git branch -f` and
 *  `git update-ref` are not on the prefix lock. `index`, `HEAD` and `objects`
 *  stay open so `git add` and a commit still work.
 *  Ceiling: only the paths that are there are denied (a bind of a missing one
 *  fails the sandbox), so a git directory with no `refs` yet can still grow
 *  one. `hooks` is made first when it is missing — an empty template leaves
 *  none, and a hook written into it runs on the next unsandboxed commit — and
 *  so is `worktrees`, whose sibling entries carry per-tree configs this
 *  sandbox cannot otherwise name, and `packed-refs` for a role that may not
 *  commit, because a repo never packed has none and `git gc` moves the branch
 *  refs there, and so is `config.worktree`, because the repo's opt-in to it is
 *  in the denied config and the file itself is the worker's to create. A `.git`
 *  that is a link is refused before either is made: the link's target is not
 *  this tree. A submodule's git dir is inside this tree and git reads its hooks
 *  and config there, so `.git/modules` is shut whole rather than entry by entry:
 *  a worker turn never needs to write a submodule's git dir. */
function ownGitRoots(cwd: string, commit: boolean, writes: boolean, openCode = false): { allow: string[]; deny: string[] } {
  const dotGit = join(cwd, ".git");
  // `worktrees` is shut as a whole: a linked worktree's per-tree config is read
  // by git inside that worktree, which this sandbox does not cover, and a plain
  // checkout gets no walk of the metadata dir to name it entry by entry.
  const shut = [...(openCode ? [] : GIT_CODE), ...(commit ? [] : ["refs", "logs"]), "packed-refs", "worktrees"];
  if (isLink(dotGit)) return { allow: [], deny: [dotGit] };
  // A turn that may not write has the whole tree in its deny list, so none of
  // these four is made for it: they exist to give that list a path to bind.
  if (writes) {
    if (!openCode) try { mkdirSync(join(dotGit, "hooks"), { recursive: true }); } catch { /* not ours to make */ }
    try { mkdirSync(join(dotGit, "worktrees"), { recursive: true }); } catch { /* not ours to make */ }
    // `config.worktree` is read when the repo opts into `extensions.worktreeConfig`,
    // and that switch sits in the denied `config`: the file itself is the worker's
    // to create, and its hooks-path key names a directory the worker writes.
    if (!openCode) makeEmptyFile(join(dotGit, "config.worktree"));
    if (!commit) makeEmptyFile(join(dotGit, "packed-refs"));
  }
  return {
    allow: [],
    deny: [
      ...shut.map((p) => join(dotGit, p)).filter(existsSync),
      ...(openCode ? [] : [...modulesDeny(cwd, dotGit, writes), ...moduleDotGitFiles(cwd, dotGit, writes), ...hooksPathDeny(cwd, dotGit)]),
    ],
  };
}

/** The empty read-only files Claude Code's own sandbox leaves in a git dir.
 *  Its deny list names `<gitdir>/config.lock` and `config.worktree.lock`, and
 *  bubblewrap creates a missing mount point as an empty 0444 file on the host.
 *  That file blocks every `git config` until it is removed (measured, 2.1.319).
 *  Nothing in `denyWrite` can stop the CLI naming them, so the file is swept:
 *  only an empty file with no write bit, which a real git lock never is. */
export function sweepMountPoints(cwd: string): void {
  const dirs = new Set<string>();
  try {
    const dotGit = join(cwd, ".git");
    if (lstatSync(dotGit).isDirectory()) dirs.add(dotGit);
    else {
      const gitdir = realGitdirPath(cwd, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))![1]!.trim());
      dirs.add(gitdir);
      dirs.add(resolve(gitdir, "../.."));
    }
  } catch { return; }
  for (const d of dirs) for (const n of ["config.lock", "config.worktree.lock"]) {
    try {
      const f = join(d, n);
      const st = lstatSync(f);
      if (st.isFile() && st.size === 0 && (st.mode & 0o222) === 0) rmSync(f);
    } catch { /* not there */ }
  }
}

/** An empty file where it is missing, so a deny of that path has something to
 *  bind to: the deny list drops a path that does not exist. `wx` so a real file
 *  already there is never truncated. */
function makeEmptyFile(p: string): void {
  try { writeFileSync(p, "", { flag: "wx" }); } catch { /* already there, or not ours to make */ }
}

/**
 * The git directories git writes outside a linked worktree: its `.git` file
 * points at the main repo's `.git/worktrees/<name>`, and a commit puts objects
 * under the common `.git/objects` and moves the branch ref there. Without them
 * a sandboxed writable role granted `commit` cannot commit at all. A plain
 * checkout keeps its `.git` inside `cwd`, and gets `ownGitRoots` instead.
 *
 * `.git` is a file inside the one tree a writing role may write, so its text is
 * the worker's, not git's, by the time this reads it: it is denied like the rest
 * and its `gitdir` is only an allow path once the `commondir` under it reads —
 * a `.git` saying `gitdir: /home/orbit` allows nothing — and once the `gitdir`
 * back-pointer git leaves there names this worktree, so naming another one's is
 * no allow root.
 *
 * `commondir` is the worker's too (it sits in `gitdir`, which is allowed), and
 * both lists are built from it: pointed at a directory that does not exist the
 * read throws and the deny list kept only `cwd/.git`, so the hook the deny
 * exists to close was open again. git writes exactly `../..` there, so any
 * other text is not git's and allows nothing.
 *
 * Claude Code opens the whole common `.git` of a linked worktree by itself,
 * whatever `allowWrite` says. Measured with a real turn: with only the
 * worktree, its gitdir and `objects` allowed, `git update-ref refs/heads/main`
 * moved main and a write to `.git/hooks/pre-commit` landed — a hook the next
 * unsandboxed commit runs. So the rest of the common `.git` goes into
 * `denyWrite`, which the same turn showed does hold: everything except
 * `objects` and this worktree's own gitdir, plus `refs`, `logs` and
 * `packed-refs` for EVERY role, `commit` or not: a worker moves only its own
 * branch, and it does that through the server (`ownBranchCommit.ts`).
 *
 * `packed-refs` in the common `.git` is denied like the rest of the entries
 * that are not open, and made empty first when the
 * repo was never packed, for the same reason as `hooks`: the deny list drops a
 * path that is not there, and a real turn appended to it.
 * A bind cannot open one ref file and its `.lock` (the lock does not exist to
 * bind) without opening `refs/heads`, so no ref path is opened at all.
 * Ceiling: a plain checkout's own `.git` is inside the writable root and keeps
 * its refs. And a `commondir` that is missing or not `../..` returns before
 * any of this, so no `packed-refs` is made in that case.
 */
export function gitWriteRoots(cwd: string, commit: boolean, writes: boolean, openCode = false): { allow: string[]; deny: string[] } {
  const dotGit = join(cwd, ".git");
  let gitdir: string;
  try {
    const dotGitText = readRegularFileSync(dotGit);
    if (dotGitText === null) return ownGitRoots(cwd, commit, writes, openCode);
    const m = /^gitdir:\s*(.+)$/.exec(dotGitText.trim());
    if (!m) return { allow: [], deny: [dotGit] };
    gitdir = realGitdirPath(cwd, m[1]!);
  } catch { return { allow: [], deny: [] }; }
  let common: string;
  try {
    const commondirText = readRegularFileSync(join(gitdir, "commondir"));
    if (commondirText === null) throw new Error("no commondir");
    common = resolve(gitdir, commondirText.trim());
    if (common !== resolve(gitdir, "../..")) return { allow: [], deny: [dotGit, join(gitdir, "commondir")] };
  } catch {
    // Not a linked worktree of anything this can check: allow nothing, and shut
    // the file that said so and the code of the git dir behind it — a separate
    // git dir (`git init --separate-git-dir`) keeps its hooks and config there,
    // and its submodules keep theirs one directory down.
    // `config.worktree` is only made inside the tree: the directory is the text
    // of a `.git` file the worker writes, and pointing it at a real repository
    // elsewhere made this app create a file in that repository.
    // Ceiling: a hooks directory the git dir does not have yet is not named.
    if (!openCode && insideOf(cwd, gitdir)) makeEmptyFile(join(gitdir, "config.worktree"));
    return {
      allow: [],
      deny: [
        dotGit,
        ...(openCode ? [] : [
          ...GIT_CODE.map((n) => join(gitdir, n)).filter(existsSync),
          ...modulesDeny(cwd, gitdir, writes),
          ...moduleDotGitFiles(cwd, gitdir, writes),
          ...hooksPathDeny(cwd, gitdir),
        ]),
      ],
    };
  }
  /* git writes `<gitdir>/gitdir` holding the absolute path of the worktree's
     own `.git`. Without it a `.git` file naming ANOTHER worktree's gitdir —
     whose `commondir` reads `../..` — made that repo's gitdir an allow root,
     and a missing or relative one left the gitdir unchecked: both are closed. */
  const backPointer = join(gitdir, "gitdir");
  // Same FIFO class as the index and `.gitmodules`: `gitdir` sits in a
  // committing turn's own allow root, so a worker can swap it for one.
  // `readRegularFileSync` opens and fstats the same fd to close that race.
  const backRaw = readRegularFileSync(backPointer);
  if (backRaw === null) return { allow: [], deny: [dotGit, gitdir] };
  const back = backRaw.trim();
  const real = (p: string): string => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };
  if (!isAbsolute(back) || real(back) !== real(dotGit)) return { allow: [], deny: [dotGit, gitdir] };
  // Only `objects` (content-addressed, append-only) is open in the common dir.
  // `refs`, `logs` and `packed-refs` are shut for EVERY role, `commit` or not: a
  // sandbox bind cannot open one ref file and its `.lock` without opening the
  // `refs/heads` directory, and that directory would let a worker move `main` or
  // delete another branch. A committing role moves its OWN branch through the
  // server (the `commit` tool of `agentglass-commit-mcp`, server/src/ownBranchCommit.ts).
  const open = new Set(["objects"]);
  makeEmptyFile(join(common, "packed-refs"));
  // Only what is there: a bind of a path that does not exist fails the sandbox.
  const allow = [gitdir, ...[...open].map((d) => join(common, d)).filter(existsSync)];
  // The gitdir is an allow root, and git reads a per-tree config there too:
  // `core.hooksPath` in it names the directory a hook runs from. Like the plain
  // checkout's, it is made empty first, because the worker can create it. Not
  // gated on `objects` like `codeIn`: a linked worktree's own gitdir has none,
  // and this one is already proven by its `commondir` and back-pointer.
  const worktreeConfig = join(gitdir, "config.worktree");
  if (!openCode) makeEmptyFile(worktreeConfig);
  const deny: string[] = [dotGit, join(gitdir, "commondir"), ...(openCode ? [] : [worktreeConfig]), backPointer];
  try {
    for (const e of readdirSync(common)) {
      if (open.has(e)) continue;
      // A `*.lock` is a git process mid-write in the main repo (`git config` makes
      // `config.lock`). Naming it makes the sandbox mount over it, and the empty
      // read-only mount point stays behind once git renames the lock away.
      if (e.endsWith(".lock")) continue;
      if (openCode && [...GIT_CODE, "modules"].includes(e)) continue;
      if (e !== "worktrees") { deny.push(join(common, e)); continue; }
      for (const w of readdirSync(join(common, e))) if (join(common, e, w) !== gitdir) deny.push(join(common, e, w));
    }
  } catch { /* an unreadable common dir: nothing more to deny than the CLI already holds */ }
  // A linked worktree keeps its own submodules' git dirs under its own gitdir
  // (`<common>/worktrees/<id>/modules/<name>`), not under `<common>/modules`:
  // that is inside the `gitdir` allow root above, so it is shut the same way
  // `ownGitRoots` shuts a plain checkout's. `gitdir` is already proven to be
  // this worktree's own, so the mkdir below is into an allow root, not `cwd`.
  if (!openCode) deny.push(...modulesDeny(cwd, gitdir, writes, true), ...moduleDotGitFiles(cwd, gitdir, writes), ...hooksPathDeny(cwd, gitdir));
  return { allow, deny };
}

/** The sentence a turn is refused with when the tree it would write has a `.git`
 *  or `.claude` that is a link, or "".
 *
 *  A link is not the tree's own: this file makes `hooks` and `packed-refs`
 *  inside `.git`, and `.claude` itself, at turn start, so they landed wherever
 *  the last turn pointed the link and the deny named the link, not the place.
 *  The turn asks before the sandbox is built, because that is where it writes. */
export function linkedTreeRefusal(role: WorkerRole, e: Envelope, cwd: string): string {
  if (!sandboxHolds(role, e)) return "";
  const writes = !role.readOnly && e.write !== "none";
  // `.git` is read for every sandboxed turn, which makes `hooks` there even for
  // a read-only role; `.claude` only where the turn is allowed to write.
  for (const name of writes ? [".git", ".claude"] : [".git"]) {
    const at = join(cwd, name);
    if (isLink(at)) return `refused: ${at} is a symbolic link, and a turn that writes under it writes wherever it points`;
  }
  return linkedModulesRefusal(cwd);
}

/** The git dirs this checkout keeps its submodule git dirs in: the one `.git`
 *  is or names, and the common one behind a linked worktree, where a linked
 *  worktree's submodules live. Empty when `.git` names nothing readable. */
function gitDirsIn(cwd: string): string[] {
  const dotGit = join(cwd, ".git");
  let gitdir: string;
  try {
    if (lstatSync(dotGit).isDirectory()) return [dotGit];
    const dotGitText = readRegularFileSync(dotGit);
    if (dotGitText === null) return [];
    const m = /^gitdir:\s*(.+)$/.exec(dotGitText.trim());
    if (!m) return [];
    gitdir = realGitdirPath(cwd, m[1]!);
  } catch { return []; }
  try {
    const commondirText = readRegularFileSync(join(gitdir, "commondir"));
    if (commondirText === null) return [gitdir];
    return [gitdir, resolve(gitdir, commondirText.trim())];
  } catch { return [gitdir]; }
}

/** The sentence a turn is refused with when a link stands where a modules dir
 *  would be, or on the way there inside the tree, or "".
 *
 *  That dir is shut whole, and a deny on a link holds the link and not what it
 *  points at. A worker turn never writes a submodule's git dir, so refusing
 *  costs it nothing. */
function linkedModulesRefusal(cwd: string): string {
  for (const gitdir of gitDirsIn(cwd)) {
    for (const p of pathIn(cwd, join(gitdir, "modules"))) {
      if (isLink(p)) return `refused: ${p} is a symbolic link, and a turn that writes under it writes wherever it points`;
    }
  }
  return "";
}

const realPath = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/** The interpreters a hook command may start, by bare name only: a path to one
 *  is a file of the worker's, a flag makes it load a file of the worker's, and
 *  a `NAME=value` word before it is a command string the worker wrote. */
const HOOK_INTERPRETERS = new Set(["python3", "python", "bash", "sh", "node"]);

/** The one fallback spelling of the checkout root a team's settings use, taken
 *  as `$CLAUDE_PROJECT_DIR` itself. Matched as this exact text, nothing looser:
 *  the CLI sets the variable for every hook, and when it is unset the fallback
 *  names the top of the same checkout, so both resolve to the same `.claude/`.
 *  Without it the allowlist would drop a hook that a team relies on. */
const PROJECT_DIR_FALLBACK = "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}";

/** The prefixes a script path may carry, spelled out in full: anything else in
 *  front of `.claude/` is text the shell would expand, not this checkout. */
const HOOK_PREFIXES = ["$CLAUDE_PROJECT_DIR/", "${CLAUDE_PROJECT_DIR}/", `${PROJECT_DIR_FALLBACK}/`];

/** One path segment under `.claude`. Letters, digits, `_`, `.` and `-`: no
 *  space, no quote, no operator, no newline. */
const HOOK_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** The `.claude/...` text of a hook command when the WHOLE string, trimmed, is
 *  one of the three shapes the app forwards — `INTERP SCRIPT`,
 *  `INTERP "SCRIPT"` with the interpreter a bare name, or `SCRIPT` alone — and
 *  null otherwise. Nothing is parsed out of a longer line: a flag, a second
 *  argument, an assignment, a newline, a tab, an operator or a quote that
 *  closes early is not one of the shapes. */
function hookSource(raw: string): string | null {
  const command = raw.trim();
  const alone = claudeScript(command);
  if (alone) return alone;
  const space = command.indexOf(" ");
  if (space < 0 || !HOOK_INTERPRETERS.has(command.slice(0, space))) return null;
  const rest = command.slice(space + 1);
  const quoted = rest.length > 1 && rest.startsWith('"') && rest.endsWith('"') ? rest.slice(1, -1) : null;
  return claudeScript(rest) ?? (quoted === null ? null : claudeScript(quoted));
}

/** The `.claude/...` part of `text` when the whole of it is one, or null.
 *  `.` and `..` are not segments: `resolve` would walk them out of `.claude`
 *  while the shell ran the file they name. */
function claudeScript(text: string): string | null {
  const prefix = HOOK_PREFIXES.find((p) => text.startsWith(p)) ?? "";
  const rest = text.slice(prefix.length);
  if (!rest.startsWith(".claude/")) return null;
  for (const seg of rest.slice(".claude/".length).split("/")) {
    if (!HOOK_SEGMENT.test(seg) || seg === "." || seg === "..") return null;
  }
  return rest;
}

/** The file a hook command runs, when that file is inside the checkout's
 *  `.claude/`, or null.
 *
 *  `.claude` is the one directory the turn makes and the sandbox denies, so a
 *  script there is the only file a project hook can name that the worker cannot
 *  rewrite. The command has to be one of the three shapes `hookSource` reads,
 *  the file has to be there, and no directory on the way to it — nor the file
 *  itself — may be a link: the shell follows a link again at run time, after
 *  the worker has replaced it with its own script. */
function hookScript(cwd: string, raw: string): string | null {
  const source = hookSource(raw);
  if (!source) return null;
  let at = resolve(cwd);
  for (const seg of source.split("/")) {
    at = join(at, seg);
    if (isLink(at) || !existsSync(at)) return null;
  }
  // `readRegularFileSync` opens and fstats the same fd, closing the gap a
  // separate `lstatSync` then a later read would leave between "it was a
  // file" and "it still is": the same FIFO-swap TOCTOU this commit closed
  // for `.gitmodules` and the gitdir back-pointer.
  if (readRegularFileSync(at) === null) return null;
  const claude = realPath(join(cwd, ".claude"));
  return realPath(at).startsWith(claude + sep) ? at : null;
}

/** One hook matcher group, cut to its commands that run a file in `.claude/`;
 *  null when none is left. Only `matcher`, `type`, `command` and `timeout` are
 *  copied: the rest of the group is the checkout's. A command-shaped hook that
 *  is dropped is logged, because a team's guard that silently stops running is
 *  a policy that silently stopped. */
/** A project hook this turn cannot forward, and why. */
export type LostHook = { event: string; command: string };

/** Refusal text when a project PreToolUse hook would be dropped, or null. A worker never runs without the project's hooks. */
export function droppedHookRefusal(lost: readonly LostHook[]): string | null {
  const pre = lost.filter((l) => l.event === "PreToolUse");
  if (!pre.length) return null;
  const lines = pre.map((l) => `"${l.command}" (it does not run a plain script file inside .claude/, so the worker could change what it runs)`);
  return `A worker must not start without this project's PreToolUse hooks, and these cannot be forwarded: ${lines.join("; ")}. To change it: move the script into .claude/hooks/ and call it from there.`;
}

function keepGroup(cwd: string, event: string, group: unknown, lost: LostHook[]): Record<string, unknown> | null {
  if (!group || typeof group !== "object") return null;
  const g = group as { matcher?: unknown; hooks?: unknown };
  if (!Array.isArray(g.hooks)) return null;
  const kept: Record<string, unknown>[] = [];
  for (const h of g.hooks) {
    if (!h || typeof h !== "object") continue;
    const e = h as { type?: unknown; command?: unknown; timeout?: unknown };
    if (e.type !== "command" || typeof e.command !== "string") continue;
    const script = hookScript(cwd, e.command);
    if (!script) {
      lost.push({ event, command: redact(e.command) });
      // `redact`: a local settings file is where a machine's own values live,
      // and the command can carry one as an argument.
      console.warn(JSON.stringify({ event: "worker.hook.dropped", hook: event, command: redact(e.command), cwd }));
      continue;
    }
    kept.push({ type: "command", command: e.command, ...(typeof e.timeout === "number" ? { timeout: e.timeout } : {}) });
  }
  if (!kept.length) return null;
  return { ...(typeof g.matcher === "string" ? { matcher: g.matcher } : {}), hooks: kept };
}

/** What keeps the forwarded hooks' files out of the editing tools on a turn
 *  with no sandbox. The shell is held only by the prefix lock there. */
const CLAUDE_DIR_EDITS = ["Edit(.claude/**)", "Write(.claude/**)", "NotebookEdit(.claude/**)"];

/** One settings file's JSON, or null when it is missing, is a link, or lands
 *  outside `.claude`. `readFileSync` follows a link and the deny names only
 *  `.claude`: a committed `settings.json` that is `../notes.json` is a file the
 *  worker writes, and its text becomes the next turn's hooks. */
function settingsFile(cwd: string, name: string): unknown {
  const at = join(cwd, ".claude", name);
  try {
    const claude = realPath(join(cwd, ".claude"));
    if (!realPath(at).startsWith(claude + sep)) return null;
  } catch { return null; }
  // `readRegularFileSync` opens and fstats the same fd, so a FIFO swapped in
  // after the boundary check above cannot hang this process's read: the
  // same TOCTOU this commit closed for `.gitmodules` and the gitdir
  // back-pointer, left open here until now.
  const text = readRegularFileSync(at);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** What of the checkout's own `.claude/settings.json` and
 *  `.claude/settings.local.json` a turn is given, because the CLI is started
 *  with `--setting-sources user` and cannot see them itself.
 *
 *  Deny rules from both: a deny can only narrow, so it is the part a team is
 *  entitled to. A hook only when its command runs a file in `.claude/`. Never
 *  `permissions.allow`, which would widen what this turn may do, and never
 *  `env`: the browser door's roots are read from `AGX_TURN_WRITE_ROOTS` in the
 *  MCP server's environment, so a committed entry naming "/" would make record,
 *  download and trace write anywhere. A file that is missing or not JSON
 *  forwards nothing; the turn runs either way. */
export function checkoutSettings(cwd: string): { deny: string[]; hooks: Record<string, unknown[]>; lost: LostHook[] } {
  const deny: string[] = [];
  const lost: LostHook[] = [];
  const hooks: Record<string, unknown[]> = {};
  for (const name of ["settings.json", "settings.local.json"]) {
    const raw = settingsFile(cwd, name);
    if (!raw || typeof raw !== "object") continue;
    const s = raw as { permissions?: { deny?: unknown }; hooks?: unknown };
    if (Array.isArray(s.permissions?.deny)) for (const r of s.permissions.deny) if (typeof r === "string" && r) deny.push(r);
    if (!s.hooks || typeof s.hooks !== "object") continue;
    for (const [event, groups] of Object.entries(s.hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups.map((g) => keepGroup(cwd, event, g, lost)).filter((g): g is Record<string, unknown> => !!g);
      if (kept.length) hooks[event] = [...(hooks[event] ?? []), ...kept];
    }
  }
  return { deny: [...new Set(deny)], hooks, lost };
}

/**
 * The `network` keys that open Unix sockets: none when the setting is off (so
 * a turn with it unset is byte-identical to before it existed), the CLI's
 * all-sockets switch when it is "all".
 *
 * There is no "tmux and adb only". Measured with real `claude -p` turns on CLI
 * 2.1.318 on Linux: `allowUnixSockets` opens nothing, not a folder and not the
 * exact socket path ("error connecting to .../agx-probe (Operation not
 * permitted)"), while `allowAllUnixSockets` lets a private tmux socket work.
 * A setting that offered the middle would be a switch that changes nothing.
 * "all" also reaches the agentglass tmux socket, which the row says.
 */
export function socketKeys(sockets: "off" | "all"): Record<string, unknown> {
  return sockets === "all" ? { allowAllUnixSockets: true } : {};
}

/** One `SKILL.md` or command `.md` of the checkout's own `.claude/skills` or
 *  `.claude/commands`, named relative to that directory — `skills/<id>/SKILL.md`
 *  or `commands/<name>.md` — or null when the entry does not match, is a link
 *  on the way, or is not a plain file (the same guard `hookScript` applies to
 *  a hook's own script). */
function projectSkillFile(claudeDir: string, kind: "skills" | "commands", entry: string): { rel: string; text: string } | null {
  const dir = join(claudeDir, kind);
  if (kind === "commands") {
    if (!entry.endsWith(".md") || entry.toLowerCase() === "readme.md") return null;
    const at = join(dir, entry);
    if (isLink(at)) return null;
    const text = readRegularFileSync(at);
    return text === null ? null : { rel: join(kind, entry), text };
  }
  const at = join(dir, entry, "SKILL.md");
  if (isLink(join(dir, entry)) || isLink(at)) return null;
  const text = readRegularFileSync(at);
  return text === null ? null : { rel: join(kind, entry, "SKILL.md"), text };
}

/** `workers.projectSkills`: the project's own `.claude/skills` and
 *  `.claude/commands` — read from `root` (`p.policyRoot`), never from the
 *  turn's worktree, which for a reviewed checkout can be an outside
 *  contributor's untrusted branch — copied, never symlinked, so a worker
 *  cannot swap one after this reads it, into a plugin this turn's own
 *  `--plugin-dir` loads for it alone. Skills are text (a `SKILL.md`, a
 *  command's `.md`); the manifest written here declares neither hooks nor an
 *  MCP server, so this stays pure content and never becomes a second way into
 *  what `checkoutSettings` deliberately keeps out. Null when the project has
 *  nothing of either kind, so a turn with nothing to stage adds no flag. */
export function stageProjectSkills(root: string, runDir: string): string | null {
  const claude = realPath(join(root, ".claude"));
  const staged = join(runDir, "project-skills-plugin");
  // A stale plugin from an earlier turn, or a symlink an earlier turn
  // planted at this exact name, goes first — link included, never
  // followed — so staging always starts from nothing real of its own.
  rmSync(staged, { recursive: true, force: true });
  let any = false;
  for (const kind of ["skills", "commands"] as const) {
    let entries: string[];
    try { entries = readdirSync(join(root, ".claude", kind)); } catch { continue; }
    for (const entry of entries) {
      const found = projectSkillFile(join(root, ".claude"), kind, entry);
      if (!found) continue;
      // The file has to really sit inside this project's own `.claude`,
      // not just be named as if it did (a `..` segment, a link followed
      // partway through `readRegularFileSync`'s own open).
      if (!realPath(join(root, ".claude", found.rel)).startsWith(claude + sep)) continue;
      const dest = join(staged, found.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFreshFile(dest, found.text);
      any = true;
    }
  }
  if (!any) return null;
  mkdirSync(join(staged, ".claude-plugin"), { recursive: true });
  writeFreshFile(join(staged, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "project-skills", version: "0.0.0",
    description: "This checkout's own skills and commands, staged read-only for this turn.",
  }));
  return staged;
}


/** What a Claude turn writes into `--settings.sandbox`, or null where Claude
 *  Code's sandbox cannot hold the envelope (`agents/envelope.ts` `sandboxHolds`).
 *
 *  `network: false` becomes an empty allow list with `strictAllowlist`, so a
 *  `python3 -c` that opens a URL is refused whatever its text looks like to a
 *  prefix rule, and a domain a project's or a checkout's settings file adds is
 *  left out of the allowlist. `allowLocalBinding` keeps a test that binds a
 *  loopback port working, and it opens binding only: measured with a real
 *  sandboxed turn, a `python3` there got "Connection refused" from
 *  127.0.0.1:4000 while the same port answered 200 from outside, so the relay's
 *  loopback port is out of the shell's reach. Writes are the worktree, the
 *  turn's run folder and the git directories a commit needs — or, for a role
 *  that writes nothing, the turn's own folder, with the worktree and the shared
 *  git metadata denied. */
export function sandboxFor(role: WorkerRole, e: Envelope, cwd: string, runDir?: string, sockets: "off" | "all" = "off", gitInternals = false): Record<string, unknown> | null {
  if (!sandboxHolds(role, e)) return null;
  const writes = !role.readOnly && e.write !== "none";
  const git = gitWriteRoots(cwd, writes && e.commit, writes, gitInternals);
  // A project's own `.claude` is read by the next turn's CLI and there is no
  // `strictAllowlist` for files, so a settings file written here is a sandbox
  // of the worker's own choosing: shut like a hook. Denied whether or not it
  // exists — the deny is computed before the turn and turn 1 would make it —
  // and made empty first, so the deny has a path to bind.
  const projectSettings = join(cwd, ".claude");
  if (writes && existsSync(cwd) && !isLink(projectSettings)) {
    try { mkdirSync(projectSettings, { recursive: true }); } catch { /* not ours to add to */ }
  }
  const deny = [...git.deny, ...(writes ? [projectSettings] : [])];
  // The app's own credentials: unreadable to the shell for every role.
  const denyRead = appSecretDirs();
  return {
    enabled: true,
    // No silent unsandboxed shell: a machine without bubblewrap fails the turn
    // with an error the pane shows, instead of running the commands unconfined.
    failIfUnavailable: true,
    // `Bash` is allowed whole, so the model must not be able to ask for it
    // outside the sandbox (the CLI's `dangerouslyDisableSandbox`).
    allowUnsandboxedCommands: false,
    // `strictAllowlist` is honoured only from `--settings` (this file): it drops
    // the domains project/local settings and `WebFetch(domain:…)` rules add.
    // Measured with a real turn in a trusted repo whose settings name a
    // domain: refused with this list, refused without `strictAllowlist`,
    // refused with no network key, reached only when `--settings` names it.
    // So the merge this guards against did not happen on that CLI; keep the
    // key, and repeat that turn after a CLI upgrade, because no unit test
    // can see what the CLI merges.
    // No relay allowance. The sandbox names hosts, not ports: allowing the
    // loopback host for the browser CLI's relay opens every local service with
    // it, the agentglass API among them. The browser_* MCP tools are the turn's
    // door to the same relay, so the CLI notice stays true and stays. Tmux and
    // Chromium sockets are NOT opened here either: the CLI's sandbox has no
    // per-path unix-socket key (see `socketKeys`), so a private socket dir
    // cannot be allowed without also opening the real tmux socket, and that
    // stays behind `workers.unixSockets`.
    network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true, ...socketKeys(sockets) },
    filesystem: writes
      ? {
          allowWrite: [cwd, ...(runDir ? [runDir] : []), ...git.allow],
          ...(deny.length ? { denyWrite: deny } : {}),
          denyRead,
        }
      : { allowWrite: runDir ? [runDir] : [], denyWrite: [cwd, ...deny], denyRead },
  };
}

/** Writes `sandboxFor`'s box into a `--settings <json>` arg pair, in place.
 *  The one spot every Claude role start merges its sandbox through —
 *  `headlessTurn`'s own TUI/print argv below, and a worker started straight
 *  from `/agents/named/start` (no orchestration policy stored) — so the two
 *  cannot drift into one sandboxed and the other not. No-op when the args
 *  carry no `--settings` (another engine) or the envelope cannot be
 *  sandboxed (`box` null, see `sandboxFor`). */
export function mergeSandboxIntoSettingsArgs(args: string[], box: Record<string, unknown> | null): void {
  if (!box) return;
  const at = args.indexOf("--settings");
  if (at < 0) return;
  const settings = JSON.parse(args[at + 1]!) as { sandbox?: unknown };
  settings.sandbox = box;
  args[at + 1] = JSON.stringify(settings);
}

/** Why an engine with no read wall is not a worker, and the setting that lifts it. */
export const UNWALLED_REFUSAL = (title: string): string =>
  `${title} has no sandbox, so its shell could read the app's own token and anything else you can. It is refused as a worker. To allow it anyway, turn on Settings ▸ Orchestration ▸ Run engines with no read wall (workers.unwalledEngines)`;

/** The app's config and state dirs, spelled and resolved: a symlinked state dir (or AGENTGLASS_STATE_DIR) is denied by its real path too. */
export function codexDeniedDirs(): string[] {
  const state = stateDir();
  return [...new Set([...agentglassConfigDirs(), state, realish(state)])];
}

/** Whether `bwrap` can make a mount namespace here. Probed once per process; tests reset it. */
let bwrapProbe: boolean | undefined;
export function bwrapWorks(): boolean {
  if (bwrapProbe !== undefined) return bwrapProbe;
  const bin = Bun.which("bwrap");
  if (!bin || process.platform !== "linux") return (bwrapProbe = false);
  try { return (bwrapProbe = spawnSyncAs("probe bwrap", [bin, "--dev-bind", "/", "/", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0); }
  catch { return (bwrapProbe = false); }
}
export function resetBwrapProbe(): void { bwrapProbe = undefined; }

/** Control sockets the app's own processes listen on, outside the wall: a worker that reached one
 *  could have a server running OUTSIDE the wall read the credential for it (`tmux run-shell 'cat …'`,
 *  `tmux send-keys` into a pane that is outside, `systemd-run --user … cat …`). So their directories
 *  are covered by an empty tmpfs, and the variables that point at them are unset. */
function controlSocketDirs(env: Record<string, string | undefined>): string[] {
  const uid = process.getuid?.() ?? 0;
  const dirs = [env.XDG_RUNTIME_DIR || `/run/user/${uid}`, `/tmp/tmux-${uid}`];
  if (env.TMUX_TMPDIR) dirs.push(env.TMUX_TMPDIR, join(env.TMUX_TMPDIR, `tmux-${uid}`));
  // `$TMUX` is "<socket path>,<pid>,<session>": the server the worker was started inside, wherever its socket lives.
  const sock = env.TMUX?.split(",")[0];
  if (sock) dirs.push(dirname(sock));
  return [...new Set(dirs.flatMap((d) => [d, realish(d)]))];
}
const SOCKET_ENV = ["TMUX", "TMUX_PANE", "SSH_AUTH_SOCK"];
/** The session bus is NOT given back (`systemd-run --user` over it escaped the wall), but unset it and
 *  bus clients (gh's keyring lookup) autolaunch a bus and hang for minutes. A set address that refuses
 *  at once makes them fail fast: the keyring is not reachable inside the wall. */
export const DEAD_BUS = "unix:path=/nonexistent";

/** `argv` run under bubblewrap with the whole tree as it is, the app's credential paths hidden
 *  (a directory by an empty tmpfs, a file by /dev/null) and the user's control sockets hidden too.
 *  Paths that do not exist are skipped.
 *  CEILING: the network stays shared (the worker needs it), so abstract unix sockets and loopback
 *  TCP stay reachable; this wall is for the files and the filesystem sockets, not for the network.
 *  The state dir and the database hold no credential (worker tokens live in memory, the machine
 *  token and usage key are in the config dir), so they stay visible: the worker's own run folder
 *  is under the state dir and must stay writable. */
export function bwrapped(argv: string[], hide: readonly string[] = appSecretDirs(), env: Record<string, string | undefined> = process.env): string[] {
  const hides = [...hide, ...controlSocketDirs(env)].flatMap((p) => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) return [];
    return st.isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p];
  });
  return ["bwrap", "--dev-bind", "/", "/", ...hides, ...SOCKET_ENV.flatMap((v) => ["--unsetenv", v]), "--setenv", "DBUS_SESSION_BUS_ADDRESS", DEAD_BUS, "--die-with-parent", "--", ...argv];
}

/** Engines whose own shell has no read wall: the credential dir is hidden by bwrap, or the start is refused. */
const NEEDS_BWRAP = new Set(["opencode", "hermes", "antigravity"]);
const NO_BWRAP_REFUSAL = (title: string): string =>
  `${title} has no read wall of its own, and bubblewrap cannot run on this machine (missing, or user namespaces are off), so its shell could read the app's own token. It is refused as a worker. To allow it anyway, turn on Settings ▸ Orchestration ▸ Run engines with no read wall (workers.unwalledEngines)`;

/**
 * `ssh` for a worker's `git push`. A worker runs in a user namespace (bwrap here,
 * Claude Code's own sandbox otherwise) where root's uid maps to nobody, so ssh
 * refuses the system config it reads first: "Bad owner or permissions on
 * /etc/ssh/ssh_config.d/20-….conf" (measured: `bwrap --dev-bind / / ssh -G host`
 * fails, `ssh -F ~/.ssh/config -G host` and `-F /dev/null` pass). `-F` skips the
 * system files; the user's own config is theirs and keeps its owner.
 *
 * Only filled in when the person has not chosen: a GIT_SSH_COMMAND or GIT_SSH of
 * theirs (in the app's environment or the turn's) is left alone.
 * CEILING: a `core.sshCommand` in git config is shadowed by GIT_SSH_COMMAND, and
 * what the system config set (keepalives, a proxy) is not applied in the worker.
 */
export function workerSshEnv(env: Record<string, string | undefined> = process.env, home: string = homedir()): Record<string, string> {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return {};
  const mine = join(home, ".ssh", "config");
  const file = existsSync(mine) ? mine : "/dev/null";
  return { GIT_SSH_COMMAND: `ssh -F '${file.replace(/'/g, `'\\''`)}'` };
}

export function headlessTurn(t: TurnSpec): Turn {
  const refused = headlessRefusal(t.engine);
  if (refused) return { ok: false, error: refused };
  // A project's own PreToolUse hooks (a guard on master, a prod-DB block) run only in Claude Code: an engine that would skip them is not started here.
  const noHooks = hookRefusal(t.engine, [t.skillsRoot, t.cwd]);
  if (noHooks) return { ok: false, error: noHooks };
  const title = agentProvider(t.engine)!.title;
  const c = compileEnvelope(t.engine, t.role, t.envelope, t.model, undefined, t.openDoors, t.closedCommands, t.neverCommands, t.legacyOpenCommands);
  if (!c.ok) return c;
  const sandbox = t.role.readOnly || t.envelope.write === "none" ? "read-only" : "workspace-write";
  const unboxed = unsandboxedBecause(t.role, t.envelope) ?? undefined;
  // A shell nothing walls (OpenCode, Hermes, Antigravity, or Claude whose network/docker switch dropped its sandbox) runs under bwrap.
  const needsWall = NEEDS_BWRAP.has(t.engine) || (t.engine === "claude" && (!!unboxed || t.unixSockets === "all"));
  const walled = needsWall && bwrapWorks();
  // Checked when the argv is handed back, so a bad model or a missing field is still named first.
  const done = (argv: string[], stdin: "none" | "prompt", extra: { sessionId?: string; tui?: true } = {}): Turn =>
    needsWall && !walled && !t.unwalledEngines ? { ok: false, error: NO_BWRAP_REFUSAL(title) } :
    ({ ok: true, argv: walled ? bwrapped(argv, appSecretDirs(), { ...process.env, ...c.env }) : argv, env: { ...workerSshEnv({ ...process.env, ...c.env }), ...c.env }, stdin, partly: c.partly, ...(unboxed ? { unsandboxed: unboxed } : {}), ...extra });

  switch (t.engine) {
    case "claude": {
      /* THE REAL TUI, NOT A SUMMARY OF IT. The person watches this pane, and
         what they asked for is the Claude Code they know: its box, its tool
         calls, its questions. So the turn is the interactive form with the
         brief as its first message, and the end of the turn is the CLI's own
         `turn_duration` line in its transcript (agents/tuiturn.ts) — never an
         exit code, because the TUI does not exit when a turn ends.
         `--verbose` and `--output-format` belong to the print form and are not
         passed: an unknown flag is a window that prints a usage error and
         closes.
         NOBODY IS AT THIS PANE, SO NOTHING HERE MAY ASK. The mode is
         `agents.permissionMode` (Settings ▸ Orchestration), `dontAsk` when the
         person has not set it: `dontAsk` refuses what would have prompted
         instead of drawing a dialog, and `bypassPermissions` skips the ask
         step too — only these two are valid here, because `acceptEdits` and
         `plan` ask (read on). `--allowedTools`
         names what a worker must be able to run. The deny list refuses a
         command by its text; `sandboxFor` is what holds `network: false` and
         the writable tree for a `python3 -c` no rule reads, and where it cannot
         hold them the start says "partly". `acceptEdits` asks for Bash and
         `plan` asks about everything (ExitPlanMode included), and a turn
         stopped on a dialog writes no `turn_duration`: it sits until the turn
         limit, is killed with 124, and its plan or result is thrown away. */
      const sessionId = t.resume ?? randomUUID();
      const args = [...c.args];
      const linked = linkedTreeRefusal(t.role, t.envelope, t.cwd);
      if (linked) return { ok: false, error: linked };
      sweepMountPoints(t.cwd);
      const box = sandboxFor(t.role, t.envelope, t.cwd, t.runDir, t.unixSockets, t.gitInternals);
      // The checkout's own scope is not read by the CLI (`--setting-sources
      // user` below, unconditionally): what a team is entitled to is
      // forwarded here instead, exactly as every turn did before
      // `projectSkills` existed. Project skills go a different way (below) —
      // `--setting-sources project` would hand the CLI the checkout's hooks,
      // MCP servers and `permissions.allow` too, with none of this filtering.
      const own = checkoutSettings(t.cwd);
      const lostHook = droppedHookRefusal(own.lost);
      if (lostHook) return { ok: false, error: lostHook };
      const at = args.indexOf("--settings");
      if (at >= 0) {
        const settings = JSON.parse(args[at + 1]!) as { sandbox?: unknown; permissions?: { deny?: string[] }; hooks?: unknown };
        // A deny rule only narrows, so it rides on every turn. So does a hook.
        // Sandboxed, `.claude` is shut by the box. On a turn the sandbox cannot
        // hold (network or docker lifted, which `gh` needs), `.claude` is shut
        // only by the deny list below, so a shell that writes the hook's file
        // could still change it: the same "partly" the rest of that turn
        // already says. Dropping the hook there refused every start that
        // needed `gh` in a project with a guard, which left the guard with no
        // worker to guard at all.
        const mcpDeny = mcpDenyFor(t.mcpServers ?? []);
        const hooked = Object.keys(own.hooks).length > 0;
        const shut = hooked && !box ? CLAUDE_DIR_EDITS : [];
        if (own.deny.length || mcpDeny.length || shut.length) {
          settings.permissions = { ...settings.permissions, deny: [...(settings.permissions?.deny ?? []), ...own.deny, ...mcpDeny, ...shut] };
        }
        if (hooked) settings.hooks = own.hooks;
        args[at + 1] = JSON.stringify(settings);
      }
      mergeSandboxIntoSettingsArgs(args, box);
      // The MCP server this turn loads runs outside its shell, so the browser
      // tools that take a path of the model's choosing (`record`, `download`,
      // `trace`) are held by this list, not by the sandbox: the work tree and
      // the turn's own folder. Never the sandbox's `allowWrite`, which for a
      // linked worktree carries the git dirs — a trace written to
      // `<gitdir>/commondir` decides the next turn's allow and deny lists.
      const writes = !t.role.readOnly && t.envelope.write !== "none";
      const doorRoots = writes
        ? [t.cwd, ...(t.runDir ? [t.runDir] : [])]
        : (t.runDir ? [t.runDir] : []);
      c.env.AGX_TURN_WRITE_ROOTS = doorRoots.join(delimiter);
      // `workers.projectSkills` (Settings ▸ Orchestration), on by default:
      // the checkout's own `.claude/skills` and `.claude/commands`, staged
      // into a throwaway plugin this turn alone loads (`--plugin-dir`).
      // Project skills are text, so they are handled the same way a hook's
      // script is (`hookScript`, above): copied out as plain files, never by
      // widening `--setting-sources` to "project", which would also hand the
      // CLI the checkout's real hooks, MCP servers and `permissions.allow`.
      const skillsPlugin = t.projectSkills !== false && t.runDir && t.skillsRoot ? stageProjectSkills(t.skillsRoot, t.runDir) : null;
      const allow = [...allowedToolsFor(t.role, t.envelope), ...(skillsPlugin ? ["Skill"] : [])];
      return done([
        t.bin, ...args,
        // Only this app's browser server where the role has that door, plus
        // whatever `workers.mcpServers` switched on, and no other MCP server
        // at all: `--strict-mcp-config` stops the CLI loading the person's
        // user/project ones or a checkout's `.mcp.json` beyond that.
        "--strict-mcp-config", "--mcp-config", mcpConfigArg(t.role, t.mcpServers ?? [], t.runDir, t.envelope),
        // The person's settings only (see `own`, above).
        "--setting-sources", "user",
        ...(skillsPlugin ? ["--plugin-dir", skillsPlugin] : []),
        // One element, because the flag takes a list and would swallow the
        // prompt otherwise; `--permission-mode` closes it.
        ...(allow.length ? ["--allowedTools", allow.join(" ")] : []),
        "--permission-mode", t.permissionMode ?? "dontAsk",
        ...(t.resume ? ["--resume", t.resume] : ["--session-id", sessionId]),
        // A brief that starts with `-` would be read as a flag; one leading
        // space keeps it a message and changes nothing a model reads.
        t.prompt.startsWith("-") ? ` ${t.prompt}` : t.prompt,
      ], "none", { sessionId, tui: true });
    }
    case "opencode": {
      if (!t.model.includes("/")) return { ok: false, error: `OpenCode takes a model as provider/model (opencode/big-pickle), and "${t.model || "(none)"}" is not one` };
      return done([t.bin, "run", "--format", "json", ...c.args, ...(t.resume ? ["-s", t.resume] : []), "--", t.prompt], "none");
    }
    case "codex": {
      if (!t.model) return { ok: false, error: "Codex has to be given a model in the policy" };
      // `codexArgs` ends with `-`: the prompt is read from stdin.
      // The wall: write only the worktree and the run folder, and the app's own config and state are not readable at all.
      const writes = sandbox !== "read-only";
      // The run folder sits under the state dir: a "write" child inside a "none" parent stays writable while the rest of the parent is denied (measured with a real `codex sandbox`).
      const wall = { write: [...(writes ? [t.cwd] : []), ...(t.runDir ? [t.runDir] : [])], deny: codexDeniedDirs() };
      return done(codexArgs(t.bin, t.model, sandbox, t.resume ?? "", wall), "prompt");
    }
    case "hermes": {
      // Hermes has no sandbox flag: its shell reads whatever the person can, the app's token included.
      if (!walled && !t.unwalledEngines) return { ok: false, error: UNWALLED_REFUSAL("Hermes") };
      // `hermesArgs` never uses `--yolo` here, and `--run-budget` is the turn ceiling.
      return done([...hermesArgs(t.bin, t.model, t.resume ?? "", "default", t.prompt), "--run-budget", String(t.limits.turnMinutes * 60)], "none");
    }
    case "antigravity":
      return done(antigravityArgs(t.bin, t.model, sandbox === "read-only" ? "plan" : "accept-edits", t.resume ?? "", t.prompt), "none");
    default:
      return { ok: false, error: `${title} has no headless form this app knows, so it cannot run as a worker yet` };
  }
}

// ── the wrapper, and what it leaves behind ───────────────────────────────

/** The files one turn leaves: its prompt, what it printed, what it complained
 *  about, and how it ended. One folder per worker name; a new turn clears it.
 *  `view` is the reader the pane pipes through, written beside the turn so a
 *  compiled server never has to hand a spawnable process a /$bunfs path. */
export interface RunFiles { dir: string; input: string; prompt: string; out: string; err: string; rc: string; view: string }

export function runFiles(name: string, root = runsDir()): RunFiles {
  const dir = join(root, name);
  return { dir, input: join(dir, "in"), prompt: join(dir, "prompt"), out: join(dir, "out"), err: join(dir, "err"), rc: join(dir, "rc"), view: join(dir, "view.py") };
}

function runsDir(): string {
  const state = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(state, "worker-runs");
}

/**
 * Prepare the folder (owner-only: a prompt can hold anything) and the stdin.
 *
 * A folder that is already there keeps its directory entry, never removed
 * and made again. The end of a turn is a watch on this folder (ceilings.ts),
 * and a watch put on a path that was deleted and recreated gets no events at
 * all (measured: 0 of the statuses seen on the second turn of a name, 200 of
 * 200 when the folder itself stayed). Only this wrapper's own files inside it
 * are reset (in, prompt, out, err, rc, part/, view.py): mcp-config.json and a
 * staged project-skills-plugin are written by the argv build that runs
 * BEFORE this call and must survive it, and a file the worker itself wrote
 * stays too, so a turn 2 resume still finds what turn 1 left behind.
 */
export function prepareRun(name: string, prompt: string, stdin: "none" | "prompt"): RunFiles {
  const f = runFiles(name);
  const there = lstatSync(f.dir, { throwIfNoEntry: false });
  if (there && !there.isDirectory()) rmSync(f.dir, { recursive: true, force: true });
  for (const p of [f.input, f.prompt, f.out, f.err, f.rc, join(f.dir, "part"), join(f.dir, "tuifrom"), f.view]) rmSync(p, { recursive: true, force: true });
  mkdirSync(join(f.dir, "part"), { recursive: true, mode: 0o700 });
  chmodSync(f.dir, 0o700);
  writeFreshFile(f.input, stdin === "prompt" ? prompt : "");
  // Kept for every engine, because a retry on another one needs the words again.
  writeFreshFile(f.prompt, prompt);
  // Written from what the build embedded: a compiled server cannot hand a
  // spawned python a /$bunfs path. A build without it keeps the raw JSON.
  try { writeFreshFile(f.view, readFileSync(viewScript, "utf8")); } catch { /* the pane stays raw */ }
  return f;
}

/** Runs the engine with its stdin from a file, leaves its exit status where
 *  the server reads it (see below), and prints what it complained about last so the person
 *  watching the window sees it. This app's own credentials are dropped from
 *  the environment: a tmux window inherits the server's, not this process's. */
/* The status is written in `part/`, a folder the watch does not look into, and
   moved into place, so the file is whole whenever it is there. Measured over
   300 turns each, with the watch this server uses: written in place, the file
   is created empty and its filling makes no second event; written beside
   itself as `rc.tmp` and renamed, the watch tripped over the vanished name and
   72 statuses went unseen; moved in from `part/`, 0 (ceilings.ts reads on any
   event in the folder). */
/** The wrapper's step that turns the private token file into GH_TOKEN and deletes the file. */
export const GH_FILE_LINE = "g=${AGENTGLASS_GH_TOKEN_FILE:-}; unset AGENTGLASS_GH_TOKEN_FILE; if [ -n \"$g\" ]; then if [ -r \"$g\" ]; then GH_TOKEN=$(cat \"$g\"); export GH_TOKEN; fi; rm -f \"$g\"; fi";
const WRAPPER = [
  'in=$1; err=$2; rc=$3; out=$4; py=$5; view=$6; part=${rc%/*}/part/rc; shift 6',
  // The minted worker credential survives the unset that drops the person's
  // machine token: it rides under its own name, is re-exported as the one the
  // CLI reads, and is gone from the engine's environment by the time it starts.
  // The browser identity comes back only with it, so an off worker inherits none.
  'w=${AGENTGLASS_WORKER_TOKEN:-}; p=${AGENTGLASS_PROFILE:-}; a=${AGENTGLASS_BROWSER_AS:-}',
  // The GitHub token comes in a private file (never the window's command line): read into GH_TOKEN, file deleted.
  GH_FILE_LINE,
  'unset AGENTGLASS_TOKEN AGENTGLASS_WORKER_TOKEN AGENTGLASS_PROFILE AGENTGLASS_BROWSER_AS AGENTGLASS_SEAT HERMES_YOLO_MODE _HERMES_GATEWAY',
  'if [ -n "$w" ]; then AGENTGLASS_TOKEN=$w; AGENTGLASS_PROFILE=$p; AGENTGLASS_BROWSER_AS=$a; export AGENTGLASS_TOKEN AGENTGLASS_PROFILE AGENTGLASS_BROWSER_AS; fi',
  'for v in $(env | sed -n "s/^\\(HERMES_[A-Za-z0-9_]*_SESSION\\)=.*/\\1/p"); do unset "$v"; done',
  'TERMINAL_CWD=$PWD; export TERMINAL_CWD',
  // `tee` before the reader: the file keeps the events whatever the reading does.
  // The status is moved into place only once the tab has drained: a row reading
  // "ended" while the last lines are still being printed is the kind of race
  // that made one worker count against the next start's limit.
  // A reader that dies hands the rest to `cat`: a pipe with no reader would
  // SIGPIPE `tee`, and through it the worker, over a formatting bug.
  '{ "$@" <"$in" 2>"$err"; echo $? >"$part"; } | tee "$out" | { if [ -n "$py" ]; then "$py" "$view" "$part" "$out" || cat; else cat; fi; }',
  'mv "$part" "$rc"',
  // The private OpenCode server of this turn, by the pids recorded for it and only while they are still a `serve`.
  'for p in $AGX_SERVE_PIDS; do grep -qa serve "/proc/$p/cmdline" 2>/dev/null && kill "$p" 2>/dev/null; done',
  'cat "$err" >&2',
  'exit "$(cat "$rc" 2>/dev/null || echo 1)"',
].join("\n");

/** The interpreter and script the tab is piped through, or nothing when this
 *  engine writes no JSON a reader knows, or this machine has no python3. */
function viewCommand(f: RunFiles, engine: string | undefined): string[] {
  if (engine !== "opencode" || !existsSync(f.view)) return [];
  const python = Bun.which("python3") || Bun.which("python");
  return python ? [python, f.view] : [];
}

export const wrapped = (f: RunFiles, argv: string[], engine?: string): string[] => {
  const view = viewCommand(f, engine);
  return ["sh", "-c", WRAPPER, "agx-worker", f.input, f.err, f.rc, f.out, view[0] ?? "", view[1] ?? "", ...argv];
};

/**
 * The same wrapper for a TUI turn, minus the three things a terminal UI cannot
 * have: its stdin is not a file (it is the pane's tty), its stdout is not piped
 * (the TUI draws there), and its status is not the CLI's exit — a turn ends
 * while the CLI is still running, so `agents/tuiturn.ts` writes the status.
 *
 * The environment hygiene is the wrapper's, unchanged: the person's machine
 * token never reaches the worker, the minted one does, and the private
 * OpenCode server of a turn is stopped when the CLI finally leaves.
 */
const TUI_WRAPPER = [
  'err=$1; rc=$2; part=${rc%/*}/part/rc; shift 2',
  'w=${AGENTGLASS_WORKER_TOKEN:-}; p=${AGENTGLASS_PROFILE:-}; a=${AGENTGLASS_BROWSER_AS:-}',
  // The GitHub token comes in a private file (never the window's command line): read into GH_TOKEN, file deleted.
  GH_FILE_LINE,
  'unset AGENTGLASS_TOKEN AGENTGLASS_WORKER_TOKEN AGENTGLASS_PROFILE AGENTGLASS_BROWSER_AS AGENTGLASS_SEAT HERMES_YOLO_MODE _HERMES_GATEWAY',
  'if [ -n "$w" ]; then AGENTGLASS_TOKEN=$w; AGENTGLASS_PROFILE=$p; AGENTGLASS_BROWSER_AS=$a; export AGENTGLASS_TOKEN AGENTGLASS_PROFILE AGENTGLASS_BROWSER_AS; fi',
  'for v in $(env | sed -n "s/^\\(HERMES_[A-Za-z0-9_]*_SESSION\\)=.*/\\1/p"); do unset "$v"; done',
  'TERMINAL_CWD=$PWD; export TERMINAL_CWD',
  // The status here is the CLI leaving, which after a turn ended is a person
  // closing the tab. By then the transcript has settled the row, so its status
  // is kept: only a CLI that died before its turn's marker writes here.
  '{ "$@" 2>"$err"; echo $? >"$part"; }',
  '[ -e "$rc" ] || mv "$part" "$rc"',
  'for p in $AGX_SERVE_PIDS; do grep -qa serve "/proc/$p/cmdline" 2>/dev/null && kill "$p" 2>/dev/null; done',
  'cat "$err" >&2',
  'exit "$(cat "$rc" 2>/dev/null || echo 1)"',
].join("\n");

export const wrappedTui = (f: RunFiles, argv: string[]): string[] =>
  ["sh", "-c", TUI_WRAPPER, "agx-worker", f.err, f.rc, ...argv];

/** How the last turn ended, from what the wrapper left. Null while it runs. */
export function turnResult(f: RunFiles, engine: string): { exitCode: number; line: string; resumeId?: string } | null {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const rc = read(f.rc);
  if (rc === null || !/^\d+\s*$/.test(rc)) return null;
  // The turn is over: its OpenCode steps are the local spend the plan panel
  // counts. Idempotent, so the ceiling watch reading this again adds nothing.
  if (engine === "opencode") recordOpenCodeTurn(f.out);
  const err = read(f.err) ?? "";
  const last = err.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return { exitCode: Number(rc), line: redact(last).slice(0, 200), resumeId: sessionIdOf(engine, read(f.out) ?? "", err) ?? undefined };
}

/**
 * What the final report of a turn says, from the run's output file: Claude's
 * `result` frame, else the text the other engines stream (OpenCode, Codex,
 * Hermes), else the whole file when it is plain text. Null when nothing can be
 * read, which for a reviewer is not a pass. Here rather than with the plan,
 * because the ending path asks it too and must not import the start path.
 */
export function reportOf(out: string): string | null {
  let sawFrame = false, result: string | null = null;
  const said: string[] = [];
  for (const l of out.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const f = JSON.parse(l) as { type?: string; result?: unknown; text?: unknown; part?: { type?: string; text?: unknown }; item?: { type?: string; text?: unknown } };
      sawFrame = true;
      if (f.type === "result" && typeof f.result === "string") result = f.result;
      else if (f.part?.type === "text" && typeof f.part.text === "string") said.push(f.part.text);
      else if (f.item?.type === "agent_message" && typeof f.item.text === "string") said.push(f.item.text);
      else if (f.type === "text" && typeof f.text === "string") said.push(f.text);
    } catch { /* not a frame */ }
  }
  if (result !== null) return result;
  if (said.length) return said.join("\n");
  return !sawFrame && out.trim() ? out : null;
}

/**
 * What a finished turn answered, from its `out` file.
 *
 * A TUI turn's file IS the answer, so it is taken whole: a plan may hold a line
 * that parses as a JSON object (`{"retry": {"attempts": 3}}`), and `reportOf`
 * reads such a line as a frame, finds no result in it, and throws the whole
 * answer away — no plan, no report, and "ended without a result" for a turn that
 * had one. An engine that streams frames still goes through `reportOf`.
 *
 * `tui` is the turn's own stamp (`StartedBy.tui`), not the engine's name: a row
 * from before a Claude turn ran as a TUI wrote frames to the same file.
 */
export function answerOf(tui: boolean | undefined, out: string): string | null {
  if (tui) return out.trim() ? out : null;
  return reportOf(out);
}

/** The session an engine says it ran in, so a later turn can resume it. */
export function sessionIdOf(engine: string, out: string, err: string): string | null {
  if (engine === "hermes") return /session_id:\s*(\S+)/.exec(err)?.[1] ?? null;
  for (const l of out.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const f = JSON.parse(l) as Record<string, unknown>;
      if (engine === "opencode" && typeof f.sessionID === "string") return f.sessionID;
      if (engine === "codex" && f.type === "thread.started" && typeof f.thread_id === "string") return f.thread_id;
    } catch { /* not a frame */ }
  }
  return null;
}
