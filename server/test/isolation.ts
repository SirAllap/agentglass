/*
 * A test run lives in a home of its own, and says so loudly when it steps out.
 *
 * Redirecting `AGENTGLASS_DB` inside the test process was never enough, because
 * the tests do not stay inside it. About a dozen files boot a server or run
 * `bun -e` in a child, and every one of them wrote `HOME: process.env.HOME`
 * into the child's environment — the developer's real home, and on a machine
 * that sets them, the real `XDG_DATA_HOME` and `XDG_STATE_HOME` as well. A
 * child without `NODE_ENV=test` resolves its database the ordinary way, so it
 * opened `~/.local/share/agentglass/agentglass.db` and ran the migrations of
 * whatever branch was under test on it. Measured: the budget suite's timezone
 * child did exactly that on every run, and failed outright whenever the
 * installed app held the write lock for more than five seconds.
 *
 * Fixing it at each call site is the approach that already failed: the next
 * file copies the `HOME` line from the last one. So the process itself moves.
 * Before any test file is loaded, HOME and every XDG base point into one
 * scratch directory, and every child that is handed `process.env`, or a copy
 * of its `HOME`, inherits the scratch one without anybody having to remember.
 *
 * "Handed" is literal. A spawn that names no `env` at all — git, tmux, `sh`,
 * most of them — is not given `process.env` by bun but the environment the
 * process was LAUNCHED with, so nothing this file sets or deletes reaches it.
 * Measured on 1.3.9: every git the suite ran read the person's own
 * `~/.config/git/config`, and where that turns `rerere` on, the conflict test
 * in gitwork-rebase.test.ts failed 5 runs in 70 — the `git commit` inside
 * `git rebase --continue` starts git's detached auto-maintenance, whose
 * `git rerere gc` held `MERGE_RR.lock` just as the next pick needed it. Such
 * a spawn is handed a copy of `process.env` below: node's default, and what
 * every call site here was written against.
 *
 * `AGENTGLASS_DB` and `AGENTGLASS_STATE_DIR` are cleared rather than set. Set
 * to one scratch path, they made every process of the run share one database:
 * `db.ts` already gives each test process a fresh one of its own, a child that
 * resolves the ordinary way now lands under the scratch HOME, and tests that
 * say `AGENTGLASS_DB ||= …` expect to find it empty. Measured: the first
 * version of this file set both, and the server suite went from two failures
 * to more than six hundred — the first one read was "unable to open database
 * file", from a `||=` that picked up a directory nobody had created.
 *
 * Two more things a child needs that `process.env` alone does not give it:
 *
 *   - About thirty spawns hand the child `{ PATH }` and nothing else. With no
 *     HOME, Python's `expanduser` and bun's `homedir()` both fall back to the
 *     passwd entry, and the browser CLI under test read the real
 *     `~/.config/agentglass/token` and wrote the real
 *     `~/.cache/agentglass-browser`. An environment without HOME is given the
 *     scratch one; an environment that names a HOME keeps it, and the guard
 *     below still judges it.
 *   - bun reads HOME once, at startup, so `os.homedir()` in this process kept
 *     answering with the real home after the variable moved — measured,
 *     `selfupdate.ts` read `~/.cache/agentglass/last-update.json` eighteen
 *     times in one run. It answers from `process.env.HOME` on every call now,
 *     which is what node's own `homedir()` does.
 *
 * The same goes for the variables a running agentglass exports into the
 * terminals it owns. A suite started from one of those terminals inherited
 * `AGENTGLASS_PORT` and `AGENTGLASS_TOKEN` of the live app, and a hook script a
 * test spawned with `...process.env` could post straight into it — the real
 * server, writing the real database. CI has none of them, which is the other
 * reason they go: a run here should see what a run there sees.
 *
 * A child `bun test` (several suites run one to test a preload) comes back
 * through here with a HOME that is already scratch. That is this file's own
 * doing, and the parent may have set something up in it on purpose, so a
 * re-entry keeps what it was given.
 *
 * Then the guard, because a redirect is a promise and this is the check:
 *
 *   - in this process, `node:fs`, `Bun.file`, `Bun.write` and `bun:sqlite` refuse
 *     any path inside a real agentglass directory — `agentglass` or
 *     `agentglass-*` under the person's real config, data, state or cache base;
 *   - for a child, whose opens cannot be seen from here, `Bun.spawn` and
 *     `Bun.spawnSync` (which `node:child_process` goes through as well) hand
 *     a spawn without `env` a copy of `process.env`, fill in a missing HOME,
 *     work out where that child would put its database, config and state
 *     from the environment it ends up with, and refuse the spawn if the
 *     answer is real.
 *
 * Each refusal throws where it happens and is kept, and the run exits non-zero
 * at the end with the list — a refusal inside a `try` that falls back quietly
 * is still a failed run, and so is one `node:child_process` catches and hands
 * back as `{ error }` instead of throwing.
 *
 * What the guard cannot see, so the redirect is all that stands there:
 *   - a child that rebuilds its own environment (`env -i`, `sh -c "HOME=… cmd"`);
 *   - `Bun.$`, whose builtins run in-process without `node:fs` and whose
 *     children do not go through `Bun.spawn`;
 *   - `glob`, `lchmod`, `openAsBlob`, a Buffer path, a percent-encoded `file:`
 *     URL, `Database.open`, and a real directory reached through a symlink;
 *   - a child `bun test` given a different TMPDIR, which reads as a first entry
 *     rather than a re-entry, and a child run on a machine whose own XDG bases
 *     are custom, which guards only the defaults under the real home.
 *
 * And one thing the scratch HOME costs: a version manager that finds its tools
 * through HOME (mise, asdf, pyenv shims) cannot, in a child. Here and in CI the
 * real `bun` and `python3` sit on PATH ahead of any shim; a PATH with only
 * shims gets children that fail to start.
 *
 * All of it rests on Bun letting a CommonJS assignment reach the named imports
 * made after it — measured on 1.3.9. If a later bun stops doing that,
 * isolation.test.ts goes red rather than the guard going quiet.
 *
 * `node:fs` and `bun:sqlite` are patched through `createRequire` for the reason
 * tmpsweep.ts gives: the ESM namespace is frozen, the CommonJS object behind it
 * is what the named imports resolve against.
 */
import { afterAll } from "bun:test";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
/*
 * Required, never imported, and this preload listed FIRST. Bun copies a
 * builtin's exports into its ESM namespace the first time any module imports
 * it, and later assignments to the CommonJS object are not seen through that
 * copy — measured: with `import { tmpdir } from "node:os"` above the patch,
 * every `import { homedir }` after it still answered with the real home.
 */
const os = require("node:os") as { homedir: () => string; tmpdir: () => string; userInfo: () => { homedir: string } };
const fs = require("node:fs") as Record<string, unknown> & {
  mkdtempSync: (prefix: string) => string;
  mkdirSync: (p: string, o?: { recursive?: boolean }) => unknown;
  promises: Record<string, unknown>;
};
const TMP = resolve(os.tmpdir());
const scratch = (p: string | undefined): boolean => !!p && resolve(p).startsWith(TMP + "/");

// ── Where a person's things are, read before anything is redirected ────────

/*
 * The person's home, which on a re-entry is no longer $HOME. Not
 * `os.userInfo().homedir` either: in bun that answers with $HOME too, and a
 * child run built on it guarded its own scratch directory and nothing else —
 * measured, the fixture's reach at the real config went straight through. So
 * the first run passes the answer down, and a run that did not inherit it asks
 * the passwd database, which is where a child with no HOME would look.
 */
function passwdHome(): string {
  try {
    const r = Bun.spawnSync(["getent", "passwd", String(process.getuid?.() ?? "")]);
    const home = r.stdout.toString().split(":")[5];
    if (r.exitCode === 0 && home) return home;
  } catch { /* no getent: fall through */ }
  return os.userInfo().homedir;
}
const REAL_HOME = process.env.AGX_TEST_REAL_HOME
  || (process.env.HOME && !scratch(process.env.HOME) ? process.env.HOME : passwdHome());
process.env.AGX_TEST_REAL_HOME = REAL_HOME;

const XDG = [
  ["XDG_CONFIG_HOME", ".config"],
  ["XDG_DATA_HOME", ".local/share"],
  ["XDG_STATE_HOME", ".local/state"],
  ["XDG_CACHE_HOME", ".cache"],
] as const;

const bases = new Set<string>();
for (const home of new Set([REAL_HOME, process.env.HOME])) {
  if (home && !scratch(home)) for (const [, d] of XDG) bases.add(join(home, d));
}
for (const [v] of XDG) {
  const set = process.env[v];
  if (set && !scratch(set)) bases.add(resolve(set));
}
/** An exact file or directory somebody named, outside the scratch space. */
const named = new Set<string>();
for (const v of ["AGENTGLASS_DB", "AGENTGLASS_STATE_DIR"]) {
  const set = process.env[v];
  if (set && !scratch(set)) named.add(resolve(set));
}

/** Is `p` inside a real agentglass directory — the database, config or state of whoever runs this? */
export function isRealAgentglassPath(p: string): boolean {
  const abs = resolve(p);
  for (const n of named) if (abs === n || abs.startsWith(n + sep)) return true;
  for (const base of bases) {
    const rel = relative(base, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (/^agentglass($|-)/.test(rel.split(sep)[0]!)) return true;
  }
  return false;
}

// ── The redirect ────────────────────────────────────────────────────────────

/** The scratch home this process made, and removes at the end; none on a re-entry. */
let madeHome: string | null = null;
if (!scratch(process.env.HOME)) {
  for (const k of Object.keys(process.env)) if (k.startsWith("AGENTGLASS_")) delete process.env[k];
  madeHome = fs.mkdtempSync(join(TMP, "agx-test-home-"));
  process.env.HOME = madeHome;
  for (const [v, d] of XDG) process.env[v] = join(madeHome, d);
}
// With HOME deleted by a test, the scratch home, not the passwd one node would give.
const scratchHome = process.env.HOME!;
os.homedir = () => process.env.HOME || scratchHome;

/*
 * THE SUITE MUST NOT WRITE THE SETTINGS OF WHOEVER RUNS IT.
 *
 * `understudy.json` lives under XDG_CONFIG_HOME, and `AGENTGLASS_DB` does not
 * move it — so every `setOpenProject`, `setEnabled` or `setMode` in a test went
 * straight into the real file. Eight test files did exactly that.
 *
 * Measured: running the suite emptied the open-project setting on this
 * machine, which is the fence the work loop is bounded by. Three unrelated
 * ingest tests then failed, because they partition their material against
 * whatever name was left behind — passing alone and failing together, the
 * shape that costs an hour to find.
 *
 * AND IT REDIRECTS EVEN WHEN THE VARIABLE IS ALREADY SET. `if (!XDG_CONFIG_HOME)`
 * protected only a machine that had not set it. On one that points it at the
 * real `~/.config`, every test wrote the owner's own settings — the fence read
 * `agentglass`, one test file ran, and the fence read `""`. So a re-entry keeps
 * each variable only when it is ALREADY scratch; anything else is replaced.
 */
for (const [v, d] of XDG) {
  if (!scratch(process.env[v])) process.env[v] = join(process.env.HOME!, d);
}
for (const [, d] of XDG) fs.mkdirSync(join(process.env.HOME!, d), { recursive: true });

// ── The guard ───────────────────────────────────────────────────────────────

const refused: string[] = [];

function refuse(what: string, p: string): never {
  const line = `${what} ${p}`;
  refused.push(line);
  console.error(`\n[isolation] REFUSED: ${line}\n  a test reached a real agentglass directory; see server/test/isolation.ts\n`);
  throw new Error(`test isolation: ${line} is a real agentglass path`);
}

const asPath = (p: unknown): string | null =>
  typeof p === "string" ? p : p instanceof URL && p.protocol === "file:" ? p.pathname : null;

function check(what: string, ...ps: unknown[]): void {
  for (const raw of ps) {
    const p = asPath(raw);
    if (p !== null && isRealAgentglassPath(p)) refuse(what, p);
  }
}

/* The functions in node:fs that take a path, and those that take two. */
const ONE = [
  "access", "appendFile", "chmod", "chown", "createReadStream", "createWriteStream",
  "exists", "lchown", "lstat", "lutimes", "mkdir", "mkdtemp", "open", "opendir",
  "readdir", "readFile", "readlink", "realpath", "rm", "rmdir", "stat", "statfs",
  "truncate", "unlink", "utimes", "watch", "watchFile", "writeFile",
];
const TWO = ["copyFile", "cp", "link", "rename", "symlink"];

function wrap(obj: Record<string, unknown>, name: string, arity: 1 | 2): void {
  const real = obj[name];
  if (typeof real !== "function") return;
  obj[name] = function (this: unknown, ...a: unknown[]) {
    check(`fs.${name}`, ...a.slice(0, arity));
    return (real as (...x: unknown[]) => unknown).apply(this, a);
  };
}
for (const n of ONE) for (const v of [n, `${n}Sync`]) { wrap(fs, v, 1); wrap(fs.promises, v, 1); }
for (const n of TWO) for (const v of [n, `${n}Sync`]) { wrap(fs, v, 2); wrap(fs.promises, v, 2); }

const B = Bun as unknown as Record<string, (...a: unknown[]) => unknown>;
const realFile = B.file!;
B.file = (...a: unknown[]) => { check("Bun.file", a[0]); return realFile(...a); };
const realWrite = B.write!;
B.write = (...a: unknown[]) => { check("Bun.write", a[0]); return realWrite(...a); };

const sqlite = require("bun:sqlite") as { Database: new (...a: unknown[]) => unknown };
const RealDatabase = sqlite.Database;
sqlite.Database = class extends (RealDatabase as new (...a: unknown[]) => object) {
  constructor(...a: unknown[]) {
    check("new Database", a[0]);
    super(...a);
  }
} as typeof sqlite.Database;

/*
 * Where a child would put its things, from the environment it is handed —
 * the same fallbacks `server/src` uses. A child with no HOME at all falls back
 * to the passwd entry, which is the real one.
 */
export function childTargets(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || REAL_HOME;
  const base = (v: string, d: string) => env[v] || join(home, d);
  const state = env.AGENTGLASS_STATE_DIR;
  return [
    env.AGENTGLASS_DB || (state ? join(state, "agentglass.db") : join(base("XDG_DATA_HOME", ".local/share"), "agentglass", "agentglass.db")),
    join(base("XDG_CONFIG_HOME", ".config"), "agentglass"),
    state || join(base("XDG_STATE_HOME", ".local/state"), "agentglass"),
    join(base("XDG_CACHE_HOME", ".cache"), "agentglass"),
  ];
}

/** The spawn's arguments with the child's environment made explicit, a missing HOME filled in, and judged. */
function isolateSpawn(what: string, a: unknown[]): unknown[] {
  const arrayForm = Array.isArray(a[0]);
  type Opts = { env?: Record<string, string | undefined>; cmd?: unknown };
  let opts = (arrayForm ? a[1] : a[0]) as Opts | undefined;
  // No `env` would mean the launch environment, not this one: see the top.
  const env = !opts?.env ? { ...process.env }
    : !opts.env.HOME ? { AGX_TEST_REAL_HOME: REAL_HOME, ...opts.env, HOME: process.env.HOME }
    : opts.env;
  if (env !== opts?.env) {
    opts = { ...opts, env };
    a = arrayForm ? [a[0], opts, ...a.slice(2)] : [opts, ...a.slice(1)];
  }
  const cmd = arrayForm ? a[0] : opts?.cmd;
  for (const t of childTargets(env)) {
    if (isRealAgentglassPath(t)) refuse(`${what} ${JSON.stringify(cmd)} would use`, t);
  }
  return a;
}
for (const name of ["spawn", "spawnSync"]) {
  const real = B[name]!;
  B[name] = (...a: unknown[]) => real(...isolateSpawn(`Bun.${name}`, a));
}

/*
 * Registered from a preload this is a root hook: once, after the last test.
 * The home is removed here rather than by tmpsweep.ts, which loads after this
 * file and so never sees it being made.
 */
afterAll(() => {
  if (madeHome) (fs.rmSync as (p: string, o: object) => void)(madeHome, { recursive: true, force: true });
  /*
   * An exit code, not a throw. A root `afterAll` that throws stops bun from
   * running the ones registered after it — measured: tmpsweep's, so the one
   * run that refused something was also the one that left every scratch
   * directory behind.
   */
  if (refused.length) {
    console.error(`\n[isolation] ${refused.length} refusal(s) — the run touched real agentglass paths:\n  ${refused.join("\n  ")}\n`);
    process.exitCode = 1;
  }
});
