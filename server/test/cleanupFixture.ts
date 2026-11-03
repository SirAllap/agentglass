// A machine for the cleanup tests: real git (a bare origin, a clone, a linked
// worktree, a stash) in a temp directory, and fake docker/gh/tmux/psql behind
// the engine's injected Runner. Anything the Runner does not know answers 127,
// so no real program besides git and du can be reached.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupConfig, CleanupCtx } from "../src/cleanup.ts";
import { EMPTY_CLEANUP_CONFIG } from "../src/cleanup.ts";
import type { Runner } from "../src/diskclean.ts";

export const BRANCH = "ORBIT-1042-fix-x";
export const SLUG = "ORBIT-1042";
export const PR = 77;
export const URL77 = "https://github.com/acme/orbit/pull/77";

export interface FakeContainer { name: string; state: "running" | "exited"; image: string; labels?: string }
/** One tmux pane as `list-panes -a` prints it. */
export interface FakePane { session: string; windowId: string; window: string; cwd: string; cmd: string; pid: string }
export interface FakeImage { repo: string; tag: string; id: string; size: string }

export interface World {
  root: string; origin: string; main: string; wt: string; home: string; state: string; procDir: string;
  containers: FakeContainer[]; images: FakeImage[]; volumes: string[]; panes: FakePane[]; dbs: string[];
  /** The pull request as `gh pr view` answers it, and the list `gh pr list --state open` answers. */
  pr: { state: string; mergedAt: string | null; mergeCommit: { oid: string } | null; headRefName: string; headRefOid: string; baseRefName: string; title: string; url: string };
  openPrs: { number: number; headRefName: string; baseRefName: string }[];
  /** `git worktree remove` fails the way a root-owned file makes it fail. */
  denyWorktreeRemove: boolean;
  calls: string[];
  forgot: unknown[];
  git(dir: string, ...args: string[]): string;
  ctx(over?: Partial<CleanupCtx>): CleanupCtx;
  cfg(over?: Partial<CleanupConfig>): CleanupConfig;
  cleanup(): void;
}

const GIT_ENV = (home: string) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com",
});

export function makeWorld(o: { branch?: string; mainOnBranch?: boolean } = {}): World {
  const branch = o.branch ?? BRANCH;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agx-cleanup-")));
  const home = join(root, "home"), state = join(root, "state"), procDir = join(root, "proc");
  const origin = join(root, "origin.git"), main = join(root, "orbit"), wt = join(root, `orbit-${branch}`);
  for (const d of [home, state, procDir]) mkdirSync(d, { recursive: true });
  const env = GIT_ENV(home);
  const sh = (dir: string, ...args: string[]): string => {
    const p = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  sh(root, "init", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, main);
  writeFileSync(join(main, "README.md"), "orbit\n");
  sh(main, "add", "README.md"); sh(main, "commit", "-q", "-m", "init"); sh(main, "push", "-q", "-u", "origin", "main");
  sh(main, "remote", "set-head", "origin", "main");
  let headDir = main;
  if (o.mainOnBranch) { sh(main, "checkout", "-q", "-b", branch); }
  else { sh(main, "worktree", "add", "-q", wt, "-b", branch); headDir = wt; }
  writeFileSync(join(headDir, "feature.txt"), "feature\n");
  sh(headDir, "add", "feature.txt"); sh(headDir, "commit", "-q", "-m", "feature"); sh(headDir, "push", "-q", "-u", "origin", branch);
  // a stash that names the branch (the commit is the stash's own)
  writeFileSync(join(headDir, "README.md"), "orbit\nscratch idea\n");
  sh(headDir, "stash", "push", "-q", "-m", "park");
  const head = sh(headDir, "rev-parse", "HEAD");

  const w: World = {
    root, origin, main, wt: o.mainOnBranch ? main : wt, home, state, procDir,
    containers: [], images: [], volumes: [], panes: [], dbs: [],
    pr: { state: "MERGED", mergedAt: "2026-10-01T10:00:00Z", mergeCommit: { oid: head }, headRefName: branch, headRefOid: head, baseRefName: "main", title: "Fix the thing", url: URL77 },
    openPrs: [{ number: PR, headRefName: branch, baseRefName: "main" }],
    denyWorktreeRemove: false, calls: [], forgot: [],
    git: (dir, ...args) => sh(dir, ...args),
    ctx: () => { throw new Error("replaced below"); },
    cfg: (over = {}) => ({ ...EMPTY_CLEANUP_CONFIG, ...over }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };

  const realExec: Runner = async (cmd, args, opt) => {
    const p = Bun.spawn([cmd, ...args], { cwd: opt?.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr: string, code = 1) => ({ code, stdout: "", stderr });

  const docker = (a: string[]) => {
    const [v, ...rest] = a;
    if (v === "ps") return ok(w.containers.map((c) => [c.name, c.state, c.image, c.labels ?? ""].join("\t")).join("\n"));
    if (v === "images") return ok(w.images.map((i) => [i.repo, i.tag, i.id, i.size].join("\t")).join("\n"));
    if (v === "volume" && rest[0] === "ls") return ok(w.volumes.join("\n"));
    if (v === "volume" && rest[0] === "rm") { w.volumes = w.volumes.filter((x) => x !== rest[1]); return ok(); }
    if (v === "stop") { const c = w.containers.find((x) => x.name === rest[0]); if (!c) return no("No such container"); c.state = "exited"; return ok(); }
    if (v === "rm") {
      const c = w.containers.find((x) => x.name === rest[0]);
      if (!c) return no("No such container");
      if (c.state === "running") return no("cannot remove a running container");
      w.containers = w.containers.filter((x) => x !== c); return ok();
    }
    if (v === "rmi") {
      const i = w.images.find((x) => `${x.repo}:${x.tag}` === rest[0]);
      if (!i) return no("No such image");
      if (w.containers.some((c) => c.image === rest[0])) return no("image is being used by a container");
      w.images = w.images.filter((x) => x !== i); return ok();
    }
    if (v === "run") {
      // the root-owned fallback: -e D=<name> -v <parent>:/c alpine sh -c 'rm -rf "/c/${D:?}"'
      const d = a[a.indexOf("-e") + 1]!.replace(/^D=/, ""), parent = a[a.indexOf("-v") + 1]!.replace(/:\/c$/, "");
      if (!d || parent === "/") return no("refused", 2);
      rmSync(join(parent, d), { recursive: true, force: true });
      return ok();
    }
    return no(`unexpected docker ${a.join(" ")}`, 2);
  };

  const run: Runner = async (cmd, args, opt) => {
    if (cmd === "git" || cmd === "du") {
      if (w.denyWorktreeRemove && cmd === "git" && args.includes("worktree") && args.includes("remove")) return no("error: failed to delete 'x': Permission denied");
      return realExec(cmd, args, opt);
    }
    w.calls.push([cmd, ...args].join(" "));
    if (cmd === "docker") return docker(args);
    if (cmd === "tmux") {
      if (args.includes("list-panes")) return ok(w.panes.map((p) => [p.session, p.windowId, p.window, p.cwd, p.cmd, p.pid].join("\t")).join("\n"));
      if (args.includes("kill-window")) { const id = args[args.indexOf("-t") + 1]; w.panes = w.panes.filter((p) => p.windowId !== id); return ok(); }
      return no("no server running");
    }
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1] ?? "";
      if (sql.startsWith("SELECT")) return ok(w.dbs.join("\n"));
      const m = /^DROP DATABASE "(.+)"$/.exec(sql);
      if (m) { w.dbs = w.dbs.filter((d) => d !== m[1]); return ok(); }
    }
    return { code: 127, stdout: "", stderr: `${cmd}: not available in tests`, missing: true };
  };

  w.ctx = (over = {}) => ({
    home, now: Date.parse("2026-10-29T12:00:00"), run, stateDir: state, procDir, tmuxSockets: () => [],
    gh: async (args) => {
      w.calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify(w.pr));
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify(w.openPrs));
      return no("unexpected gh call", 2);
    },
    forgetOwnState: (a) => { w.forgot.push(a); return 2; },
    ...over,
  });
  return w;
}

/** A process whose cwd is `dir`, as /proc shows it. */
export function fakeProcess(w: World, pid: number, dir: string): void {
  mkdirSync(join(w.procDir, String(pid)), { recursive: true });
  symlinkSync(dir, join(w.procDir, String(pid), "cwd"));
}

/** A folder tree for the evidence/notes/briefs steps. Returns the paths it made. */
export function put(path: string, text = "x"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}
export const read = (p: string) => readFileSync(p, "utf8");
