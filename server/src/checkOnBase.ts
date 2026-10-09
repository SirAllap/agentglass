/*
 * "Check on base": run one command on two trees — the base branch's tip and the
 * pull request's head — a few times each, and count what happened.
 *
 * The rule that shapes all of it: this changes NOTHING in the person's git. No
 * checkout, no worktree, no branch, no stash, no fetch, no config, and no object
 * written (so no `merge-tree`, which would add the merge to the object database).
 * Both trees are exported read-only (treeExport.ts: raw objects, no filter, no
 * attribute) into a private temp directory, the command runs there, and the
 * directory is deleted.
 * A commit that is not already local is a stop, not a fetch.
 *
 * The command comes from a CI log and runs repository code, so it runs only when
 * a person pressed Run on a command they could read and edit; its environment is
 * rebuilt from nothing (no token reaches it), and where bubblewrap works it runs
 * in a box with no network and only the export visible. Where it does not, the
 * plan says "none" and the page says so before the button is pressed.
 *
 * Ceilings, named so a gap is not mistaken for a choice: the export holds
 * TRACKED files only — no `node_modules`, no submodules, nothing untracked — so a
 * project that needs an install reads "could not run"; the head is the PR's head
 * commit, not the merge commit CI built (that ref is not local, and creating it
 * would write to the object database).
 */
import { spawn } from "bun";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CHECK_RUN_TIMEOUT_S, CHECK_RUNS, classifyRun, commandProblem, factsLine, tally, type RunRecord, type Sandbox } from "../../shared/checkOnBase.ts";
import { exportTree, spawnGit } from "./treeExport.ts";
import { hostSystemPaths, resolvePrograms, sandboxProbe } from "./plugin-sandbox.ts";

/** One run's output is cut here: enough to find the line that explains it, never a log. */
export const OUTPUT_CAP = 64 * 1024;

export function sandboxKind(): Sandbox {
  return sandboxProbe().ok ? "bwrap" : "none";
}

export const SHA = /^[0-9a-f]{40}$/i;
/** The commit is in this repository's object database already. Read-only: `cat-file` writes nothing. */
export async function commitIsLocal(gitRoot: string, sha: string): Promise<boolean> {
  if (!SHA.test(sha)) return false;
  const p = spawnGit(gitRoot, ["cat-file", "-e", `${sha}^{commit}`]);
  return (await p.exited) === 0;
}

/** Give the owner back access to every directory under `dir`, so the removal can enter them. Never follows a symlink. */
function unlock(dir: string): void {
  try { chmodSync(dir, 0o700); } catch { return; }
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name));
}

/** Remove a directory this module made: refuses anything that is not a direct child of the temp dir. */
function removeOwned(dir: string): void {
  const root = realpathSync(tmpdir());
  if (!dir || !dir.startsWith(root + sep) || !dir.slice(root.length + 1).startsWith("agx-check-")) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A command that took its own permissions away (chmod -w, a read-only tree) leaves a folder rm cannot enter:
    // give them back and try once more. Whatever still fails is left for the system's temp cleaner;
    // it must never cost the person the result they waited for.
    try { unlock(dir); rmSync(dir, { recursive: true, force: true }); } catch { /* left behind, result kept */ }
  }
}

export interface BoxInput {
  bwrap: string;
  tree: string;
  command: string;
  hostPath: string;
  home: string;
  programDirs: string[];
  systemDirs: string[];
  systemLinks: { path: string; target: string }[];
}

export const BOX_WORK = "/work";
export const BOX_HOME = "/home/box";

/**
 * The bwrap argv: nothing shared (`--unshare-all` takes the network and the pid
 * namespace, so a killed box leaves no child behind), a fresh home and tmp, the
 * system read-only, and the export — the only writable path — bound at /work.
 * The plugin box is plugin-shaped (install dir, grants, a bridge to the app), so
 * this is its own small argv beside it, built from the same probe and system paths.
 */
export function checkBoxArgv(i: BoxInput): string[] {
  const path = [...i.hostPath.split(":").filter((p) => p && !p.startsWith(i.home + "/") && p !== i.home), ...i.programDirs].join(":");
  const argv = [
    i.bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--setenv", "PATH", path, "--setenv", "HOME", BOX_HOME, "--setenv", "LANG", "C.UTF-8", "--setenv", "TERM", "dumb", "--setenv", "CI", "1",
    "--ro-bind", "/usr", "/usr",
  ];
  for (const d of i.systemDirs) argv.push("--ro-bind-try", d, d);
  for (const l of i.systemLinks) argv.push("--symlink", l.target, l.path);
  argv.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", BOX_HOME);
  for (const d of i.programDirs) argv.push("--ro-bind", d, d);
  argv.push("--bind", i.tree, BOX_WORK, "--chdir", BOX_WORK, "bash", "-c", i.command);
  return argv;
}

interface Lane { name: "base" | "head"; sha: string; tree: string; home: string }

/** What every box of one check shares, looked up once: only the tree differs per lane. */
function boxBase(bwrap: string, command: string): Omit<BoxInput, "tree"> {
  const hostPath = process.env.PATH ?? "";
  const first = command.trim().split(/\s+/)[0] ?? "";
  return { bwrap, command, hostPath, home: homedir(), programDirs: resolvePrograms(/^[\w.+-]+$/.test(first) ? [first] : [], hostPath, homedir()).dirs, ...hostSystemPaths() };
}

async function runOnce(lane: Lane, n: number, o: { command: string; box: Omit<BoxInput, "tree"> | null; timeoutS: number; outDir: string; signal?: AbortSignal }): Promise<RunRecord> {
  const hostPath = process.env.PATH ?? "";
  let argv: string[];
  // bwrap itself needs only a PATH (the box sets its own environment with --setenv); unboxed, the environment is rebuilt from nothing.
  let env: Record<string, string> = { PATH: hostPath };
  if (o.box) {
    argv = checkBoxArgv({ ...o.box, tree: lane.tree });
  } else {
    argv = ["bash", "-c", o.command];
    env = { PATH: hostPath, HOME: lane.home, LANG: "C.UTF-8", TERM: "dumb", CI: "1", TMPDIR: lane.home };
  }
  const file = join(o.outDir, `${lane.name}-${n}.log`);
  const fd = openSync(file, "w", 0o600);
  let written = 0;
  const sink = (chunk: Uint8Array) => {
    if (written >= OUTPUT_CAP) return;
    const part = chunk.subarray(0, OUTPUT_CAP - written);
    writeSync(fd, part);
    written += part.length;
  };
  let timedOut = false;
  try {
    const p = spawn(argv, { cwd: o.box ? undefined : lane.tree, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } } };
    // Readers are cancelled, never waited on to the end: a command that daemonises (`setsid`) escapes the
    // group kill below and keeps the pipe open, and waiting for EOF would hold this run, and the repository's lock, for as long as it lives.
    // In the box the pid namespace ends with the shell, so nothing outlives it there.
    const readers = [p.stdout.getReader(), p.stderr.getReader()];
    const pump = async (r: { read(): Promise<{ done: boolean; value?: Uint8Array }> }) => { for (;;) { const c = await r.read(); if (c.done || !c.value) return; sink(c.value); } };
    const stopReaders = () => { for (const r of readers) void r.cancel().catch(() => { /* already closed */ }); };
    const stop = () => { kill(); stopReaders(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutS * 1000);
    o.signal?.addEventListener("abort", stop, { once: true });
    try {
      const pumps = Promise.all(readers.map(pump));
      await p.exited;
      // The shell is gone: output still in the pipe is read at once; a held-open pipe gets this long.
      await Promise.race([pumps, Bun.sleep(1000)]);
      stopReaders();
      await pumps.catch(() => { /* cancelled mid-read */ });
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
    }
    closeSync(fd);
    const out = readFileSync(file, "utf8");
    return classifyRun(p.exitCode, out, timedOut ? o.timeoutS : undefined);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    return { outcome: "unrunnable", line: `could not start: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` };
  }
}

export interface CheckInput {
  /** What the person confirmed: "bwrap" needs a working box here, "none" runs with their rights. Never decided here. */
  sandbox: Sandbox;
  gitRoot: string;
  baseSha: string;
  headSha: string;
  command: string;
  runs?: number;
  timeoutS?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export type CheckRun =
  | { ok: true; sandbox: Sandbox; base: RunRecord[]; head: RunRecord[]; facts: string; cancelled: boolean }
  | { ok: false; error: string };

export async function runCheckOnBase(i: CheckInput): Promise<CheckRun> {
  const problem = commandProblem(i.command);
  if (problem) return { ok: false, error: problem };
  const local = await Promise.all([i.baseSha, i.headSha].map((sha) => commitIsLocal(i.gitRoot, sha)));
  if (!local[0]) return { ok: false, error: "the base commit is not local" };
  if (!local[1]) return { ok: false, error: "the head commit is not local" };
  const runs = Math.max(1, Math.min(i.runs ?? CHECK_RUNS, 5));
  const timeoutS = i.timeoutS ?? CHECK_RUN_TIMEOUT_S;
  const probe = sandboxProbe();
  if (i.sandbox === "bwrap" && !probe.ok) return { ok: false, error: "no sandbox is available on this machine" };
  const box = i.sandbox === "bwrap" && probe.ok ? boxBase(probe.bwrap, i.command) : null;
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agx-check-"));
  try {
    const lanes: Lane[] = [
      { name: "base", sha: i.baseSha, tree: join(root, "base"), home: join(root, "home-base") },
      { name: "head", sha: i.headSha, tree: join(root, "head"), home: join(root, "home-head") },
    ];
    const errs = await Promise.all(lanes.map((l) => exportTree(i.gitRoot, l.sha, l.tree)));
    const bad = errs.findIndex(Boolean);
    if (bad >= 0) return { ok: false, error: `could not export the ${lanes[bad]!.name} commit: ${errs[bad]}` };
    const outDir = join(root, "out");
    mkdirSync(outDir);
    for (const l of lanes) mkdirSync(l.home);
    const result: Record<"base" | "head", RunRecord[]> = { base: [], head: [] };
    let done = 0;
    i.onProgress?.(0, runs * 2);
    const lane = async (l: Lane) => {
      for (let n = 1; n <= runs; n++) {
        if (i.signal?.aborted) return;
        result[l.name].push(await runOnce(l, n, { command: i.command, box, timeoutS, outDir, signal: i.signal }));
        i.onProgress?.(++done, runs * 2);
      }
    };
    // Two lanes at once only where half the cores leave room for both; a lane never overlaps itself.
    if (Math.floor(availableParallelism() / 2) >= 2) await Promise.all(lanes.map(lane));
    else for (const l of lanes) await lane(l);
    const cancelled = !!i.signal?.aborted;
    return { ok: true, sandbox: i.sandbox, base: result.base, head: result.head, facts: factsLine(tally(result.base), tally(result.head)), cancelled };
  } finally {
    removeOwned(root);
  }
}
