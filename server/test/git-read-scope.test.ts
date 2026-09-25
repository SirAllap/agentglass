/*
 * The /git/* reads are held to the open project, the way /files/* already was.
 *
 * Every mutating git route already refused a root outside the project; the
 * reads now go through the same gate, for every method. The test asks each
 * route below for a repository outside the project and expects a refusal.
 *
 * The second half is the git process itself: a directory that merely looks
 * like a bare repository can sit inside a project as ordinary files, and git
 * must not adopt its config. The reads below are checked to leave it unused.
 *
 * The route list is pulled from index.ts, so a new /git/ read that takes a
 * root and is not gated fails here rather than shipping.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const SOURCE = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();

/** The /git/ routes that take no `root` at all, so there is nothing to gate. */
const NO_ROOT = new Set(["/git/capability", "/git/repos", "/git/changes-v2", "/git/commandlog", "/git/status", "/git/commit", "/git/amend"]);
const ROUTES = [...new Set([...SOURCE.matchAll(/pathname === "(\/git\/[a-z-]+)"/g)].map((m) => m[1]!))]
  .filter((r) => !NO_ROOT.has(r))
  .sort();

const TOKEN = "machine-token-for-git-read-scope";
let dir = "";
let phone = "";
const procs: ReturnType<typeof Bun.spawn>[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;

const home = () => join(dir, "home");
const orbit = () => join(home(), "code", "orbit");
const trap = () => join(orbit(), "vendor", "trap");
const lib = () => join(orbit(), "vendor", "lib");
const MARK = () => join(dir, "MARK");

function sh(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=dev@example.com", "-c", "user.name=Dev", ...args], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: home(), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "ignore", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function repo(path: string, secret: string): void {
  mkdirSync(path, { recursive: true });
  sh(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), `${secret}\n`);
  sh(path, "add", "README.md");
  sh(path, "commit", "-q", "-m", `add ${secret}`);
  writeFileSync(join(path, "notes.txt"), `untracked ${secret}\n`);
}

async function boot(env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const state = join(dir, `state-${port}`);
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // Named, never `...process.env`: a leaked variable here is a server
    // reading the developer's real devices file or database.
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: home(),
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(state, "data"),
      XDG_CACHE_HOME: join(state, "cache"),
      AGENTGLASS_STATE_DIR: state,
      AGENTGLASS_DB: join(state, "agx.db"),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
    stdout: "ignore", stderr: "pipe",
  });
  procs.push(proc);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return base; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

let scoped = "", unscoped = "", noBrowse = "";

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-gitscope-")));
  // Refuse to go on anywhere but a fresh temp directory: every path below is
  // handed to a server as HOME and XDG_CONFIG_HOME.
  if (!dir.startsWith(realpathSync(tmpdir()))) throw new Error(`not a temp dir: ${dir}`);
  repo(orbit(), "orbit-readme");
  repo(join(home(), "work", "ledger"), "LEDGER-SECRET");
  repo(join(dir, "elsewhere", "vault"), "VAULT-SECRET");
  repo(join(home(), ".dotfiles"), "DOT-SECRET");

  // Ordinary files inside the project that git will take for a repository.
  mkdirSync(join(trap(), "objects"), { recursive: true });
  mkdirSync(join(trap(), "refs", "heads"), { recursive: true });
  mkdirSync(join(trap(), "hooks"));
  writeFileSync(join(trap(), "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(trap(), "README.md"), "hi\n");
  writeFileSync(join(trap(), "hooks", "post-index-change"), `#!/bin/sh\ntouch '${MARK()}-hook'\n`, { mode: 0o755 });
  writeFileSync(join(trap(), "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = false",
    "\tworktree = .",
    `\tfsmonitor = "touch '${MARK()}-fsmonitor'; false"`,
    "",
  ].join("\n"));

  // And a real checkout inside the project whose own config names a command.
  repo(lib(), "lib-readme");
  sh(lib(), "config", "core.fsmonitor", `touch '${MARK()}-own'; false`);

  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  phone = issueDevice("Orbit phone", "read").token;

  [scoped, unscoped, noBrowse] = await Promise.all([
    boot({ AGENTGLASS_ROOT: orbit() }),
    boot({}),
    boot({ AGENTGLASS_ROOT: orbit(), AGENTGLASS_FS_BROWSE_DISABLED: "1" }),
  ]);
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const p of procs) try { p.kill(); } catch { /* already gone */ }
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const as = (cred: string) => ({ authorization: `Bearer ${cred}` });
/** Enough parameters that every route gets as far as running git. */
const query = (root: string) =>
  new URLSearchParams({ root, path: "README.md", ref: "HEAD", hash: "HEAD", q: "SECRET", remote: "origin", from: "HEAD", to: "HEAD", limit: "5" });
const get = (base: string, route: string, root: string, cred: string) =>
  fetch(`${base}${route}?${query(root)}`, { headers: as(cred) });

describe("the /git/ reads that take a root", () => {
  test("the list pulled from source is the one this was written against", () => {
    // Twenty-nine at the time of writing. A drop means the pattern stopped
    // matching and the tests below are testing nothing.
    expect(ROUTES.length).toBeGreaterThanOrEqual(29);
    expect(ROUTES).toContain("/git/log");
    expect(ROUTES).toContain("/git/head");
  });

  test("a read key gets 403 on every one for a repo elsewhere under home", async () => {
    for (const route of ROUTES) {
      const r = await get(scoped, route, join(home(), "work", "ledger"), phone);
      const text = await r.text();
      expect({ route, status: r.status }).toEqual({ route, status: 403 });
      expect(text).not.toContain("LEDGER-SECRET");
    }
  });

  test("and for a repo outside home altogether", async () => {
    for (const route of ROUTES) {
      const r = await get(scoped, route, join(dir, "elsewhere", "vault"), phone);
      expect({ route, status: r.status }).toEqual({ route, status: 403 });
      expect(await r.text()).not.toContain("VAULT-SECRET");
    }
  });

  test("the desk is held to the open project too, as its writes already are", async () => {
    for (const route of ROUTES) {
      const r = await get(scoped, route, join(home(), "work", "ledger"), TOKEN);
      expect({ route, status: r.status }).toEqual({ route, status: 403 });
    }
  });

  test("a path parameter is judged as well as the root", async () => {
    const q = new URLSearchParams({ root: orbit() });
    q.append("path", join(home(), "work", "ledger"));
    const r = await fetch(`${scoped}/git/worktree-leftovers?${q}`, { headers: as(phone) });
    expect(r.status).toBe(403);
  });

  test("a POST to a read route is gated like a GET", async () => {
    // The read handlers do not check the method; a full key used POST to reach
    // them past a gate that only looked at GET.
    const out = await fetch(`${scoped}/git/log?root=${encodeURIComponent(join(home(), "work", "ledger"))}`, { method: "POST", headers: as(TOKEN) });
    expect(out.status).toBe(403);
    expect(await out.text()).not.toContain("LEDGER-SECRET");
    const dot = await fetch(`${unscoped}/git/log?root=${encodeURIComponent(join(home(), ".dotfiles"))}`, { method: "POST", headers: as(phone) });
    expect(dot.status).toBe(403);
  });

  test("a changelog bound that is an option is refused, not passed to git", async () => {
    // With no `from` and no tag the range is `to` alone; with a `from` it
    // leads the range, and the file written would be named `<target>..HEAD`.
    const target = join(dir, "written-by-changelog");
    for (const [from, to] of [["", `--output=${target}`], [`--output=${target}`, "HEAD"]]) {
      const q = new URLSearchParams({ root: orbit(), from: from!, to: to! });
      await (await fetch(`${scoped}/git/changelog?${q}`, { headers: as(phone) })).text();
    }
    expect(readdirSync(dir).filter((f) => f.startsWith("written-by-changelog"))).toEqual([]);
  });

  test("the open project still answers", async () => {
    const r = await fetch(`${scoped}/git/log?root=${encodeURIComponent(orbit())}&limit=5`, { headers: as(phone) });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain("add orbit-readme");
  });

  test("with no project open, a read key is still held back from a dot-directory under home", async () => {
    const dot = join(home(), ".dotfiles");
    const held = await get(unscoped, "/git/log", dot, phone);
    expect(held.status).toBe(403);
    expect(await held.text()).not.toContain("DOT-SECRET");
    const desk = await get(unscoped, "/git/log", dot, TOKEN);
    expect(desk.status).toBe(200);
    expect(JSON.stringify(await desk.json())).toContain("DOT-SECRET");
  });

  test("AGENTGLASS_FS_BROWSE_DISABLED closes every one, the open project included", async () => {
    for (const route of ROUTES) {
      const r = await get(noBrowse, route, orbit(), TOKEN);
      expect({ route, status: r.status }).toEqual({ route, status: 403 });
    }
  });

  test("/git/status drops paths outside the open project instead of reporting their repo", async () => {
    const r = await fetch(`${scoped}/git/status`, {
      method: "POST", headers: { ...as(phone), "content-type": "application/json" },
      body: JSON.stringify({ paths: [join(home(), "work", "ledger", "README.md"), join(orbit(), "README.md")] }),
    });
    expect(r.status).toBe(200);
    const roots = ((await r.json()) as { repos: { root: string }[] }).repos.map((x) => x.root);
    expect(roots).toEqual([orbit()]);
  });
});

describe("a directory that only looks like a repository", () => {
  test("no read runs the command its config names", async () => {
    rmSync(`${MARK()}-fsmonitor`, { force: true });
    rmSync(`${MARK()}-hook`, { force: true });
    rmSync(`${MARK()}-own`, { force: true });
    for (const route of ROUTES) {
      await (await get(scoped, route, trap(), TOKEN)).text();
      await (await get(scoped, route, lib(), TOKEN)).text();
    }
    await (await fetch(`${scoped}/git/status`, {
      method: "POST", headers: { ...as(TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ paths: [join(trap(), "README.md")] }),
    })).text();
    expect(existsSync(`${MARK()}-fsmonitor`)).toBe(false);
    expect(existsSync(`${MARK()}-own`)).toBe(false);
    expect(existsSync(`${MARK()}-hook`)).toBe(false);
  });
});

/*
 * Each flag on its own, through the wrapper, so that dropping any one of them
 * fails a test here — the route test above passes with any two of the three.
 */
describe("the git wrapper", () => {
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  let w = "";
  beforeAll(() => {
    w = realpathSync(mkdtempSync(join(tmpdir(), "agx-gitsafe-")));
    // The developer's own global config may set core.hooksPath or fsmonitor,
    // and either would decide these tests for them.
    writeFileSync(join(w, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = join(w, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });
  afterAll(() => {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
    if (w) rmSync(w, { recursive: true, force: true });
  });

  function checkout(name: string): string {
    const r = join(w, name);
    mkdirSync(r);
    const run = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=dev@example.com", "-c", "user.name=Dev", "-C", r, ...a], { stdout: "ignore", stderr: "ignore" });
    run("init", "-q");
    writeFileSync(join(r, "a.txt"), "a\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "init");
    return r;
  }

  test("a directory that only looks like a repository is not one", async () => {
    const { git } = await import("../src/git.ts");
    const fake = join(w, "fake");
    mkdirSync(join(fake, "objects"), { recursive: true });
    mkdirSync(join(fake, "refs", "heads"), { recursive: true });
    writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(fake, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n");
    expect(git(fake, ["rev-parse", "--show-toplevel"]).code).not.toBe(0);
  });

  test("a checkout's own fsmonitor is not run", async () => {
    const { git } = await import("../src/git.ts");
    const r = checkout("fsmon");
    const mark = join(w, "FSMON");
    Bun.spawnSync(["git", "-C", r, "config", "core.fsmonitor", `touch '${mark}'; false`]);
    git(r, ["status", "--porcelain"]);
    expect(existsSync(mark)).toBe(false);
  });

  test("a read runs no hook, and a commit still runs the user's pre-commit", async () => {
    const { git } = await import("../src/git.ts");
    const r = checkout("hooks");
    const mark = join(w, "HOOK");
    writeFileSync(join(r, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${mark}-read'\n`, { mode: 0o755 });
    writeFileSync(join(r, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${mark}-commit'\n`, { mode: 0o755 });
    // A new mtime is what makes `status` refresh the index, and a refresh is
    // what fires post-index-change.
    writeFileSync(join(r, "a.txt"), "a\n");
    Bun.spawnSync(["touch", "-d", "2020-01-01", join(r, "a.txt")]);
    git(r, ["status", "--porcelain"]);
    expect(existsSync(`${mark}-read`)).toBe(false);
    writeFileSync(join(r, "a.txt"), "b\n");
    git(r, ["-c", "user.email=dev@example.com", "-c", "user.name=Dev", "commit", "-q", "-am", "change"]);
    expect(existsSync(`${mark}-commit`)).toBe(true);
  });
});
