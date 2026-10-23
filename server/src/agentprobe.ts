import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProbe, EngineFix, EngineReadiness, EngineVerdict, EnginesReport, KnownAgent } from "../../shared/types.ts";
import { AGENT_PROVIDERS, ENGINE_IDS, engineProviders, type Provider } from "../../shared/agentKinds.ts";
import { extractVersion, versionAtLeast } from "../../shared/semverLite.ts";
import { db } from "./db.ts";
import { hookStatus } from "./hooksetup.ts";

/**
 * The agents this machine already has, and whether any of them is talking.
 *
 * Connecting a second agent is the step where people stop. The hooks ship in
 * the app, but somebody still has to know which harness they have, which config
 * file it reads, and what to put in it — three questions the cockpit can just
 * answer by looking.
 *
 * Everything not found is listed too, rather than hidden. A list of what is
 * installed tells you nothing about what is *supported*, and "supported" is the
 * question somebody has when they are deciding whether to try a second agent at
 * all.
 *
 * The half that matters is the last one. **"Connected" has to mean an event
 * landed**, not that a file was written — every failure in this area looks like
 * a successful write: a config in the right shape that the CLI does not read, a
 * session started before the change, a typo in an endpoint. A green tick over a
 * file that changed nothing is worse than no tick, because it stops the search.
 */

/**
 * The roster, with its paths resolved when they are asked for.
 *
 * Not at import: `homedir()` would be captured once, and both the hook
 * installer's own `CLAUDE_CONFIG_DIR` and a suite pointing `HOME` at a scratch
 * directory move afterwards. A frozen path here reads a developer's real
 * config in tests and the wrong one in an app that re-homes itself.
 */
type Roster = Omit<KnownAgent, "configPath"> & { configPath: () => string };

/**
 * The home the *agent CLIs* use, which is not always the one Bun reports.
 *
 * `os.homedir()` in Bun resolves from the passwd entry and ignores `$HOME`;
 * Node prefers `$HOME` on POSIX, and so does Python's `Path.home()` — which is
 * what `hooks/connect_otel.py` writes through. So on any machine where the two
 * differ (a container, `sudo -E`, CI) this module would have read a config the
 * installer never wrote, and reported a correctly connected agent as
 * unconnected. `$HOME` is also what the CLIs themselves read, which makes it
 * the right answer rather than merely the consistent one.
 */
const agentHome = (): string => process.env.HOME || homedir();

/**
 * The roster is the rows of shared/agentKinds.ts that carry a `probe` facet,
 * in that table's order — the CLIs this list held on its own before
 * the table became the one place a provider is written down.
 */
export const ROSTER: Roster[] = AGENT_PROVIDERS.flatMap((p): Roster[] => {
  const r = p.probe;
  if (!r) return [];
  return [{
    id: r.id ?? p.id,
    label: r.label,
    bin: p.bin,
    via: r.via,
    // The hook installer decides the `hooks` one — it honours CLAUDE_CONFIG_DIR.
    configPath: r.via === "hooks"
      ? () => hookStatus().settingsPath
      : () => (r.configPath ? join(agentHome(), r.configPath) : ""),
    /** Every event this agent produces arrives under this name. */
    match: r.match,
    install: r.install,
    connects: r.connects,
  }];
});

/**
 * Whether this agent's config currently points at us.
 *
 * Read rather than remembered: the file is the truth, and somebody who edited
 * it by hand — or ran the CLI's own reset — should see that reflected instead
 * of a state this app wrote down once.
 */
function wired(a: Roster, path: string, found: boolean): boolean {
  if (a.via === "hooks") return hookStatus().installed;
  // Nothing to wire and nothing that could be unwired: a `chat` agent reports
  // because this server is the thing running it, so being installed is the
  // whole of being connected. It has to be said that way round — answering a
  // flat `true` here would report a CLI nobody has installed as connected and
  // waiting for its first event, which is the one state it can never reach.
  if (a.via === "chat") return found;
  if (!existsSync(path)) return false;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  // Deliberately loose: what is being asked is "does this point at an
  // agentglass receiver", and the port can be anything. A stricter match would
  // report a server on 4001 as unconnected while its events arrived.
  if (a.id === "gemini") {
    try {
      const cfg = JSON.parse(text) as { telemetry?: { otlpEndpoint?: unknown; enabled?: unknown } };
      const ep = String(cfg.telemetry?.otlpEndpoint ?? "");
      return !!cfg.telemetry?.enabled && /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/.test(ep);
    } catch {
      return false;
    }
  }
  return /otlp-http\s*=\s*\{[^}]*(localhost|127\.0\.0\.1)/.test(text);
}

/**
 * When this agent last actually said something.
 *
 * Matched on a name fragment rather than an exact `source_app`, because for the
 * OTLP agents that field is whatever the CLI puts in its own `service.name` —
 * this app does not choose it and cannot pin it. The fragment is the part that
 * does not change.
 */
function lastSeen(match: string, q: typeof db = db): number | null {
  const r = q
    .query<{ t: number | null }, [string]>(
      "SELECT MAX(timestamp) AS t FROM events WHERE source_app LIKE '%' || ? || '%'"
    )
    .get(match);
  return r?.t ?? null;
}

/** Every agent this app knows how to connect, with what is true of it here. */
export function probeAgents(
  which: (cmd: string) => string | null = (c) => Bun.which(c),
  seen: (match: string) => number | null = lastSeen,
): AgentProbe[] {
  return ROSTER.map((a) => {
    const path = a.configPath();
    const found = which(a.bin);
    return {
      ...a,
      configPath: path,
      found: !!found,
      path: found,
      connected: wired(a, path, !!found),
      // Independent of `connected` on purpose. A config that was written and an
      // event that arrived are different facts, and the gap between them is
      // exactly where this feature earns its place: it is the state somebody
      // sits in for ten minutes wondering what they did wrong.
      seenAt: seen(a.match),
    };
  });
}

/** The one word for where an agent stands, so a panel is not re-deriving it. */
export function agentState(p: AgentProbe): "live" | "waiting" | "ready" | "missing" {
  if (p.seenAt) return "live";
  if (p.connected) return "waiting";
  return p.found ? "ready" : "missing";
}

/*
 * Engine readiness: what this machine has of each engine, and what each can do.
 *
 * One probe, two consumers (the Agent engines page and, later, the policy
 * resolver), so the answer is computed here and nowhere else. It is split the
 * way it is tested: `runCheap` asks the CLIs (the only part that spawns),
 * `deriveReadiness` turns what they printed into the verdicts (pure, so the
 * sentences are table-tested without a process), and `probeEngines` caches the
 * first by the binary's and the config directory's mtime.
 *
 * Names only. A CLI's status output can carry a token, an email or a path, so
 * nothing printed is passed on except the few names `namesOf` picks out and
 * the first line of an error, which goes through `redact` first. The probe
 * never opens a credential file: it asks the CLI, as the person would.
 */

export { ENGINE_IDS };

/** A probe command is read-only and should answer at once; a CLI that takes
 *  longer than this is reported as not answering, never as not installed. */
export const PROBE_TIMEOUT_MS = 5000;
/** The one-line test is a real turn. */
export const TEST_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 64 * 1024;

/** What a command printed and how it ended. */
export interface Raw { out: string; err: string; code: number | null; timedOut: boolean }

/** Everything the cheap probe measured about one engine, before any verdict. */
export interface EngineFacts {
  found: boolean;
  path: string | null;
  version: Raw | null;
  status: Raw | null;
  /** The envelope's own check (Hermes's deny list), when it is run. */
  check: Raw | null;
}

/** The server's environment minus the one secret every probe could print. */
function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "AGENTGLASS_TOKEN") env[k] = v;
  return env;
}

/** Cut anything token-shaped out of a line before it leaves this module. */
export function redact(line: string): string {
  return line
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|eyJ)[-_A-Za-z0-9.]{6,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, "[redacted]")
    .replace(/\b[0-9a-f]{32,}\b/g, "[redacted]");
}

const firstLine = (r: Raw): string => {
  const text = (r.err.trim() || r.out.trim()).split("\n").find((l) => l.trim()) ?? "";
  return redact(text.trim()).slice(0, 200);
};

/** Run one command with a ceiling, in its own process group so the ceiling
 *  takes whatever it started with it. */
export async function runCommand(
  argv: string[], timeoutMs: number, o: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Raw> {
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: o.cwd, env: o.env ?? probeEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { out: "", err: String((e as Error).message ?? e), code: null, timedOut: false };
  }
  const kill = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* gone */ } } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  // Read to the cap and no further: a CLI that floods must not fill memory, and
  // a reader is cancelled rather than waited on, because a child that outlives
  // the group kill would hold the pipe open.
  const read = async (stream: ReadableStream<Uint8Array> | undefined): Promise<string> => {
    if (!stream) return "";
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    try {
      while (n < OUTPUT_CAP) {
        const c = await reader.read();
        if (c.done || !c.value) break;
        chunks.push(c.value);
        n += c.value.length;
      }
    } catch { /* closed */ }
    void reader.cancel().catch(() => { /* closed */ });
    return Buffer.concat(chunks).toString("utf8").slice(0, OUTPUT_CAP);
  };
  const [out, err] = await Promise.all([
    read(proc.stdout as ReadableStream<Uint8Array>),
    read(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { out, err, code: timedOut ? null : code, timedOut };
}

/** The directories an engine keeps its sign-in and settings in. Their mtime is
 *  half of the cache key, so a login or an upgrade is seen at once. */
function configDirs(id: string): string[] {
  const h = agentHome();
  switch (id) {
    case "claude": return [process.env.CLAUDE_CONFIG_DIR || join(h, ".claude")];
    case "codex": return [process.env.CODEX_HOME || join(h, ".codex")];
    case "hermes": return [process.env.HERMES_HOME || join(h, ".hermes")];
    case "opencode": return [join(h, ".config", "opencode"), join(h, ".local", "share", "opencode")];
    case "gemini": return [join(h, ".gemini")];
    default: return [join(h, ".antigravity")];
  }
}

const mtimeOf = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** What an engine is asked to do about being old or signed out. Only commands
 *  somebody has seen exist; the rest is a sentence. */
const UPDATE: Record<string, string> = {
  claude: "claude update", hermes: "hermes update", opencode: "opencode upgrade", codex: "npm i -g @openai/codex",
};
const LOGIN: Record<string, string> = {
  claude: "claude auth login", codex: "codex login", opencode: "opencode providers login",
};

/** Ask one engine its read-only questions. This is the part that spawns. */
async function runCheap(p: Provider, path: string | null): Promise<EngineFacts> {
  if (!path) return { found: false, path: null, version: null, status: null, check: null };
  const v = p.version;
  const version = v ? await runCommand([path, ...v.args], PROBE_TIMEOUT_MS) : null;
  const ran = !!version && version.code === 0;
  const status = p.account && ran ? await runCommand([path, ...p.account.args], PROBE_TIMEOUT_MS) : null;
  // The deny-list check needs a CLI that has the subcommand; on an old one the
  // same exit code could mean something else.
  const old = !!(v?.min && version && ran && (() => { const n = extractVersion(version.out + "\n" + version.err, v.pattern); return n ? !versionAtLeast(n, v.min!) : false; })());
  const check = p.envelope?.check && ran && !old ? await runCommand([path, ...p.envelope.check.args], PROBE_TIMEOUT_MS) : null;
  return { found: true, path, version, status, check };
}

/** The few names worth showing from a status line. Never the line. */
function namesOf(id: string, r: Raw): { provider?: string; account?: string; model?: string } {
  const clean = (s: string | undefined) => (s ? redact(s.trim()).slice(0, 60) : undefined);
  const text = r.out + "\n" + r.err;
  const out: { provider?: string; account?: string; model?: string } = {};
  if (id === "claude") {
    try {
      const j = JSON.parse(r.out) as { authMethod?: unknown; apiProvider?: unknown };
      if (typeof j.apiProvider === "string") out.provider = clean(j.apiProvider);
      if (typeof j.authMethod === "string") out.account = clean(j.authMethod);
    } catch { /* not JSON: no names */ }
  } else if (id === "codex") {
    out.provider = clean(/Logged in using (.+)/.exec(text)?.[1]);
  } else if (id === "hermes") {
    out.provider = clean(/^\s*(.+?)\s+✓ logged in/m.exec(text)?.[1]);
    out.model = clean(/^\s*Model:\s*(\S+)/im.exec(text)?.[1]);
  }
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (!out[k]) delete out[k];
  return out;
}

function installFix(p: Provider): EngineFix {
  const how = p.probe?.install ?? "";
  if (!how) return { kind: "manual", what: `Install ${p.title}.` };
  return /^https?:/.test(how)
    ? { kind: "manual", what: `Install ${p.title}: ${how}` }
    : { kind: "command", what: `Install ${p.title}.`, command: how };
}

/**
 * Turn what the CLIs printed into the readiness the page and the resolver read.
 * Pure: the same facts give the same answer, which is what lets the sentences
 * be asserted without a process.
 */
export function deriveReadiness(
  p: Provider, f: EngineFacts, answers: EngineReadiness["answers"] = { state: "never" },
): EngineReadiness {
  const missing: EngineFix[] = [];
  const v = p.version;
  let version: string | null = null;
  let versionOk: boolean | null = null;

  if (!f.found) {
    missing.push(installFix(p));
  } else if (v && f.version) {
    const raw = f.version;
    if (raw.timedOut) {
      missing.push({ kind: "manual", what: `${p.title} did not answer \`${p.bin} --version\` within ${PROBE_TIMEOUT_MS / 1000} s. Run it in a terminal to see why.` });
    } else if (raw.code !== 0) {
      const line = firstLine(raw);
      missing.push({ kind: "manual", what: `${p.title} does not run${line ? `: ${line}` : ` (exit ${raw.code})`}. Try \`${p.bin} --version\` in a terminal.` });
    } else {
      version = extractVersion(raw.out + "\n" + raw.err, v.pattern);
      if (!version) {
        missing.push({ kind: "manual", what: `${p.title} printed something agentglass cannot read as a version: ${firstLine(raw)}` });
      } else if (v.min) {
        versionOk = versionAtLeast(version, v.min);
        if (!versionOk) {
          const cmd = UPDATE[p.id];
          const what = `${version} is installed. agentglass needs ${v.min} or later${v.minWhy ? `: ${v.minWhy}` : ""}.`;
          missing.push(cmd ? { kind: "command", what, command: cmd } : { kind: "manual", what: `${what} Update ${p.title}.` });
        }
      } else {
        versionOk = true;
      }
    }
  }

  const account: EngineReadiness["account"] = { signedIn: null };
  const a = p.account;
  if (a && f.status) {
    if (f.status.timedOut) {
      missing.push({ kind: "manual", what: `${p.title} did not answer \`${p.bin} ${a.args.join(" ")}\` within ${PROBE_TIMEOUT_MS / 1000} s.` });
    } else {
      const text = f.status.out + "\n" + f.status.err;
      let hit = false;
      try { hit = new RegExp(a.signedIn, "m").test(text); } catch { /* a bad pattern is a table-test failure */ }
      account.signedIn = hit;
      if (hit) Object.assign(account, namesOf(p.id, f.status));
      else if (!a.optional) {
        const cmd = LOGIN[p.id];
        missing.push(cmd
          ? { kind: "login", what: `Not signed in to ${p.title}. Run it in a terminal; agentglass does not see the password.`, command: cmd }
          : { kind: "manual", what: `Not signed in to ${p.title}. Sign in with its own command in a terminal.` });
      }
    }
  }

  // The envelope: how a worker's permissions are fixed before its turn.
  const e = p.envelope;
  let envelope: EngineReadiness["envelope"];
  if (!e) {
    envelope = { via: null, enforced: "no", note: `agentglass cannot yet hold ${p.title}'s permissions before a turn starts.` };
  } else if (e.via === "settings-flag") {
    /* Never "yes": its command rules match the start of a line, so the same
       command behind a flag or a path (`git -C . push`) is not refused, and
       nothing here keeps a process that runs as this user from this app's
       own token file. */
    envelope = { via: e.via, enforced: "partly", note: "A settings file passed on the command line; agentglass writes the lock. Its command rules match the start of a line, so the same command spelled another way can slip past it." };
  } else if (e.via === "config-env") {
    envelope = { via: e.via, enforced: "partly", note: "A config merged over yours through an environment variable; agentglass writes the lock. Its shell is allowed unless a rule matches the line, so a command rebuilt by a shell can slip past it." };
  } else if (e.via === "sandbox-flags") {
    envelope = { via: e.via, enforced: "partly", note: "A sandbox and an approval policy, with no per-command list: what the sandbox allows, it allows." };
  } else if (f.check && !f.check.timedOut && e.check && f.check.code === e.check.exit) {
    envelope = { via: e.via, enforced: "partly", note: `Refuses git push: yes. The deny list is yours, in ${p.title}'s own config; agentglass checks it and does not write it.` };
  } else if (f.check) {
    const cmd = e.check ? `${p.bin} ${e.check.args.join(" ")}` : "";
    envelope = { via: e.via, enforced: "no", note: `Refuses git push: no. Add it to ${p.title}'s deny list, then check with \`${cmd}\`.` };
    if (versionOk !== false) missing.push({ kind: "manual", what: `${p.title} does not refuse \`git push\`: add it to its deny list.`, command: cmd });
  } else {
    envelope = { via: e.via, enforced: "no", note: `Not checked: ${p.title} is not ready yet.` };
  }

  const roles = rolesOf(p, f.found, versionOk, version, account, envelope.enforced);
  return {
    id: p.id, title: p.title, found: f.found, path: f.path, version,
    min: v?.min ?? null, versionOk, account, answers, roles, missing, envelope,
  };
}

function rolesOf(
  p: Provider, found: boolean, versionOk: boolean | null, version: string | null,
  account: EngineReadiness["account"], enforced: "yes" | "partly" | "no",
): EngineReadiness["roles"] {
  const no = (why: string): EngineVerdict => ({ ok: false, why });
  let worker: EngineVerdict;
  if (!found) worker = no(`${p.title} is not on this machine.`);
  else if (versionOk === false) worker = no(`${version} is older than ${p.version?.min}.`);
  else if (versionOk === null && p.version) worker = no(`${p.title}'s version could not be read.`);
  else if (account.signedIn === false && !p.account?.optional) worker = no(`Not signed in to ${p.title}.`);
  else if (!p.headless) worker = no(`agentglass does not know how to run ${p.title} without a terminal.`);
  else if (enforced === "no") worker = no(`agentglass cannot yet hold ${p.title}'s permissions before a turn.`);
  else worker = { ok: true };
  let orchestrator: EngineVerdict;
  if (!worker.ok) orchestrator = worker;
  else if (!p.screen || (p.id !== "claude" && !p.screen.inputBox)) orchestrator = no(`Cannot orchestrate yet: agentglass does not know how to read ${p.title}'s screen.`);
  else if (!p.tab) orchestrator = no(`Cannot orchestrate yet: ${p.title} does not open in a tab.`);
  else if (!p.modelFlag) orchestrator = no(`Cannot orchestrate yet: agentglass does not know which flag picks ${p.title}'s model.`);
  else orchestrator = { ok: true };
  return { worker, orchestrator };
}

// --- cache and the stored answers (this machine's database) ---

db.run(`
CREATE TABLE IF NOT EXISTS engine_probe (
  engine TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  facts TEXT NOT NULL,
  at INTEGER NOT NULL
);
`);
db.run(`
CREATE TABLE IF NOT EXISTS engine_test (
  engine TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  at INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);
`);

const testing = new Set<string>();

function storedAnswer(id: string): EngineReadiness["answers"] {
  if (testing.has(id)) return { state: "running" };
  const r = db.query<{ ok: number; at: number; ms: number; error: string }, [string]>(
    "SELECT ok, at, ms, error FROM engine_test WHERE engine = ?").get(id);
  if (!r) return { state: "never" };
  return r.ok ? { state: "ok", at: r.at, ms: r.ms } : { state: "failed", at: r.at, ms: r.ms, error: r.error };
}

const cacheKey = (id: string, path: string | null): string =>
  path ? [path, mtimeOf(path), ...configDirs(id).map(mtimeOf)].join("|") : "absent";

/**
 * Every engine's readiness on this machine.
 *
 * Cached by (binary path, binary mtime, config directory mtimes): opening the
 * page twice costs nothing and an upgrade or a login is seen at once. A probe
 * that timed out is never cached, so Recheck asks again. Never on an interval.
 */
export async function probeEngines(
  o: { fresh?: boolean | readonly string[]; which?: (cmd: string) => string | null } = {},
): Promise<EnginesReport> {
  const which = o.which ?? ((c: string) => Bun.which(c));
  const engines = await Promise.all(engineProviders().map(async (p) => {
    const path = which(p.bin);
    const key = cacheKey(p.id, path);
    let facts: EngineFacts | null = null;
    const skip = o.fresh === true || (Array.isArray(o.fresh) && o.fresh.includes(p.id));
    if (!skip) {
      const row = db.query<{ key: string; facts: string }, [string]>("SELECT key, facts FROM engine_probe WHERE engine = ?").get(p.id);
      if (row?.key === key) { try { facts = JSON.parse(row.facts) as EngineFacts; } catch { facts = null; } }
    }
    if (!facts) {
      facts = await runCheap(p, path);
      const slow = [facts.version, facts.status, facts.check].some((r) => r?.timedOut);
      if (!slow) {
        db.run("INSERT OR REPLACE INTO engine_probe (engine, key, facts, at) VALUES (?, ?, ?, ?)",
          [p.id, key, JSON.stringify(facts), Date.now()]);
      }
    }
    return deriveReadiness(p, facts, storedAnswer(p.id));
  }));
  return { host: hostname(), engines };
}

const TEST_PROMPT = "Reply with the single word: ok";

/** The argv of the one-line test, with the narrowest envelope each CLI has. */
export function testArgv(p: Provider, model: string | null): string[] | null {
  switch (p.headless?.argv) {
    case "claude": return ["-p", TEST_PROMPT, "--permission-prompts", "none"];
    case "codex": return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", TEST_PROMPT];
    case "hermes": return ["chat", `--query=${TEST_PROMPT}`, "--format", "stream-json", "--no-restore-cwd", "--max-turns", "1"];
    case "opencode": return model ? ["run", "--format", "json", "-m", model, TEST_PROMPT] : null;
    case "antigravity": return ["-p", TEST_PROMPT, "--output-format", "stream-json"];
    case "gemini": return ["-p", TEST_PROMPT];
    default: return null;
  }
}

/**
 * The one-line test: a real turn on the engine's own login, so it is only ever
 * run when a person asks. One at a time per engine; the answer and how long it
 * took are stored, so the page can say "Answered in 3 s, 2 hours ago".
 */
export async function testEngine(
  id: string, o: { which?: (cmd: string) => string | null; timeoutMs?: number } = {},
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const p = engineProviders().find((x) => x.id === id);
  if (!p) return { ok: false, ms: 0, error: "no such engine" };
  const path = (o.which ?? ((c: string) => Bun.which(c)))(p.bin);
  if (!path) return { ok: false, ms: 0, error: `${p.title} is not on this machine` };
  if (testing.has(id)) return { ok: false, ms: 0, error: `${p.title} is already being tested` };
  testing.add(id);
  const t0 = Date.now();
  const ceiling = o.timeoutMs ?? TEST_TIMEOUT_MS;
  // A throwaway directory: the turn must not find a repository to look at.
  const cwd = mkdtempSync(join(tmpdir(), "agx-engine-test-"));
  let result: { ok: boolean; ms: number; error?: string };
  try {
    let model: string | null = null;
    if (p.headless?.argv === "opencode") {
      // The free catalogue answers with no credential, and a model with no
      // `provider/` is refused: take the first one the CLI itself lists.
      const m = await runCommand([path, "models"], PROBE_TIMEOUT_MS, { cwd });
      const lines = m.out.split("\n").map((l) => l.trim()).filter(Boolean);
      model = lines.find((l) => l.startsWith("opencode/")) ?? lines[0] ?? null;
    }
    const argv = testArgv(p, model);
    if (!argv) {
      result = { ok: false, ms: 0, error: p.headless ? `${p.title} lists no model to test with` : `agentglass does not know how to run ${p.title} without a terminal` };
    } else {
      const r = await runCommand([path, ...argv], ceiling, { cwd });
      const ms = Date.now() - t0;
      result = r.timedOut
        ? { ok: false, ms, error: `${p.title} did not finish within ${Math.round(ceiling / 1000)} s` }
        : r.code === 0 ? { ok: true, ms } : { ok: false, ms, error: firstLine(r) || `${p.title} exited ${r.code}` };
    }
  } finally {
    testing.delete(id);
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a leftover temp directory is not a failure */ }
  }
  db.run("INSERT OR REPLACE INTO engine_test (engine, ok, at, ms, error) VALUES (?, ?, ?, ?, ?)",
    [id, result.ok ? 1 : 0, Date.now(), result.ms, result.error ?? ""]);
  return result;
}
