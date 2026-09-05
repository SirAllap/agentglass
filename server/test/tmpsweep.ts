/*
 * The suite takes its scratch directories with it when it goes.
 *
 * Nearly every file here opens a `mkdtempSync(join(tmpdir(), "agx-…"))` — 383
 * calls across 182 files — and almost none of them remove it. One run leaks a
 * few hundred directories; a week of runs leaks tens of thousands. Measured on
 * the machine this was written for: **14,096 stale `agx-*` directories in /tmp,
 * 8.5 GB**, and `/tmp` there is a tmpfs, so all of it was RAM that had been
 * pushed into swap. The desktop raised an out-of-memory warning with 1.9 GiB of
 * swap left; sweeping brought it back to 11.6 GiB.
 *
 * One preload rather than 182 `afterAll`s. Cleanup written at the call site is
 * cleanup somebody forgets on the 183rd file, and a test that fails half way
 * through never reaches its own `afterAll` anyway — which is exactly the run
 * that leaves the biggest mess.
 *
 * Two rules keep this from ever deleting something it should not:
 *
 *   - it removes only paths THIS PROCESS created, recorded as they are handed
 *     out. Sweeping by name pattern would have been simpler and wrong: several
 *     agents run this suite at once on this machine, and a pattern sweep would
 *     delete another run's directories out from under it, mid-test.
 *   - it removes only paths under `os.tmpdir()`. A test that deliberately makes
 *     a directory somewhere else is none of this file's business.
 *
 * `node:fs` is patched through `createRequire`, not through the ESM namespace:
 * the ESM namespace object is frozen (`Attempted to assign to readonly
 * property`), while the CommonJS module object behind it is the same object the
 * named imports resolve against — verified, not assumed.
 */
import { afterAll } from "bun:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

type Fs = {
  mkdtempSync: (...a: unknown[]) => string;
  mkdirSync: (p: unknown, o?: unknown) => string | undefined;
  rmSync: (p: string, o?: { recursive?: boolean; force?: boolean }) => void;
  promises: { mkdtemp: (...a: unknown[]) => Promise<string> };
};

const fs = createRequire(import.meta.url)("node:fs") as Fs;
const TMP = resolve(tmpdir());

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
 * Here rather than in eight `beforeAll`s, for the same reason the sweep below
 * is here: eight places is eight chances to forget, and the ninth file
 * somebody adds tomorrow gets it for free. `storePath()` reads the variable on
 * every call, so setting it is enough — nothing is imported, and in particular
 * the database is untouched, which a preload that imported the module would
 * open before any test could point it somewhere safe.
 */
/*
 * AND IT REDIRECTS EVEN WHEN THE VARIABLE IS ALREADY SET.
 *
 * `if (!XDG_CONFIG_HOME)` protected only a machine that had not set it. On one
 * that points it at the real `~/.config`, every test wrote the owner's own
 * settings — which is the case this guard exists for.
 *
 * Measured on this machine, this morning, with the deputy stuck: the fence read
 * `agentglass`, one test file ran, and the fence read `""`. The suite had been
 * emptying it a dozen times a night — the whole "it has nowhere to work" was
 * the tests, not the deputy.
 *
 * A test process has no business writing anybody's config, so it never gets to
 * see the real one: pointed at a fresh directory unless it is ALREADY inside
 * the machine's temp directory, which is this preload's own doing on a re-entry.
 */
if (!process.env.XDG_CONFIG_HOME || !resolve(process.env.XDG_CONFIG_HOME).startsWith(TMP + "/")) {
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(resolve(TMP, "agx-test-config-"));
}
/** Every scratch directory this process was handed, newest last. */
const made: string[] = [];

/** Under the machine's temp directory, and not the temp directory itself. */
const ours = (p: unknown): p is string =>
  typeof p === "string" && resolve(p).startsWith(TMP + "/");

const note = <T,>(p: T): T => {
  if (ours(p)) made.push(p);
  return p;
};

const realSync = fs.mkdtempSync;
fs.mkdtempSync = (...a: unknown[]) => note(realSync(...a));

const realAsync = fs.promises.mkdtemp;
fs.promises.mkdtemp = async (...a: unknown[]) => note(await realAsync(...a));

/*
 * And the fixed-name directories, which are the other half.
 *
 * `mkdtempSync` covers what the tests open for themselves. What it does not
 * cover is `server/src` running inside the test process and making its own
 * runtime directories — `agx-restore-state-<pid>`, `agx-tmux-conf-home-<pid>`
 * — one set per run, named after a pid that will never come back.
 *
 * Only what this call actually CREATED is recorded. With `recursive`, node
 * returns the topmost directory it made and `undefined` when there was nothing
 * to make, which is exactly the distinction needed; without it, a call that
 * returns at all is a call that created the directory, because an existing one
 * throws.
 */
const realMkdir = fs.mkdirSync;
fs.mkdirSync = (p: unknown, o?: unknown) => {
  const made = realMkdir(p, o);
  const recursive = !!(o && typeof o === "object" && (o as { recursive?: boolean }).recursive);
  return note(recursive ? (made as string | undefined) : (p as string)) as string | undefined;
};

/**
 * Newest first, so a directory made inside another one is gone before its
 * parent is — not required by `recursive`, but it keeps the order honest if
 * one of the removals throws.
 *
 * `force` because a test that cleaned up after itself is the good case, not an
 * error, and nothing here is worth failing a green run over.
 */
function sweep(): void {
  // Drained rather than iterated, so calling it twice is harmless.
  while (made.length) {
    const dir = made.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  sweepPidNamed();
}

/*
 * And whatever this process stamped with its own pid.
 *
 * Two suites hand tmux a socket path of their own — `/tmp/agx-pscroll-<pid>-3.sock`,
 * `/tmp/agx-wsize-<pid>.sock` — and tmux, not node, is what creates the file, so
 * nothing above sees it. They are zero bytes each and there are nine per run,
 * which is nine more directory entries a day than /tmp needs.
 *
 * Matching on the pid is what makes this safe: a name carrying THIS process's
 * pid was written by this process. The delimiters matter — a bare `includes`
 * would let pid 1722 claim `agx-wsize-1722266.sock`, which belongs to a run
 * that may still be going.
 */
function sweepPidNamed(): void {
  const pid = String(process.pid);
  let names: string[];
  try { names = (fs as unknown as { readdirSync: (p: string) => string[] }).readdirSync(TMP); }
  catch { return; }
  for (const name of names) {
    if (!new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(name)) continue;
    try { fs.rmSync(`${TMP}/${name}`, { recursive: true, force: true }); } catch { /* not ours to remove */ }
  }
}

/* `afterAll` from the test runner, not `process.on("exit")` — measured, that
   one never fires under `bun test`. Registered from a preload it is a root
   hook: it runs once, after the last test of the run. */
afterAll(sweep);
process.on("exit", sweep); // belt and braces for a plain `bun` run of a script
// A run stopped by hand is the one most likely to leave a mess behind, so the
// signals get the same treatment. Re-raised with the default handler so the
// exit code still says what happened.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { sweep(); process.exit(sig === "SIGINT" ? 130 : 143); });
}
