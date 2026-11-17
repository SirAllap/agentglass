/*
 * Who may drive the built-in browser, at the launch path.
 *
 * The setting lives in `config.json` as `browserWorkers` and is read as every
 * engine and role unless the person turned something off. This module is the
 * one place that decides it, and the two mint sites call it in place of
 * `mintWorkerToken` directly: an engine or role that is off gets no credential,
 * and the worker's brief says so. Nothing here widens what a credential reaches
 * — that floor is in auth.ts and browserdrive.ts.
 *
 * A stored name this app does not know is dropped, never read as "all on": a
 * typo or a half hand-edit can only narrow, and a list with nothing known left
 * is nothing on.
 *
 * Two gaps this module cannot close. A server run without a token has no
 * identity to check, so `POST /browser/*` on it answers anyone on the machine
 * as the person, and an engine or role that is off here gets no credential but
 * needs none. Set AGENTGLASS_TOKEN to make this list mean anything. And a
 * hand-written process running as the same operating-system user could still
 * read the files the person can read; the worker envelope (sandbox) is what
 * limits that, not this list.
 */
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  BROWSER_ENGINES, BROWSER_ROLES, browserOffReason, cleanBrowserWorkers,
  readBrowserWorkers, type BrowserAskContext, type BrowserWorkers, type FlowRoleRow,
} from "../../shared/browserWorkers.ts";
import { AGENT_KINDS } from "../../shared/agentKinds.ts";
import { type RoleId, workerRole } from "../../shared/workerRoles.ts";
import { mintSeatToken, mintWorkerToken, revokeWorkerToken, WORKER_TOKEN_DEFAULT_MS, workerTokenLive, workerTokenOf } from "./auth.ts";
import { flowRoots, readStoredFlow, storedBrowserWorkers, writeBrowserWorkers } from "./config.ts";
import { shq } from "./shellmark.ts";

/**
 * Every flow role this server knows of, across every project with a saved
 * flow: the universe `browser.workers` validates "roles" against and a flow
 * role with no row of its own falls back through
 * (shared/browserWorkers.ts `fallbackRow`). Nothing here is cached, so a flow
 * saved a moment ago is seen on the next call. Each row carries its `root`,
 * and the setting names it by root plus id: two projects may both have an
 * "ops", and ticking one is not ticking the other. A flow role can never
 * collide with a built-in's id.
 *
 * That union is only the universe of NAMES. A role's base (`policyRole`) is
 * per project, so the answer for one worker comes from `flowRolesOf(root)`:
 * project B's "ops" (a scout) must never borrow project A's "ops" (a builder).
 * `only` reads that one root.
 */
export function knownFlowRoles(only?: string): FlowRoleRow[] {
  const out: FlowRoleRow[] = [];
  for (const root of only ? [only] : flowRoots()) {
    const flow = readStoredFlow(root);
    if (!flow) continue;
    const seen = new Set<string>();
    for (const r of flow.roster) {
      if (workerRole(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, policyRole: r.policyRole, root });
    }
  }
  return out;
}

/** The flow roles of the worker's own project and no other; with no project, none. */
export function flowRolesOf(root?: string): FlowRoleRow[] {
  return root ? knownFlowRoles(root) : [];
}

/**
 * The flow roles a caller of the settings door may SEE (names, project paths).
 * The person sees every project's; a seat only its own project's; a worker, or
 * any other agent principal, none. This is what the Settings ▸ Browser page
 * lists, so it must not hand one project's paths and role names to another's.
 */
export function flowRolesVisibleTo(caller: { principal?: string; seat?: { root?: string } } | null | undefined): FlowRoleRow[] {
  const who = caller?.principal;
  if (!who || who === "understudy") return knownFlowRoles();
  if (who === "seat") return caller?.seat?.root ? knownFlowRoles(caller.seat.root) : [];
  return [];
}

/** What is in force: the stored lists with unknown names dropped, every one when there is nothing stored. */
export function browserWorkersNow(): BrowserWorkers {
  return readBrowserWorkers(storedBrowserWorkers(), knownFlowRoles());
}

/** The setting's own validation (the settings door), and the write. */
export function validateBrowserWorkers(raw: unknown): { value: BrowserWorkers } | { error: string } {
  return cleanBrowserWorkers(raw, knownFlowRoles());
}

export function saveBrowserWorkers(v: BrowserWorkers): { ok: true } | { ok: false; error: string } {
  const r = writeBrowserWorkers(v);
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "could not save it" };
}

/** The variables a credential arrives in. A worker whose engine or role is off
 *  must not inherit the person's: a tmux window takes the SERVER's environment,
 *  so leaving them unset lets `AGENTGLASS_TOKEN` through, and setting them
 *  empty is no better — a CLI that finds an empty one falls back to the
 *  person's token file. They are removed from the window instead. */
export const BROWSER_CREDENTIAL_VARS = ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"] as const;

/** Set by the app on a window it hands no credential: the supplied CLI and MCP
 *  server refuse every verb under it rather than fall back to the machine
 *  identity. Only the name is passed; it carries no secret. */
export const BROWSER_OFF_VAR = "AGENTGLASS_BROWSER_OFF";

/** Set beside `BROWSER_OFF_VAR` with the sentence that says which setting turned
 *  it off. A sentence, never a secret: the supplied CLI prints it, and it is
 *  what a person reads instead of being sent to /proc to find out. */
export const BROWSER_OFF_REASON_VAR = "AGENTGLASS_BROWSER_OFF_REASON";

/** The reason a window gets when a caller handed it no credential WITHOUT
 *  going through `agentWindowEnv` at all — a path that bypassed the one
 *  door, rather than the door itself answering off. Named so the supplied
 *  CLI's refusal points at the bypass instead of claiming a Settings row
 *  that was never consulted (the brief this answers: a silent OFF is a bug,
 *  never a setting). */
export const BROWSER_OFF_BYPASS_REASON =
  "this window was opened by a path that never asked Settings ▸ Browser — a bug, not a setting";

/** What an agent window must not inherit: the credentials, and the marker that
 *  belongs to the window it was set for. */
const BROWSER_WINDOW_VARS = [...BROWSER_CREDENTIAL_VARS, BROWSER_OFF_VAR, BROWSER_OFF_REASON_VAR] as const;

/** The environment handed to a tmux CLIENT, without the four credential
 *  variables. tmux gives its server the client's environment, so a server this
 *  app starts must never see one: otherwise a pane can ask the server for it by
 *  name however carefully the pane itself was stripped. */
export function withoutBrowserCredentials<T extends Record<string, string | undefined>>(env: T): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const v of BROWSER_CREDENTIAL_VARS) delete out[v];
  return out;
}

/** The same, for a client whose environment carries the OFF marker as well. A
 *  server born from a worker's pty would keep the marker in its global
 *  environment, and every pane — the person's included — would then read as
 *  switched off. */
export function withoutBrowserWindowVars<T extends Record<string, string | undefined>>(env: T): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const v of BROWSER_WINDOW_VARS) delete out[v];
  return out;
}

/** The credential a PERSON's own window or pane is handed explicitly. tmux no
 *  longer starts with the server's environment, so the four variables have to
 *  travel on the window (`-e`) rather than be inherited from the tmux server.
 *  Only the ones the server actually holds: an empty token is worse than none,
 *  because a supplied CLI falls back to the person's token file on an empty
 *  one. */
export function personPaneEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of BROWSER_CREDENTIAL_VARS) {
    const value = base[v];
    if (value) out[v] = value;
  }
  return out;
}

/**
 * A credential handed to a pane that is about to be the FIRST window of a new
 * tmux session, never through `-e` on `new-session`.
 *
 * `-e` on a session that does not exist yet writes the SESSION's environment,
 * not just the window's: `tmux show-environment` with no `-t` resolves to the
 * current session, so any window that session gets afterwards — a worker's,
 * or a person's own next tab — reads the value back by name (measured on tmux
 * 3.8: `new-session -d -e K=V` then `new-window "tmux show-environment"`
 * prints `K=V`; `new-window -e` and `split-window -e` do not). `new-session
 * -e` on a session that already exists does not write it either, which is why
 * this is only needed at the moment a session is created.
 *
 * The value also never goes on the command: tmux keeps a pane's own start
 * command in `#{pane_start_command}` for as long as the pane lives, and that
 * format is queryable by ANY pane that knows this one's id — the same
 * exposure `-e` has, by a different route. So the secret goes in a FILE the
 * window's own command reads once and deletes, and only the file's path ever
 * appears in anything tmux remembers.
 *
 * CEILING, named rather than hidden: once the pane's process is running, a
 * same-uid process on this machine can still read the value from that pane's
 * own `/proc/<pid>/environ`. Nothing here closes that — see SECURITY.md.
 */
/** The directory `sessionCredentialFile` writes into: the fixed path when it
 *  is, or can be made, a private directory of ours — a real directory (not a
 *  symlink an attacker left there), owned by this process's uid, mode 0700 —
 *  and a freshly minted private one otherwise. `mkdirSync` on an existing path
 *  succeeds silently and checks nothing, so an existing entry at the fixed
 *  path that fails any of those is never reused: a pre-created directory on a
 *  shared machine, or a symlink to one, would otherwise let another uid delete
 *  or displace the credential files written into it. */
function credDir(): string {
  const fixed = join(tmpdir(), "agx-cred");
  try {
    const st = lstatSync(fixed);
    if (st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o777) === 0o700) return fixed;
  } catch {
    try { mkdirSync(fixed, { mode: 0o700 }); return fixed; } catch { /* raced, or not ours to make */ }
  }
  return mkdtempSync(join(tmpdir(), "agx-cred-"));
}

export function sessionCredentialFile(env: Record<string, string>): string | null {
  if (!Object.keys(env).length) return null;
  const dir = credDir();
  const file = join(dir, `h-${process.pid}-${randomBytes(9).toString("hex")}`);
  const body = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n") + "\n";
  const fd = openSync(file, "wx", 0o600);
  try { writeSync(fd, body); } finally { closeSync(fd); }
  return file;
}

/** Deletes the file `sessionCredentialFile` wrote, for the caller whose
 *  `new-session`/`new-window` then failed: the window that would have sourced
 *  and removed it never ran, so nothing else deletes it. A no-op on `null`
 *  (no credential was written) or a file already gone. */
export function discardCredentialFile(file: string | null): void {
  if (!file) return;
  try { unlinkSync(file); } catch { /* already gone */ }
}

/**
 * The command a new session's first window runs when it must carry a
 * credential: source the file `sessionCredentialFile` wrote, delete it, then
 * exec the real command — or the person's own shell when there is none.
 * `plain` rides the same line as plain `K=V` (never a secret: owner
 * attribution, not a token), the way `env` already did before this existed.
 */
export function sessionCredentialArgv(
  file: string | null,
  plain: Record<string, string>,
  drops: readonly string[],
  argv: readonly string[],
): string[] {
  const run = argv.length ? argv.map(shq).join(" ") : `"$SHELL"`;
  const assigns = Object.entries(plain).map(([k, v]) => `${k}=${shq(v)}`);
  const exec = assigns.length ? `exec env ${assigns.join(" ")} ${run}` : `exec ${run}`;
  const body = [...drops.map((v) => `unset ${v}`), ...(file ? [`. ${shq(file)}`, `rm -f ${shq(file)}`] : []), exec].join("; ");
  return ["sh", "-c", body];
}

/** The environment for a shell opened with an AGENT's principal but no window
 *  route: the door's removals, plus the marker that stops the supplied CLI
 *  falling back to the person's token file. */
export function agentShellEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = withoutBrowserCredentials(base);
  out[BROWSER_OFF_VAR] = "1";
  out[BROWSER_OFF_REASON_VAR] = "this shell was opened with an agent's credential, not the person's";
  return out;
}

/**
 * The name a credential minted for a window the layout route started
 * carries: the server's own session and window id, never the caller's
 * title — plus the engine's own identity (`pid.start_time`, from
 * `tmuxpane.ts`'s `engineIdentity`).
 *
 * A window id alone is not one. tmux restarts its counter at `@0` after the
 * server dies, and the credential this app mints lives up to 12h: without
 * the engine in the name, a tab made `@1` on the NEW server would be handed
 * whatever token `@1` on the OLD one still held — the two could not be told
 * apart. `engine` is required rather than defaulted so that a mint and the
 * matching revoke can never silently drift onto two different names.
 */
export function layoutCredentialName(session: string, windowId: string, engine: string): string {
  return `layout:${session}:${windowId}:${engine}`;
}

/**
 * The one door for a window or process that runs an AGENT.
 *
 * A tmux window inherits the SERVER's environment, so an agent handed no
 * credential of its own still arrives holding the person's machine token. This
 * cannot tell an inherited token from a handed-down one by looking at the
 * process, so it looks at what the caller passed in `env`: a start that means
 * the agent to have a credential puts it there (a role's minted `wk_`, a seat's
 * token), and `env` without one is an agent with none — the variables are
 * removed before the command runs. Emptying is not enough: a CLI that reads an
 * empty token falls back to the person's token file.
 *
 * The person's own terminals do not come through here: a bench, the console and
 * a tab they opened by hand pass `person` to the window opener and keep exactly
 * the environment they had.
 */
export function agentWindowDrops(env: Record<string, string> | undefined): readonly string[] {
  /* A credential the caller handed over does not vouch for its siblings: one
     the server itself holds (a `WORKER_TOKEN` left in its own environment) is
     still removed, or it would shadow the one the window was given. */
  return BROWSER_WINDOW_VARS.filter((v) => !env?.[v]);
}

export interface AgentWindowCredential {
  /** Exactly what the window's environment becomes: the caller's base plus the
   *  credential, or the off marker when there is none. */
  env: Record<string, string>;
  token: string | null;
  /** Why there is no credential, in the words the brief and the self-check
   *  repeat; null when there is one. */
  off: string | null;
}

export interface AgentWindowAsk {
  /** The tab's own name. The credential is minted for it, and it is handed over
   *  so the relay can tell whose container it is. */
  name: string;
  engine: string;
  /** A worker role, when the launch names one. Empty is a tab with no role — a
   *  seat, a named agent, a pane a restore brought back — and only the engine
   *  can turn it off. */
  role?: RoleId | string;
  /** A seat also carries the project and the powers its chair was given. */
  seat?: { root: string; powers: "speak" | "nudge" | "assign" };
  /** The project the worker runs for: its flow roles are read from here and nowhere else. A seat's is its own root. */
  root?: string;
  base?: Record<string, string>;
  ttlMs?: number;
  replace?: boolean;
  /** Which row of Settings ▸ Browser decides this ask, when it is not the
   *  plain engine/role pair: a flow role's own row. Left out, this door
   *  derives it itself — `seat` from `a.seat`, `cardTab` from an empty
   *  `a.role` — so a caller only ever sets this for a flow role. */
  ctx?: BrowserAskContext;
}

/**
 * THE ONE DOOR FOR AN AGENT WINDOW'S BROWSER CREDENTIAL.
 *
 * Every path that starts or restarts an agent tab builds its environment here:
 * a seat, a worker role, a named agent, a card's tab, a flight-plan Launch, a
 * pane a restore brought back, and the lowest door in `startAgent` for any path
 * added later. The credential is minted FOR THE TAB (`wk_` for a worker, `st_`
 * for a seat), never the person's machine token, and the tab is handed its own
 * name so the relay serves it its own container.
 *
 * On by default. Off only when the person turned that engine — or that worker
 * role — off in Settings ▸ Browser: then the window is marked
 * `AGENTGLASS_BROWSER_OFF` and carries no credential at all, which is the
 * reason `agentWindowDrops` exists: a tmux window inherits the server's
 * environment, so leaving a variable unset hands over the machine token.
 */
export function agentWindowEnv(a: AgentWindowAsk): AgentWindowCredential {
  /* A base the caller hands over is not trusted with a credential: whatever it
     holds is removed, and what this decides is the only one in the answer. */
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.base ?? {})) {
    if (!(BROWSER_WINDOW_VARS as readonly string[]).includes(k)) env[k] = v;
  }
  const role = a.role ?? "";
  /* A caller who names its own `ctx` (a flow role) is trusted over the
     derivation below; every other caller is unchanged from before `ctx`
     existed — a seat decided by its own row, an empty role (a card tab: a
     launch brief, a restore, a terminal-panel button) by `cardTabs`, and a
     named built-in role exactly as it always was (the empty `ctx` default). */
  const ctx: BrowserAskContext = a.ctx ?? (a.seat ? { seat: true } : !role ? { cardTab: true } : {});
  const why = browserOffReason(browserWorkersNow(), a.engine, role, ctx, flowRolesOf(a.root ?? a.seat?.root));
  if (why) {
    env[BROWSER_OFF_VAR] = "1";
    env[BROWSER_OFF_REASON_VAR] = why;
    /* A seat's token is what it speaks to this server with, not only what it
       browses with, so it keeps it: the supplied CLI refuses every browser verb
       under the marker, and the chair goes on answering its board. */
    const token = a.seat ? mintSeatToken(a.seat.root, a.seat.powers) : null;
    if (token) {
      env.AGENTGLASS_TOKEN = token;
      env.AGENTGLASS_SEAT = a.seat!.root;
    }
    noteWindow(a.name, "off", why);
    return { env, token, off: why };
  }
  delete env[BROWSER_OFF_VAR];
  const held = a.seat ? undefined : takeHeld(a.name);
  const token = a.seat
    ? mintSeatToken(a.seat.root, a.seat.powers)
    : held ?? mintWorkerToken(a.name, a.ttlMs, a.replace ?? true, a.root);
  env.AGENTGLASS_TOKEN = token;
  if (!a.seat) env.AGENTGLASS_WORKER_TOKEN = token;
  /* The browser CLI derives its identity from the directory when nothing names
     it, and the relay serves a worker only the container its own name opened.
     So the name the credential was minted for is handed over with it. */
  env.AGENTGLASS_PROFILE = a.name;
  env.AGENTGLASS_BROWSER_AS = a.name;
  if (a.seat) env.AGENTGLASS_SEAT = a.seat.root;
  noteWindow(a.name, "issued", null);
  return { env, token, off: null };
}

/** What the self-check says about one tab, and what it was last handed. */
export interface WindowCredential {
  /** `pending` is a credential minted for the tab's NEXT start: nothing has
   *  been handed to the process running now, and this server cannot see
   *  whether that one is still live. */
  state: "issued" | "off" | "pending";
  /** The reason for an off window, or null. */
  reason: string | null;
  at: number;
}

const handed = new Map<string, WindowCredential>();

/** Credentials minted by the self-check for a tab AND ITS NEXT START, so a
 *  re-issue is consumed instead of left unused. A seat is not held this way:
 *  seating revokes the project's credentials before it mints. */
const pending = new Map<string, string>();

/** Mint and keep a credential for this tab's next start (the re-issue route).
 *  A running process cannot be given one: an environment is fixed at exec.
 *
 *  `replace: false`, and the one already held is revoked: minting over the
 *  live one cut the credential the running tab holds, and the self-check then
 *  read the held one as live and drew a green dot for a tab just cut off.
 *
 *  `root` is the tab's project, the same as a fresh start would mint with
 *  (`agentWindowEnv`'s `a.root`) — the caller resolves it from the tab's own
 *  row, never from anything a request could name. A re-issue is a recovery
 *  path for a credential the server already minted once; it must come back
 *  confined the same way, not with no project at all. */
export function holdCredential(name: string, root?: string): string {
  const was = pending.get(name);
  if (was) revokeWorkerToken(was);
  const t = mintWorkerToken(name, WORKER_TOKEN_DEFAULT_MS, false, root);
  pending.set(name, t);
  noteWindow(name, "pending", null);
  return t;
}

/** The held credential, if the server still accepts it. A turn that ended
 *  revokes the credentials of its name; handing that one over started a tab on
 *  a token this server refuses, with no marker and no reason in its brief. */
function takeHeld(name: string): string | undefined {
  const t = pending.get(name);
  if (!t) return undefined;
  pending.delete(name);
  return workerTokenLive(t) ? t : undefined;
}

function noteWindow(name: string, state: WindowCredential["state"], reason: string | null, now = Date.now()): void {
  if (!name) return;
  handed.set(name, { state, reason, at: now });
}

/** What this process handed a tab, or null for a tab it did not open (one that
 *  was already running when this server started). Never the token. */
export function windowCredentialOf(name: string): WindowCredential | null {
  return handed.get(name) ?? null;
}

export function everyWindowCredential(): Record<string, WindowCredential> {
  return Object.fromEntries(handed);
}

/** For a test: forget what was handed, so one case cannot read another's. */
export function __forgetWindowCredentials(): void { handed.clear(); }

/**
 * What a direct tmux call needs for an agent window the door did not make: the
 * variables to put on the pane (`-e`), and the ones it must not inherit.
 *
 * The credential goes in `-e`, so it is not in the line the pane was born with
 * (`pane_start_command`), which the restore photographs into a file. The tmux
 * CLIENT's own argv carries the values for the length of the call, and
 * `/proc/<that pid>/cmdline` shows them while it runs; nothing of it is left
 * behind afterwards.
 */
export function agentWindowTmux(env: Record<string, string>): { set: [string, string][]; unsets: readonly string[] } {
  return { set: Object.entries(env), unsets: agentWindowDrops(env) };
}

/** What a window opened with a caller's own command runs with. */
export interface ArgvWindow {
  env: { set: [string, string][]; unsets: readonly string[] };
  /** The credential handed to it, for a caller that has to take it back when
   *  the window did not open; null when there is none to take back. */
  token: string | null;
}

/** The engine id whose CLI is this argv's head, or null: a command is an
 *  agent's tab only when its executable is one the agent table names. */
export function agentHeadOf(argv: readonly string[]): string | null {
  const head = (argv[0] ?? "").split("/").pop() ?? "";
  return AGENT_KINDS.find((k) => k.bin === head)?.id ?? null;
}

/**
 * The door for a window whose command the caller supplied (`POST
 * /terminal/tmux/windows`, which runs it in a window inheriting the SERVER's
 * environment).
 *
 * A head that names an agent CLI is that agent's tab: `agentWindowEnv` mints
 * for it, exactly as for a button's tab. Any other command is not an agent's —
 * not even one the person typed — so the browser's variables are removed and
 * the OFF marker is set. That is what stops a supplied CLI from falling back
 * to the person's token file, and stops the machine token in the server's
 * environment from reaching a stranger's command.
 *
 * `replace: false`: a window with this name that is already running keeps the
 * credential its process holds.
 */
export function argvWindowEnv(argv: readonly string[], name: string): ArgvWindow {
  const engine = agentHeadOf(argv);
  if (engine) {
    /* Two splits of one window carry the tab's own name, and that name is the
       tab's identity: hand a second one the credential the first was given
       instead of minting a second under the same name, which left the
       self-check row speaking for whichever was minted last.
       CEILING: the shared credential is revoked with the window, not when one
       split of it goes away. */
    const held = liveUnder(name);
    if (held) {
      noteWindow(name, "issued", null);
      return { env: agentWindowTmux({ AGENTGLASS_TOKEN: held, AGENTGLASS_WORKER_TOKEN: held, AGENTGLASS_PROFILE: name, AGENTGLASS_BROWSER_AS: name }), token: null };
    }
    const cred = agentWindowEnv({ name, engine, replace: false });
    return { env: agentWindowTmux(cred.env), token: cred.token };
  }
  const off = { [BROWSER_OFF_VAR]: "1" };
  return { env: { set: Object.entries(off), unsets: agentWindowDrops(off) }, token: null };
}

/** The credential a tab's name already holds, when this server still accepts
 *  it. Expired ones stay in the store until nothing asks; a dead credential is
 *  not one to hand over. */
function liveUnder(name: string): string | undefined {
  const t = workerTokenOf(name);
  return t && workerTokenLive(t) ? t : undefined;
}

/**
 * The same door, for a caller that already holds the environment object.
 * Writes the credential in place and answers it (null when off). Kept as an
 * adapter so no call site has to rebuild an object it was handed; the decision
 * itself is `agentWindowEnv`'s alone.
 */
export function mintBrowserCredential(
  env: Record<string, string>, name: string, engine: string, role: string,
  opts: { ttlMs?: number; replace?: boolean; ctx?: BrowserAskContext; root?: string } = {},
): string | null {
  const r = agentWindowEnv({ name, engine, role, base: env, ttlMs: opts.ttlMs, replace: opts.replace, ctx: opts.ctx, root: opts.root });
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, r.env);
  return r.token;
}

/** The browser line a tab is told about: `browser: ok`, or exactly why it has
 *  none, with the reason when there is one. `ctx` is opt-in and defaults to
 *  the plain engine/role pair, exactly as before a flow role had a row of its
 *  own — `seat.ts`'s own call keeps reading that way. `root` widens the plain
 *  role lookup to the flow roles of that project. */
function browserLine(engine: string, role: string, ctx: BrowserAskContext = {}, root?: string): { text: string; off: string | null } {
  const why = browserOffReason(browserWorkersNow(), engine, role, ctx, flowRolesOf(root));
  return { text: why ? `browser: ${why}` : "browser: ok", off: why };
}

/** The line an agent's brief and prompt carry about its browser: `browser: ok`,
 *  or the exact reason it is not. Required, not conditional — a must for agents
 *  is not a setting to notice by its absence.
 *
 *  A seat has no role to turn off, and its engine is the only thing that can
 *  turn it off — the same answer the door gives when it builds the window.
 *  That is what keeps a chair whose engine Settings ▸ Browser cannot name from
 *  being told it has no credential while the door hands it one. */
export function browserHealthLine(engine: string, role = "", ctx: BrowserAskContext = {}, root?: string): string {
  return browserLine(engine, role, ctx, root).text;
}

/**
 * The worker's brief, with the line it reads first when the browser is off.
 *
 * `browser: ok` is the brief's line (the seat's, above), not the task's: a
 * worker's prompt is exactly what the person asked, plus the contract, and a
 * healthy browser needs no sentence there. The reason it has NO browser does,
 * because it changes what the agent can do — so that line, and only that line,
 * leads the prompt.
 */
export function withBrowserLine(prompt: string, engine: string, role: string, ctx: BrowserAskContext = {}, root?: string): string {
  const { text, off } = browserLine(engine, role, ctx, root);
  if (!off) return prompt;
  // A flow role with no base: the no-base note (withNoBaseNote) already says why; this line would blame a setting.
  if (ctx.flowRole && !ctx.flowRole.base) return prompt;
  return prompt.trim() ? `${text}\n\n${prompt}` : text;
}

/**
 * THE START PATHS, ONE ROW EACH, AND THE TEST THAT HOLDS THEM.
 *
 * Every way an agent tab is started or restarted: the seat, a session adopted
 * into the chair, a worker role's turn, a named agent (a card's tab), a
 * flight-plan Launch, a pane a tmux restore rebuilt, Resume on a restored
 * window, the terminal panel's own buttons, and a window or split the layout
 * route opens with a command the caller supplied. Each row names the file, the
 * body inside it, and the call that must be there — `agentWindowEnv(` for a
 * path that builds the environment itself, `mintBrowserCredential(` for a
 * caller that already holds an env object (the adapter over the same decision),
 * `argvWindowEnv(` for a window whose command the caller supplied, and
 * `inherits: true` for a path that reaches the lowest door in
 * `AgentOps.startAgent`.
 *
 * `agent-window-credential.test.ts` walks this table and fails when a body no
 * longer carries its call, so the day a path is rewritten without the door is
 * the day the build goes red — not months later, as a tab found with the off
 * marker and nobody able to say which start put it there.
 */
export interface AgentStartPath {
  id: string;
  what: string;
  file: string;
  /** Where this path's own body begins: a function, or the command's block.
   *  The check runs on the text from here to the next row of the same file, so
   *  a call that lives in a neighbouring function does not count for it. */
  within?: string;
  /** What the body must contain, for a path that builds the env itself. */
  calls?: string;
  /** `true` when this file does not build an env itself: the path goes through
   *  `AgentOps.startAgent`, whose door decides for it. */
  inherits?: true;
}

export const AGENT_START_PATHS: readonly AgentStartPath[] = [
  { id: "seat", what: "the project seat, opened or re-seated (seat.ts openSeat, via seatwindow.ts)", file: "server/src/seatwindow.ts", within: "export function seatWindowEnv(", calls: "agentWindowEnv(" },
  { id: "seat-adopt", what: "a running session put in the chair, re-linked or approved (seat.ts adoptSeat)", file: "server/src/seat.ts", within: "export async function adoptSeat(", calls: "agentWindowEnv(" },
  { id: "worker-start", what: "a worker role's first turn (agents/policystart.ts startThroughPolicy -> startNow)", file: "server/src/agents/policystart.ts", within: "async function startNow(", calls: "mintBrowserCredential(" },
  { id: "worker-turn", what: "a running worker's next turn (agents/policystart.ts promptHeadless -> resumeTurn)", file: "server/src/agents/policystart.ts", within: "async function resumeTurn(", calls: "mintBrowserCredential(" },
  { id: "worker-fallback", what: "the next engine in the chain taking a turn over (agents/policystart.ts switchEngine)", file: "server/src/agents/policystart.ts", within: "async function switchEngine(", calls: "mintBrowserCredential(" },
  { id: "named-agent", what: "a named agent, a card's tab (/agents/named/start, index.ts)", file: "server/src/index.ts", within: 'if (verb === "start") {', calls: "agentWindowEnv(" },
  { id: "flight-plan", what: "a flight-plan Launch/Go builder tab (index.ts launchFlightPlan)", file: "server/src/index.ts", within: "async function launchFlightPlan(", calls: "agentWindowEnv(" },
  { id: "layout-window", what: "a tab or split the layout route opens with its own command (/terminal/tmux/windows, index.ts)", file: "server/src/index.ts", within: 'if (pathname === "/terminal/tmux/windows" && req.method === "POST") {', calls: "argvWindowEnv(" },
  { id: "restore", what: "a pane a tmux restore rebuilt (tmuxrestore.ts replayArgs)", file: "server/src/tmuxrestore.ts", within: "export function replayArgs(", calls: "agentWindowEnv(" },
  { id: "resume", what: "Resume on a restored window (tmuxrestore.ts resumeRestored, through replayArgs)", file: "server/src/tmuxrestore.ts", within: "export async function resumeRestored(", calls: 'replayArgs("all", mark.pane, named)' },
  { id: "panel-window", what: "a bench tab that runs an agent (terminal.ts -> tmuxpane.ts ensurePanelWindow)", file: "server/src/terminal.ts", within: "const window = d.bench ? benchWindowName(d.bench) : CONSOLE_WINDOW;", calls: "agentWindowEnv(" },
  { id: "terminal-open-engine", what: "the terminal panel's Open engine (terminal.ts cmd:agent)", file: "server/src/terminal.ts", within: 'if (msg.cmd === "agent") {', calls: "agentWindowEnv(" },
  { id: "terminal-review", what: "the terminal panel's Review button (terminal.ts cmd:review)", file: "server/src/terminal.ts", within: 'if (msg.cmd === "review") {', calls: "agentWindowEnv(" },
  { id: "terminal-issue", what: "the terminal panel's Issue/agent button (terminal.ts cmd:issue)", file: "server/src/terminal.ts", within: 'if (msg.cmd === "issue") {', calls: "agentWindowEnv(" },
  { id: "terminal-resume", what: "the terminal panel's Resume (terminal.ts cmd:resume)", file: "server/src/terminal.ts", within: 'if (msg.cmd === "resume") {', calls: "agentWindowEnv(" },
  { id: "start-door", what: "any other start, through AgentOps.startAgent's own door", file: "server/src/agentops.ts", inherits: true },
];

/** Every list, so the card and a test read the same names as the check. */
export { BROWSER_ENGINES, BROWSER_ROLES };
