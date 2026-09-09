/*
 * NAMED AGENTS ON THE ENGINE — the launcher and the liveness a script needs
 * to run unattended agents on this machine without a second orchestrator.
 *
 * An unattended worker script — one that picks a task on a clock, cuts a
 * worktree and seats an agent in it — leans on an orchestrator like Herdr in
 * exactly six places, all of them one shape: start an agent by NAME
 * in a checkout, hand it a prompt, wait until it is working, read its screen,
 * press a key, and — on the next tick — list the names still alive so a card
 * whose agent vanished can be reconciled. Nothing else. So this is that
 * surface and no more: a registry of named agents, each a window on the tmux
 * engine this app already owns, with the same verbs and the same answer shape
 * (`{ result: { agents: [{ name }] } }`) so such a script reads it with a
 * one-word change on its side.
 *
 * What it deliberately is NOT: a scheduler. It picks no card, opens no
 * worktree, decides nothing about what to work on — the script does all of
 * that on its own side, where its ledger and its locks already live.
 * This app is the launcher and the liveness, which is the part Herdr was.
 *
 * Liveness is a FACT, not a claim: an agent is alive while its pane exists on
 * the engine. The window runs the CLI as its command, so the CLI exiting takes
 * the window with it, and a name whose pane is gone is gone — no heartbeat to
 * miss, no timeout to tune. The readiness and busy signals come off the pane's
 * screen through the same readers the chat and the clone use (`inputBox`,
 * `__submitVerdict`), so the four surfaces cannot disagree about what a Claude
 * prompt looks like.
 */
import { db } from "./db.ts";
import { tmux, engineWindowRunning } from "./tmuxpane.ts";
import { agentBinFor, agentArgv } from "./agentticket.ts";
import { agentKind } from "../../shared/agentKinds.ts";
import { claudeCode, supportsSessionName } from "./agents/claudecode.ts";
import { SPELLINGS } from "./agents/launch.ts";
import { inputBox, __submitVerdict, __needsYou, __running } from "./chatpane.ts";
import { boardNow } from "./lantern.ts";
import type { BoardRow } from "./agentboard.ts";

/** A name is a handle a script types and a tmux window is named after: short,
 *  plain, and never something `-t` could misread. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const validName = (s: unknown): s is string => typeof s === "string" && NAME_RE.test(s);
/** The engine session every named agent's window goes into. */
export const AGENTS_SESSION = "agents";

export interface NamedAgent {
  name: string;
  kind: string;
  cwd: string;
  paneId: string;
  windowId: string;
  startedAt: number;
  endedAt: number | null;
  /** True when this app did not open the window — somebody's own tab, enlisted
   *  so the verbs can reach it. What keeps `stop` from killing it. */
  adopted?: boolean;
}

interface Row {
  name: string; kind: string; cwd: string; pane_id: string; window_id: string;
  started_at: number; ended_at: number | null; adopted?: number;
}
const toAgent = (r: Row): NamedAgent => ({
  name: r.name, kind: r.kind, cwd: r.cwd, paneId: r.pane_id, windowId: r.window_id,
  startedAt: r.started_at, endedAt: r.ended_at,
  ...(r.adopted ? { adopted: true } : null),
});

const upsert = db.query<never, [string, string, string, string, string, number]>(`
  INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
  VALUES (?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT(name) DO UPDATE SET
    kind = excluded.kind, cwd = excluded.cwd, pane_id = excluded.pane_id,
    window_id = excluded.window_id, started_at = excluded.started_at, ended_at = NULL
`);
const byName = db.query<Row, [string]>(`SELECT * FROM named_agent WHERE name = ?`);
const live = db.query<Row, []>(`SELECT * FROM named_agent WHERE ended_at IS NULL ORDER BY started_at DESC`);
const everything = db.query<Row, []>(`SELECT * FROM named_agent ORDER BY started_at DESC LIMIT 200`);
const end = db.query<never, [number, string]>(`UPDATE named_agent SET ended_at = ? WHERE name = ? AND ended_at IS NULL`);
/* The same row `startAgent` writes, with `adopted` set: one registry, so every
   verb that reads it reaches an enlisted tab without knowing there are two
   ways in. */
const adopt = db.query<never, [string, string, string, string, string, number]>(`
  INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, adopted)
  VALUES (?, ?, ?, ?, ?, ?, NULL, 1)
  ON CONFLICT(name) DO UPDATE SET
    kind = excluded.kind, cwd = excluded.cwd, pane_id = excluded.pane_id,
    window_id = excluded.window_id, started_at = excluded.started_at, ended_at = NULL, adopted = 1
`);

/** Whether ONE pane is on the engine. The same fact `panesAlive` rests on,
 *  asked of a single id — an adopted seat is a pane this app did not open, and
 *  it has to be checked the same way as one it did. */
export async function paneAlive(paneId: string): Promise<boolean> {
  if (!/^%\d+$/.test(paneId)) return false;
  return (await panesAlive()).has(paneId);
}

/** Every pane on the engine right now — the one fact liveness rests on. */
async function panesAlive(): Promise<Set<string>> {
  const r = await tmux(["list-panes", "-a", "-F", "#{pane_id}"]).catch(() => null);
  return new Set(r?.ok ? r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("%")) : []);
}

/** The registry reconciled against the engine: a row whose pane is gone is
 *  closed here, at the moment somebody looks, and never listed as alive. */
export async function reconcile(now = Date.now()): Promise<NamedAgent[]> {
  const alive = await panesAlive();
  const out: NamedAgent[] = [];
  for (const r of live.all()) {
    if (alive.has(r.pane_id)) out.push(toAgent(r));
    else end.run(now, r.name);
  }
  return out;
}

export function agentNamed(name: string): NamedAgent | null {
  const r = byName.get(name);
  return r ? toAgent(r) : null;
}

/** The whole history, for `--all`: what ran and when it ended. */
export function everyAgent(): NamedAgent[] { return everything.all().map(toAgent); }

export type StartResult =
  | { ok: true; agent: NamedAgent }
  | { ok: false; error: "exists"; agent: NamedAgent }
  /** A pass-through arg that would change what the agent is ALLOWED to do,
   *  named, so the caller is told which one rather than left to bisect. */
  | { ok: false; error: "arg-refused"; flag: string }
  | { ok: false; error: "no-cli" | "no-window" | "bad-name" | "yolo-refused" | "bad-args" };

/**
 * The yolo flag is a PERMISSION, not a parameter, exactly as on `/terminal/agent`:
 * asked for by `yolo: true` and granted by Settings. Passing it as one of the
 * pass-through CLI args would be the same flag through a door with no gate.
 *
 * The first version of this was a set of three literal strings, and it held
 * the door while every other way of saying the same thing walked through it.
 * Measured against that set: each of these passed it, and would have reached
 * the engine with chatBypass OFF in Settings —
 *
 *   ["--permission-mode", "bypassPermissions"]     Claude's other spelling
 *   ["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}']
 *   ["--mcp-config", "<file>"]                      tools the operator never saw
 *   ["--dangerously-bypass-approvals-and-sandbox"]  Codex's real flag — the
 *                                                   list had a Codex spelling
 *                                                   Codex does not use
 *
 * So the rule is no longer a list of words: it is every flag each CLI uses to
 * skip its permission prompt, taken from launch.ts so a fourth vendor cannot
 * arrive without its flag arriving here, plus the flags that reshape what the
 * agent may touch (`--allowedTools`, `--add-dir`, `--sandbox`…), plus a
 * pattern over the words those flags are made of. Compared on the flag name
 * alone — `--permission-mode=bypassPermissions` is the same flag with `=`.
 *
 * REFUSED, NEVER DROPPED. An arg silently removed leaves a caller believing the
 * agent runs as they configured it, which is a worse state than a 400 that
 * names the flag.
 */
const PERMISSION_FLAGS = new Set<string>([
  ...Object.values(SPELLINGS).map((s) => s.bypass),
  /* Claude Code: the mode by name, additional settings (a permissions block
     rides in there), an MCP config file, tool allow/deny lists and extra
     writable directories. Codex: the approval policy (`-a`) and the sandbox
     level. Gemini: the yolo shorthand. Kept with both spellings where the CLI
     accepts both. */
  "--permission-mode", "--settings", "--mcp-config", "--sandbox", "-a", "--ask-for-approval",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--add-dir",
]);

/** The words a permission flag is made of, whatever the flag is called. */
const PERMISSION_WORDS = /bypass|skip-permission|dangerous|yolo|full-auto/;

/**
 * The first pass-through arg that would change what the agent is allowed to
 * do, or null. Exported so the test can enumerate the gate rather than probe
 * it one string at a time.
 */
export function refusedArg(args: string[]): string | null {
  for (const a of args) {
    if (!a.startsWith("-")) continue;
    const name = a.split("=", 1)[0]!;
    if (PERMISSION_FLAGS.has(name)) return a;
    if (a.startsWith("--dangerously-")) return a;
    if (PERMISSION_WORDS.test(a.toLowerCase())) return a;
  }
  return null;
}

export async function startAgent(p: {
  root: string; name: string; cwd: string; kind?: string; prompt?: string; yolo?: boolean;
  /** Extra CLI flags after the ones this app builds, each one argv element. */
  args?: string[];
  /** Claude's `--remote-control <name>`: the worker asks for it by name. */
  remoteControl?: string;
  /** Extra environment for the window. NOT reachable from `/agents/named/start`
   *  on purpose: this is how the server hands a seat its own credential
   *  (seat.ts), and a body that could set environment would be a body that
   *  could set `AGENTGLASS_TOKEN`. */
  env?: Record<string, string>;
  yoloAllowed: boolean;
  now?: number;
}): Promise<StartResult> {
  if (!validName(p.name)) return { ok: false, error: "bad-name" };
  const kind = agentKind(p.kind ?? "claude");
  if (!kind) return { ok: false, error: "no-cli" };
  const args = p.args ?? [];
  if (args.some((a) => typeof a !== "string" || /[\n\r\0]/.test(a))) return { ok: false, error: "bad-args" };
  const refused = refusedArg(args);
  if (refused !== null) return { ok: false, error: "arg-refused", flag: refused };
  if (p.yolo && !p.yoloAllowed) return { ok: false, error: "yolo-refused" };

  /* A live name is somebody's session; starting another under it would leave
     one of them unreachable by name. The caller decides (`proj1234-2` is the
     worker's own convention) — this only refuses. A name whose pane is gone is
     free again, which is what a relaunch of the same card wants. */
  const alive = await panesAlive();
  const had = byName.get(p.name);
  if (had && had.ended_at === null) {
    if (alive.has(had.pane_id)) return { ok: false, error: "exists", agent: toAgent(had) };
    end.run(p.now ?? Date.now(), p.name);
  }

  const bin = agentBinFor(kind.id);
  if (!bin) return { ok: false, error: "no-cli" };
  const base = agentArgv(bin, { prompt: p.prompt ?? "", yolo: p.yolo === true, title: p.name, kind: kind.id }, supportsSessionName(bin));
  if (!base.length) return { ok: false, error: "no-cli" };
  /* The prompt is the LAST element of `base`; the flags go before it. */
  const head = p.prompt ? base.slice(0, -1) : base;
  const tail = p.prompt ? base.slice(-1) : [];
  const remote = p.remoteControl && validName(p.remoteControl) && kind.id === "claude" ? ["--remote-control", p.remoteControl] : [];
  const argv = [...head, ...remote, ...args, ...tail];

  /* One tmux session for every named agent, apart from the project's own:
     Herdr gave each worker its own workspace, and a person's strip is not the
     place for windows a script opened — it appears on the board and in the
     Terminal view's session list either way. Never selected, so nobody's
     screen is yanked by a tick. */
  const opened = await engineWindowRunning(p.root, p.name, argv, p.cwd, { AGENTGLASS_AGENT_NAME: p.name, ...(p.env ?? {}) }, AGENTS_SESSION, false);
  if (!opened) return { ok: false, error: "no-window" };
  const startedAt = p.now ?? Date.now();
  upsert.run(p.name, kind.id, p.cwd, opened.paneId, opened.windowId, startedAt);
  return { ok: true, agent: { name: p.name, kind: kind.id, cwd: p.cwd, paneId: opened.paneId, windowId: opened.windowId, startedAt, endedAt: null } };
}

/** `capture-pane` on a pane that is gone fails outright, so null is "gone". */
export async function screenOf(paneId: string, lines = 0): Promise<string | null> {
  const r = await tmux(["capture-pane", "-p", "-J", "-t", paneId, ...(lines > 0 ? ["-S", `-${lines}`] : [])]);
  return r.ok ? r.stdout : null;
}

export type AgentState = "starting" | "ready" | "working" | "needs-you" | "gone";

/** What one screen says, in the words the worker waits on. */
export function stateOfScreen(screen: string | null): AgentState {
  if (screen === null) return "gone";
  if (__needsYou(screen)) return "needs-you";
  if (__running(screen)) return "working";
  if (inputBox(screen) !== null) return "ready";
  return "starting";
}

/** Wait until the agent is in one of the states asked for, or the deadline
 *  passes. `gone` always ends the wait: nothing later is coming. */
export async function waitFor(paneId: string, until: AgentState[], timeoutMs: number, tick = 250): Promise<{ state: AgentState; reached: boolean }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const state = stateOfScreen(await screenOf(paneId));
    if (until.includes(state) || state === "gone") return { state, reached: until.includes(state) };
    if (Date.now() >= deadline) return { state, reached: false };
    await Bun.sleep(tick);
  }
}

export type PromptOutcome = "sent" | "queued" | "diverted" | "stuck" | "gone";

/**
 * Hand the agent a message the way a person would: paste it, see it sitting in
 * the box, press Enter until it is taken. The first Enter after a paste is
 * routinely lost (chatpane.ts has the measurements), which is why this is a
 * loop with a verdict rather than two tmux calls. A picker or a permission
 * prompt on screen is `diverted`: the text is in the box, unsent, and the
 * worker's own recovery (`send-keys enter` after a look) applies.
 */
export async function promptAgent(paneId: string, text: string, timeoutMs = 10_000): Promise<PromptOutcome> {
  const buf = `agx-agent-${paneId.replace("%", "")}`;
  const load = await tmux(["load-buffer", "-b", buf, "-"], text);
  if (!load.ok) return "gone";
  if (!(await tmux(["paste-buffer", "-b", buf, "-t", paneId, "-d", "-p"])).ok) return "gone";
  const deadline = Date.now() + timeoutMs;
  let pasted = "";
  for (;;) {
    const screen = await screenOf(paneId);
    if (screen === null) return "gone";
    const box = inputBox(screen);
    if (box?.trim()) { pasted = box; break; }
    if (Date.now() > deadline) return "stuck";
    await Bun.sleep(60);
  }
  for (;;) {
    await tmux(["send-keys", "-t", paneId, "Enter"]);
    await Bun.sleep(600);
    const screen = await screenOf(paneId);
    if (screen === null) return "gone";
    const verdict = __submitVerdict(screen, pasted);
    if (verdict !== "retry") return verdict;
    if (Date.now() > deadline) return "stuck";
  }
}

/** The keys a script may press, by the names the worker already uses. Anything
 *  else is refused: text goes through `promptAgent`, never through send-keys. */
const KEYS: Record<string, string> = {
  enter: "Enter", escape: "Escape", esc: "Escape", up: "Up", down: "Down", left: "Left", right: "Right",
  tab: "Tab", space: "Space", backspace: "BSpace", "ctrl-c": "C-c", "c-c": "C-c",
};
export const keyNamed = (k: unknown): string | null => (typeof k === "string" ? KEYS[k.toLowerCase()] ?? null : null);

export async function pressKey(paneId: string, key: string): Promise<boolean> {
  return (await tmux(["send-keys", "-t", paneId, key])).ok;
}

/**
 * Stop an agent — and for one this app did not open, "stop" means LET GO.
 *
 * A window somebody made themselves, with their work in it, is not this app's
 * to kill because a verb was called on the name they lent it. So an enlisted
 * agent is forgotten: the row closes, the verbs stop reaching it, and the tab
 * is exactly where its owner left it. `kill` says the caller meant the window
 * and not the registration, and it is never the default.
 *
 * The answer says which happened, because "stopped" meaning two things and
 * saying so once is how a caller ends up surprised in one direction or the
 * other.
 */
export async function stopAgent(a: NamedAgent, now = Date.now(), kill = !a.adopted): Promise<{ ok: boolean; killed: boolean }> {
  const killed = kill ? (await tmux(["kill-window", "-t", a.windowId])).ok : false;
  end.run(now, a.name);
  return { ok: kill ? killed : true, killed };
}

/**
 * Take an existing pane under this app's hand, by name.
 *
 * The registry held only what `startAgent` opened, so a person's own tmux tab
 * running an agent did not exist for `broadcast`, `prompt` or `read` —
 * measured by the orchestrator whose whole fleet is tabs it opened by hand:
 * "`list` da 0 con 2 tabs vivas, broadcast no encuentra a nadie". Its first
 * ask was one message to N agents, and the N was zero.
 *
 * The pane is found by its id, or by the window name a person gave it, which
 * is the handle they actually use. Everything else is read off tmux rather
 * than taken from the caller: where it is running, which window it belongs to,
 * and whether an agent is running in it at all — enlisting a plain shell would
 * make `prompt` type a paragraph into somebody's command line.
 */
export type EnlistResult =
  | { ok: true; agent: NamedAgent }
  | { ok: false; error: "bad-name" | "exists" | "no-pane" | "many-panes" | "not-an-agent"; detail?: string };

export async function enlistAgent(p: { name: string; pane?: string; window?: string }): Promise<EnlistResult> {
  if (!validName(p.name)) return { ok: false, error: "bad-name" };
  const existing = agentNamed(p.name);
  if (existing && existing.endedAt === null && await paneAlive(existing.paneId)) {
    return { ok: false, error: "exists", detail: existing.paneId };
  }
  const r = await tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_start_command}"]);
  if (!r.ok) return { ok: false, error: "no-pane" };
  const rows = r.stdout.split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 5);
  const wanted = p.pane
    ? rows.filter((c) => c[0] === p.pane)
    : rows.filter((c) => c[2] === (p.window ?? p.name));
  if (!wanted.length) return { ok: false, error: "no-pane" };
  /* A window name is a label, not a key: two tabs can carry the same one, and
     picking the first would enlist a coin toss. */
  if (wanted.length > 1) return { ok: false, error: "many-panes", detail: wanted.map((c) => c[0]).join(", ") };
  const [paneId = "", windowId = "", , cwd = "", command = "", startedWith = ""] = wanted[0]!;
  /*
   * IS AN AGENT RUNNING IN THERE — asked of both the process and the command
   * the pane was born with, because either alone is wrong.
   *
   * `pane_current_command` is the foreground binary, and it is `bash` or `node`
   * for every agent that was started through a wrapper — including the ones
   * this app's own restore opens, as `sh -c 'claude …'`. Refusing on that
   * alone would refuse panes agentglass itself made.
   *
   * The start command alone is worse: it still says `claude` in a pane where
   * the agent exited an hour ago and left a shell.
   *
   * So: either says yes. This is a help against the obvious mistake — pointing
   * a verb at somebody's editor or their shell — and not a proof, and the
   * caller is naming a specific pane on purpose. A plain interactive shell has
   * neither, which is the case worth stopping.
   */
  const bin = (claudeCode.bin() || "claude").split("/").pop() || "claude";
  const named = new RegExp(`(^|[/\\s"'])${bin}([\\s"']|$)`);
  if (command !== bin && !named.test(startedWith)) {
    return { ok: false, error: "not-an-agent", detail: command };
  }
  const now = Date.now();
  adopt.run(p.name, "claude", cwd, paneId, windowId, now);
  const made = agentNamed(p.name);
  return made ? { ok: true, agent: made } : { ok: false, error: "no-pane" };
}

/** The list the worker reconciles against: every live name, with what the
 *  board knows about its pane — working or idle, stopped on a person, on
 *  which branch — so a tick can also tell a stalled session from a busy one. */
export async function listAgents(all = false): Promise<Array<NamedAgent & { state?: BoardRow["state"]; needsYou?: BoardRow["needsYou"]; doing?: string; branch?: string; session?: string }>> {
  const agents = all ? everyAgent() : await reconcile();
  const board = await boardNow().catch(() => [] as BoardRow[]);
  const byPane = new Map(board.filter((r) => r.paneId).map((r) => [r.paneId!, r]));
  return agents.map((a) => {
    const b = a.endedAt === null ? byPane.get(a.paneId) : undefined;
    return { ...a, state: b?.state, needsYou: b?.needsYou, doing: b?.doing, branch: b?.branch, session: b?.session };
  });
}
