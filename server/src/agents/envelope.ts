/*
 * The envelope a policy-started worker runs inside, compiled per engine.
 *
 * One neutral `Envelope` (shared/orchestration.ts) in, one lock out. The
 * floor is DENIED_COMMANDS (sudo and other worktrees' gitdirs); an envelope can narrow four groups of it
 * (`commit` lifts `git commit`, `network` lifts `curl` and `wget`, `docker`
 * lifts `docker`, `worktreeOps` lifts `git merge`/`reset`/`checkout`/`switch`/
 * `clean` and `git worktree remove`/`prune`/`list`, but only when Claude
 * Code's own sandbox is holding the turn — see `deniedFor`'s fourth argument)
 * and add more. The one other widening is a flow role's own
 * `allow` list, which takes prefixes off the floor for that role's workers
 * only and never one of NEVER_LIFTABLE. What cannot be expressed cannot be
 * granted by mistake, so no envelope and no role takes `git push`, `git worktree add`, `gh`, `ssh`, history rewrites, `sudo`
 * or `rm` off the list.
 *
 * Being on the list is not being impossible. Not a sandbox: the engine applies
 * its own permission system, as the same user as this server, and its rules
 * read a command line as text. Claude Code's match the start of the line, so
 * `git -C . push` or `/usr/bin/git push` is not `git push` to it; OpenCode's
 * are globs a shell can build a line around. This app's own CLIs are on the
 * list the same way, except the browser for a role whose work is a page (see
 * DOORS_FOR_ROLE), and its token file is readable by anything that runs as
 * this user. So no engine's lock is reported as more than "partly" enforced
 * (agentprobe.ts), every start says so, and SECURITY.md says what follows.
 */
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentProvider } from "../../../shared/agentKinds.ts";
import type { Envelope } from "../../../shared/orchestration.ts";
import { DENIED_COMMANDS, LEGACY_FLOOR, SWITCHABLE_COMMANDS, roleLaunch, type RoleId, type WorkerRole } from "../../../shared/workerRoles.ts";
import { runsPersonHooks } from "./hooks.ts";
import { refusal } from "../../../shared/refusal.ts";
import { MCP_READONLY_DENY } from "../../../shared/mcpReadonly.ts";

/** The four things an envelope may lift from the floor, and nothing else.
 *  `worktree` is not applied by `allowWithin`: it needs Claude Code's own
 *  sandbox holding, which only `deniedFor`'s fourth argument carries. */
export const LIFTS: Readonly<Record<"commit" | "network" | "docker" | "worktree", readonly string[]>> = {
  commit: ["git commit"],
  network: ["curl", "wget"],
  docker: ["docker"],
  worktree: ["git merge", "git reset", "git checkout", "git switch", "git clean", "git worktree remove", "git worktree prune", "git worktree list"],
};

/**
 * A flow role's `allow`, cut to what this ceiling already permits: only the
 * commands one of LIFTS takes off the floor, and only when the ceiling has that
 * flag on. Anything else — `git merge`, `aws`, `curl` with the network off — is
 * wider than every ceiling and is dropped. `deniedFor` cuts the result again to
 * the worker's own envelope, so a grant never outruns what the start stamped.
 * `NEVER_LIFTABLE` is refused when the flow is saved; it is not in LIFTS, so it
 * is dropped here too.
 */
export function allowWithin(allow: readonly string[] | undefined, ceiling: Envelope): string[] {
  const lifted = new Set<string>([
    ...(ceiling.commit ? LIFTS.commit : []),
    ...(ceiling.network ? LIFTS.network : []),
    ...(ceiling.docker ? LIFTS.docker : []),
  ]);
  return (allow ?? []).filter((c) => lifted.has(c));
}

/** What a worker may not reach through its engine: this app's own doors. A
 *  worker that could call them could start workers or change a setting. */
export const WORKER_DENIED = ["agentglass-agent", "agentglass-ui", "agentglass-browser", "agentglass-cockpit-mcp"] as const;

/** The one door a role may use: the app's browser, through its MCP server or,
 *  where the shell is not sandboxed, its CLI at the local relay. The other three
 *  stay closed to every role, and a scout keeps this one closed because it
 *  reports and does not interact. */
export const DOORS_FOR_ROLE: Readonly<Partial<Record<RoleId, readonly string[]>>> = {
  builder: ["agentglass-browser"],
  reviewer: ["agentglass-browser"],
  verifier: ["agentglass-browser"],
};

/** The deny-list entries a Read-only chosen server adds to the turn's
 *  `--settings`: every write tool of a known server set to Read-only,
 *  nothing for one set to All, and nothing for an unknown server (which
 *  `serverSettings.ts` validate never lets reach Read-only in the first
 *  place). */
export function mcpDenyFor(servers: readonly { name: string; mode?: "readOnly" | "all" }[]): string[] {
  const out: string[] = [];
  for (const s of servers) if (s.mode === "readOnly") out.push(...(MCP_READONLY_DENY[s.name] ?? []));
  return [...new Set(out)];
}

/** The browser as an MCP server (`bin/agentglass-browser-mcp`): the key a
 *  worker's `--mcp-config` holds it under, and the prefix of its tool names. */
export const BROWSER_SERVER = "agentglass-browser";

/* Q89, the wiring decision: the browser reaches an OpenCode worker exactly as it
 * reaches a Claude one. ONE predicate (DOORS_FOR_ROLE, the role's door; whether
 * the person's "Who may drive the browser" rows let the tab drive is decided at
 * the window by agentWindowEnv, for every engine) says whether the entry exists,
 * and ONE command is in it. Claude takes it as `--mcp-config` (mcpConfigFor),
 * OpenCode as the `mcp` section of its lock (openCodeMcpFor). No door, no entry,
 * on both. The tab name (--as) is the worker's own name, AGENTGLASS_BROWSER_AS in
 * its window env, which the MCP child inherits; `tabName` pins it in the entry. */
export function browserMcpCommand(role: WorkerRole): string | null {
  return DOORS_FOR_ROLE[role.base ?? role.id]?.includes(BROWSER_SERVER) ? "agentglass-browser-mcp" : null;
}

/** OpenCode's `mcp` config section for the browser: empty where Claude gets no entry. */
export function openCodeMcpFor(role: WorkerRole, tabName?: string): { mcp?: Record<string, unknown> } {
  const command = browserMcpCommand(role);
  if (!command) return {};
  return { mcp: { [BROWSER_SERVER]: { type: "local", command: [command], enabled: true, ...(tabName ? { environment: { AGENTGLASS_BROWSER_AS: tabName } } : {}) } } };
}
/** The read-only GitHub door as an MCP server (`bin/agentglass-gh-mcp`). */
export const GH_SERVER = "agentglass-gh";
/** The commit door as an MCP server (`bin/agentglass-commit-mcp`): builder roles only. */
export const COMMIT_SERVER = "agentglass-commit";
/** Whether a role is given the commit door: a builder, or a flow role based on one, with a compiled envelope that writes. A start with no envelope (the plain path) gets no door. */
export const hasCommitDoor = (role: { id: string; base?: string; readOnly?: boolean }, e?: { write?: string }): boolean =>
  (role.base ?? role.id) === "builder" && !role.readOnly && !!e && e.write !== "none";

/** The browser MCP tools that only look, by the names the server gives them
 *  (`browserdrive.ts` `OBSERVE_OPS`, without the one verb that acts when given
 *  an argument: `browser_cookies` with `set` writes the jar). A read-only role
 *  is allowed these and nothing else. `browser_record` is not one: the app's
 *  own process makes its directory and writes the frames and the gif there,
 *  outside the shell, so a role that may only look has no business calling it. */
export const BROWSER_READ_TOOLS = [
  "browser_read", "browser_markdown", "browser_extract", "browser_links", "browser_count", "browser_search",
  "browser_interactive", "browser_forms", "browser_attr", "browser_screencast", "browser_shot", "browser_text",
  "browser_html", "browser_console", "browser_network", "browser_observe", "browser_tabs", "browser_frames",
  "browser_health", "browser_waitfor", "browser_wait", "browser_vitals", "browser_a11y", "browser_listeners",
  "browser_profiles", "browser_events", "browser_audit", "browser_pdf", "browser_har",
  "browser_region", "browser_save", "browser_whoami", "browser_done", "browser_tools", "browser_lane",
] as const;

/** Every tool of Claude Code / Qwen Code a flow `tools` list can narrow. */
const ENGINE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task", "Agent"] as const;
/** The flow editor's words for groups of them; any other entry is an engine tool name. */
const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  read: ["Read", "Glob", "Grep"],
  run: ["Bash"],
  commit: ["Bash"],
  write: ["Edit", "Write", "NotebookEdit"],
  web: ["WebFetch", "WebSearch"],
};

/** What a worker needs to report (`agentglass-agent need` runs in Bash, the rest reads and messages): no `tools` list removes them. */
export const ALWAYS_ALLOWED = ["Bash", "Read", "SendMessage"] as const;

/**
 * Engine tools a flow `tools` list denies: all of ENGINE_TOOLS it does not
 * name. Empty list = nothing denied. ALWAYS_ALLOWED are never denied. Bash stays open so a worker can report, so a read-only role still has a shell that can write a file: the edit tools are closed, the shell is not a wall. Deny only: an allowed tool the ceiling refuses stays refused.
 */
export function toolsDeniedFor(tools: readonly string[] | undefined): string[] {
  if (!tools?.length) return [];
  const keep = new Set<string>();
  for (const n of ALWAYS_ALLOWED) keep.add(n.toLowerCase());
  for (const t of tools) for (const n of TOOL_ALIASES[t.trim().toLowerCase()] ?? [t.trim()]) keep.add(n.toLowerCase());
  return ENGINE_TOOLS.filter((n) => !keep.has(n.toLowerCase()));
}

/** The envelope under a saved flow role's lock: narrower or equal, never wider. */
export function narrowEnvelope(e: Envelope, lock: { readsOnly: boolean; tools: string[] } | null): Envelope {
  if (!lock) return e;
  const out: Envelope = lock.readsOnly ? { ...e, write: "none" } : e;
  return lock.tools.length ? { ...out, tools: [...lock.tools] } : out;
}

/** The command prefixes the engine's lock denies for this envelope: the floor, then only what was narrowed. */
export function deniedFor(e: Envelope, role?: WorkerRole, opened: readonly string[] = [], sandboxHeld: boolean = false, closed: readonly string[] = [], legacyOpen?: readonly string[]): string[] {
  // A worker has its seat's powers. What is denied is the floor, what the
  // envelope's flags narrowed at start, the switchable commands a project has
  // not opened, and the envelope's own `deny`.
  const narrowed = [
    ...(e.commit ? [] : LIFTS.commit),
    // curl and wget are the sandbox's to hold (its domain list) when it holds the turn.
    ...(e.network || sandboxHeld ? [] : LIFTS.network),
    ...(e.docker ? [] : LIFTS.docker),
    ...(e.worktreeOps ? [] : LIFTS.worktree),
  ];
  // A role's `allow` cannot take back what the seat narrowed: the envelope's flags are the bound.
  const allowed = new Set<string>(role ? DOORS_FOR_ROLE[role.base ?? role.id] ?? [] : []);
  // An engine that runs none of the person's hooks (`legacyOpen` given) keeps the floor main had: the flags and the commands a project opened still lift it.
  const lifted = new Set<string>([...(e.commit ? LIFTS.commit : []), ...(e.network ? LIFTS.network : []), ...(e.docker ? LIFTS.docker : []), ...(legacyOpen ?? [])]);
  const out = [
    ...(legacyOpen ? LEGACY_FLOOR.filter((c) => !lifted.has(c)) : []),
    ...DENIED_COMMANDS,
    ...narrowed,
    ...SWITCHABLE_COMMANDS.filter((c) => closed.includes(c)),
    ...WORKER_DENIED.filter((c) => !allowed.has(c) && !opened.includes(c)),
    ...e.deny,
  ];
  return [...new Set(out)];
}

/** The paths that hold the app's own credentials (`auth.ts` token,
 *  `usagekey.ts` key): the config dir spelled and resolved, plus where each
 *  credential FILE really points, because a symlinked token lives elsewhere and
 *  a deny on the dir alone would not cover its target. A worker that reads the
 *  token logs itself in as the person, so no role, engine or setting may open it. */
export function appSecretDirs(): string[] {
  const d = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
  const out = [d];
  const real = (p: string): void => { try { out.push(realpathSync(p)); } catch { /* not made yet: the spelled path is all there is */ } };
  real(d);
  for (const f of SECRET_FILES) real(join(d, f));
  return [...new Set(out)];
}

/** The credential files the server writes into that dir. */
const SECRET_FILES = ["token", "opencode-usage-key"] as const;

/** The Read-tool deny rules for those paths (`//` marks an absolute path). */
export function secretReadDeny(dirs: readonly string[]): string[] {
  return dirs.flatMap((d) => [`Read(/${d}/**)`, `Read(/${d})`]);
}

/** Shell-line globs that name the credential dir in the spellings a prefix
 *  rule can see: the absolute path, `~/.config/agentglass`, `$HOME/...`,
 *  `${HOME}/...`, `$XDG_CONFIG_HOME/agentglass`, and a bare `agentglass/token`
 *  (what is left after a `cd`). CEILING: a rule over the text of a command
 *  line cannot catch a path the shell builds (`d=.config; cat ~/$d/agent*\/tok*`,
 *  `cd ~/.config; cd agent*; cat tok*`), and `cd agentglass` cannot be denied
 *  because the repo is called agentglass. Where the shell is sandboxed the
 *  sandbox `filesystem.denyRead` is the wall; these only close the lazy
 *  spellings on a turn that has no sandbox (OpenCode, Qwen, or Claude without
 *  bubblewrap / with a lifted network or docker). */
export function secretShellGlobs(dirs: readonly string[]): string[] {
  return [...new Set([
    ...dirs.map((d) => `*${d}*`),
    "*.config/agentglass*", "*XDG_CONFIG_HOME*agentglass*",
    ...SECRET_FILES.map((f) => `*agentglass/${f}*`),
  ])];
}

/** The globs that deny a command wherever it sits in a line: word-bounded, so
 *  `cat gh.txt` still runs, and any line that names one of the app's own doors
 *  is denied. A shell can still build a command line these do not read. */
function anywhere(c: string): string[] {
  if (c.startsWith("agentglass-")) return [`*${c}*`];
  const words = c.split(" ");
  return [...(words.length > 1 ? [`*${words.join("*")}*`] : []), `* ${c} *`, `* ${c}`, `*/${c} *`, `*/${c}`];
}

export type Compiled =
  | { ok: true; args: string[]; env: Record<string, string>; partly?: string }
  | { ok: false; error: string };

/** Where the lock files go: beside the rest of the app's state, owner-only. */
export function envelopeDir(): string {
  const state = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(state, "worker-locks");
}

/** OpenCode's config layers that come from the environment; see agentops.ts
 *  (`OPENCODE_ENV_LAYERS`), which pins them so the lock check and the window
 *  read the same set. */
const OPENCODE_LAYERS = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION", "OPENCODE_DISABLE_PROJECT_CONFIG"];

/** What a start on Claude Code or Qwen Code says about its own lock. */
const PREFIX_LOCK = "the lock is a list of command prefixes: the same command spelled another way (git -C . push, /usr/bin/git push) is not refused by it";

/** What a Claude turn says when its shell also runs in the CLI's own sandbox. */
const SANDBOX_LOCK = "the shell runs inside Claude Code's own sandbox (no network, no Unix sockets unless Settings ▸ Orchestration ▸ Worker Unix sockets lifts it, writes only where the envelope allows, and not a hooks directory or a submodule's git dir unless Settings ▸ Orchestration ▸ Worker git internals lifts it), and the deny list beside it is still a list of command prefixes";

/** Why network and docker are the two flags that default to off: said in the refusal text of a worker that meets them. */
export const NETWORK_DOCKER_OFF = refusal("sandbox", "network and docker are off by default because either one drops Claude Code's sandbox, the only wall around the app's token", "no open network or docker daemon");

/** Why a Claude turn's shell runs unsandboxed, when nothing holds it inside
 *  the sandbox: a lifted network or docker. */
const UNSANDBOXED: Readonly<Record<"network" | "docker", string>> = {
  network: "the envelope lets this worker out to the network, which Claude Code's sandbox cannot be given, so the shell is NOT sandboxed: writes and the network are held only by the prefix lock",
  docker: "the envelope lifts docker, whose daemon socket the sandbox refuses, so the shell is NOT sandboxed: writes, the network and docker are held only by the prefix lock",
};

/**
 * Whether Claude Code's own sandbox can hold this envelope for this role.
 *
 * Every worker whose envelope does not lift the network or docker is sandboxed,
 * whatever it writes and whether or not its role has the browser door: its
 * shell writes only where the envelope allows, and the browser is reached
 * through the MCP server the turn is given, which runs outside that shell.
 *
 * Two ceilings, measured on the installed CLI (2.1.318): `allowedDomains`
 * refuses `*` ("overly broad patterns ... are not allowed"), so an envelope
 * that lets the worker out has no sandbox that keeps it out; and a Unix socket
 * outside the worktree is refused inside it (`tmux -L x` → "error connecting to
 * /tmp/tmux-1000/x (Operation not permitted)"), so an envelope that lifts
 * `docker` would lose the daemon's socket. Those turns keep the deny list, and
 * `unsandboxedBecause` says so in the start's answer and on the row.
 */
export function sandboxHolds(_role: WorkerRole, e: Envelope): boolean {
  return !e.network && !e.docker;
}

/** What a Claude turn says when the sandbox cannot hold its envelope. Null when
 *  the sandbox is not the question (another engine, or an envelope it holds). */
export function unsandboxedBecause(role: WorkerRole, e: Envelope): string | null {
  if (sandboxHolds(role, e)) return null;
  return e.docker ? UNSANDBOXED.docker : UNSANDBOXED.network;
}

/**
 * The lock for one engine under one envelope: the flags and environment the
 * start adds. Claude Code, OpenCode and Qwen Code have a lock this app writes;
 * Codex gets sandbox flags and Hermes the person's own deny list. Every one is
 * said out loud as "partly": none of them is a wall.
 */
export function compileEnvelope(
  engine: string, role: WorkerRole, e: Envelope, model: string, dir: string = envelopeDir(), opened: readonly string[] = [], closed: readonly string[] = [], never: { prefixes: readonly string[]; exact: readonly string[] } = { prefixes: [], exact: [] },
  legacyOpen: readonly string[] = [],
): Compiled {
  const p = agentProvider(engine);
  if (!p) return { ok: false, error: `${engine} is not an engine this app knows` };
  // A role that only reads, or an envelope that writes nothing, gets no edits.
  const effective: WorkerRole = { ...role, readOnly: role.readOnly || e.write === "none" };
  // The one argument `allowWithin` does not need: `git merge`/`reset`/etc lift
  // only inside Claude Code's own sandbox, so this is computed once, here,
  // before the one call to `deniedFor` below, and every other engine keeps
  // these commands denied even with `worktreeOps` on.
  if (engine === "codex") {
    return { ok: true, args: [], env: { AGENTGLASS_ROLE: role.id }, partly: "Codex has no command deny list: its permission profile (write the worktree only, app config and state unreadable) is the limit, and its network rule is its own" };
  }
  if (engine === "hermes") {
    return { ok: true, args: [], env: { AGENTGLASS_ROLE: role.id }, partly: "Hermes refuses what its own approvals.deny lists; this app checks that list but does not write it" };
  }
  if (!p.lock) return { ok: false, error: `${p.title} has no lock this app can apply, so it cannot run as a worker` };
  const denied = deniedFor(e, effective, opened, engine === "claude" && sandboxHolds(effective, e), closed, runsPersonHooks(engine) ? undefined : legacyOpen);
  // Task (the Agent tool) is denied unless the role's lock grants
  // mayStartSubagents, whatever the tools list says: an empty list denies
  // nothing, so keying it off the list let a role with no tools start
  // subagents without the switch or its approval card.
  const toolDeny = [...toolsDeniedFor(e.tools).filter((t) => t !== "Task" && t !== "Agent"), ...(effective.mayStartSubagents ? [] : ["Agent", "Task"])];
  const launch = roleLaunch(p, effective, model, denied, toolDeny);
  if (!launch) return { ok: false, error: `${p.title} has no lock this app can apply, so it cannot run as a worker` };
  // The role the CLI sees, so it can refuse the person's own identity: a
  // worker only acts in its own tab (bin/agentglass-browser, `is_shared_identity`).
  const env: Record<string, string> = { ...launch.env, AGENTGLASS_ROLE: role.id };
  // The app's own credentials, shut to every role on every engine. Not read
  // from the envelope or a flow, so no setting can lift it.
  const secrets = appSecretDirs();
  if (engine === "claude") {
    const lock = JSON.parse(launch.args[1]!) as { permissions: { deny: string[] } };
    lock.permissions.deny.push(...secretReadDeny(secrets));
    // No sandbox on this turn (network or docker lifted): the shell can read
    // what Read cannot, so the shell lines are refused too. Ceiling above.
    if (!sandboxHolds(effective, e)) lock.permissions.deny.push(...secretShellGlobs(secrets).map((g) => `Bash(${g})`));
    launch.args[1] = JSON.stringify(lock);
  } else if (launch.file) {
    const lock = JSON.parse(launch.file.content) as { permissions: { deny: string[] } };
    lock.permissions.deny.push(...secretReadDeny(secrets), ...secretShellGlobs(secrets).map((g) => `Bash(${g})`));
    launch.file.content = JSON.stringify(lock, null, 2) + "\n";
  }
  if (engine === "claude" && !e.network) {
    // Its shell prefixes do not cover its own network tools, and a settings file
    // of the person's or the repo's may allow them.
    const lock = JSON.parse(launch.args[1]!) as { permissions: { deny: string[] } };
    lock.permissions.deny.push("WebFetch", "WebSearch");
    launch.args[1] = JSON.stringify(lock);
  }
  if (engine === "opencode" && p.lock.via === "env") {
    // An unlisted tool is allowed under a headless run (measured), so the
    // network tool is denied by name unless the envelope lets the worker out.
    type Perm = Record<string, any>;
    const cfg = JSON.parse(env[p.lock.env]!) as { permission: Perm; agent: { build: { permission: Perm } } };
    if (!e.network) { cfg.permission.webfetch = "deny"; cfg.agent.build.permission.webfetch = "deny"; }
    // Later rules win in OpenCode, so the catch-all comes first. Its shell is
    // open, so a line that names the directory is refused too.
    const read: Record<string, string> = { "*": "allow" };
    for (const d of secrets) { read[`${d}/**`] = "deny"; read[d] = "deny"; }
    for (const g of secretShellGlobs(secrets)) cfg.permission.bash[g] = "deny";
    cfg.permission.read = cfg.agent.build.permission.read = read;
    Object.assign(cfg, openCodeMcpFor(role));
    // The build agent inherits the global bash rules, so they are held once: the lock rides in a window's command line and tmux refuses one over ~16 KB.
    delete cfg.agent.build.permission.bash;
    // Its shell is allowed unless a rule says otherwise, and a rule matches the
    // whole line: `git push` does not match `env git push` or `/usr/bin/git
    // push`. So each denied command is also denied wherever it sits in a line.
    for (const c of denied) for (const g of anywhere(c)) cfg.permission.bash[g] = "deny";
    // The project's never-rules, compiled into the same lock. `ask` has no form here: the engine asks nobody, so only never reaches it.
    for (const c of never.prefixes) for (const g of anywhere(c)) cfg.permission.bash[g] = "deny";
    for (const c of never.exact) cfg.permission.bash[c] = "deny";
    env[p.lock.env] = JSON.stringify(cfg);
    for (const k of OPENCODE_LAYERS) env[k] = process.env[k] ?? "";
  }
  if (launch.file) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${role.id}-${engine}-envelope.json`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, launch.file.content, { mode: 0o600 });
    renameSync(tmp, path);
    env[launch.file.env] = path;
  }
  const partly = engine === "opencode"
    ? "the lock is a list of patterns over the command line: a line a shell builds around a command is not refused by it"
    : engine === "claude"
      ? sandboxHolds(effective, e) ? SANDBOX_LOCK : unsandboxedBecause(effective, e) ?? PREFIX_LOCK
      : PREFIX_LOCK;
  return { ok: true, args: launch.args, env, partly };
}

/**
 * The sentence a worker's own brief gets when `compileEnvelope` is about to
 * deny it the browser CLI on purpose (`noBrowserCli` above): true exactly
 * when the sandbox holds this envelope and the role's one door is the
 * browser. Without this, the worker calls `agentglass-browser` the way its
 * role prompt tells it to, hits a bare denial, and is never told the MCP
 * tools are its door instead. `prompt` unchanged when the condition does not
 * hold.
 */
export function withBrowserCliNote(prompt: string, engine: string, role: WorkerRole, e: Envelope): string {
  if (engine !== "claude" || !sandboxHolds(role, e) || !DOORS_FOR_ROLE[role.base ?? role.id]?.includes(BROWSER_SERVER)) return prompt;
  const note = `${BROWSER_SERVER} is refused on this turn's own shell: its sandbox has no route to the relay the CLI speaks to. Use the browser_* MCP tools instead — they are this turn's door to it.`;
  return prompt.trim() ? `${prompt}\n\n${note}` : note;
}

/** Said once in every worker start answer: the defaults moved from closed to open, and stored values were left as they were. */
export const DEFAULTS_CHANGED = "worker commands are open by default; a project can close one in Settings ▸ Orchestration";
