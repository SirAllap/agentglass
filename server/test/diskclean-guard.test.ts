// The door every deletion goes through. Each refusal is asserted twice: the
// answer is "refused", and the thing it was aimed at is still on disk. The
// programs a clean may run (docker, git) are a recording stub here: nothing in
// this file can reach a real docker.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKER_PRUNE, INSPECT_FORMAT, allowedFsRoots, deleteTarget, guardFs, removeGuarded, type DiskCtx, type Runner } from "../src/diskclean.ts";
import { C1, C2, row } from "./diskcleanFixture.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agx-dcguard-")));
  dirs.push(base);
  const home = join(base, "home");
  const elsewhere = join(base, "elsewhere");
  for (const d of [home, elsewhere, join(home, ".cache/claude-tmp/p/sess"), join(home, ".cache/uv"), join(home, ".cache/other"), join(home, "code")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(elsewhere, "precious.txt"), "keep");
  writeFileSync(join(home, "important.txt"), "keep");
  writeFileSync(join(home, ".cache/other/x"), "keep");
  writeFileSync(join(home, ".cache/uv/blob"), "x");
  writeFileSync(join(home, ".cache/claude-tmp/p/sess/a"), "x");
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; };
  // These directories are not git repositories: what the ignored-files check would say is injected, and the scan test runs the real one against a fake git.
  const ctx: DiskCtx = { home, now: Date.now(), run, procDir: join(base, "no-proc"), leftovers: async () => ({ names: [], more: 0 }) };
  return { base, home, elsewhere, calls, run, ctx, tmp: join(home, ".cache/claude-tmp"), uv: join(home, ".cache/uv") };
}

describe("guardFs: what a filesystem deletion may name", () => {
  test("a child of the Claude temp root is allowed; the root itself is not (it would take live sessions)", () => {
    const w = world();
    expect(guardFs({ root: w.tmp, path: join(w.tmp, "p/sess") }, w.home).ok).toBe(true);
    expect(guardFs({ root: w.tmp, path: w.tmp }, w.home)).toMatchObject({ ok: false });
  });

  test("a cache may be emptied as a whole", () => {
    const w = world();
    expect(guardFs({ root: w.uv, path: w.uv }, w.home).ok).toBe(true);
  });

  test("GUARD: empty, relative, non-string, NUL and '..' are refused", () => {
    const w = world();
    const bad: unknown[] = ["", "relative/path", ".cache/uv", undefined, null, 7, `${w.uv}\0/x`, `${w.tmp}/p/../../../../important.txt`, `${w.tmp}/..`];
    for (const path of bad) expect(guardFs({ root: w.tmp, path }, w.home)).toMatchObject({ ok: false });
    for (const root of bad) expect(guardFs({ root, path: join(w.tmp, "p/sess") }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: '..' is refused even where it would resolve back inside the root", () => {
    const w = world();
    expect(guardFs({ root: w.tmp, path: `${w.tmp}/p/../p/sess` }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: `${w.home}/.cache/../.cache/uv`, path: w.uv }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: a cache folder that is a link to $HOME is refused, and so is everything under it", () => {
    const w = world();
    rmSync(w.uv, { recursive: true });
    symlinkSync(w.home, w.uv);
    expect(guardFs({ root: w.uv, path: w.uv }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: w.uv, path: join(w.uv, "important.txt") }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: $HOME itself is refused, as the path and as the root", () => {
    const w = world();
    expect(guardFs({ root: w.tmp, path: w.home }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: w.home, path: w.home }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: w.home, path: join(w.home, "important.txt") }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: no home, or '/', is refused", () => {
    const w = world();
    for (const home of ["", "/", "relative"]) expect(guardFs({ root: w.tmp, path: join(w.tmp, "p/sess") }, home)).toMatchObject({ ok: false });
  });

  test("GUARD: a root that is not on the list is refused, whatever its path", () => {
    const w = world();
    for (const root of ["/etc", "/", "/tmp", join(w.home, ".cache"), join(w.home, ".cache/other"), join(w.home, ".claude"), join(w.home, "code")]) {
      expect(guardFs({ root, path: join(root, "x") }, w.home)).toMatchObject({ ok: false });
    }
    // the list is built from the home it is given: another home's cache is not this one's
    const other = world();
    expect(guardFs({ root: other.uv, path: other.uv }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: a path beside the root, or outside it, is refused", () => {
    const w = world();
    for (const path of [join(w.home, ".cache/other/x"), join(w.home, "important.txt"), join(w.elsewhere, "precious.txt"), "/etc/passwd"]) {
      expect(guardFs({ root: w.tmp, path }, w.home)).toMatchObject({ ok: false });
    }
  });

  test("GUARD: a symlink inside the root that points out is refused", () => {
    const w = world();
    symlinkSync(w.elsewhere, join(w.tmp, "p/escape"));
    expect(guardFs({ root: w.tmp, path: join(w.tmp, "p/escape") }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: w.tmp, path: join(w.tmp, "p/escape/precious.txt") }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: a root that is itself a link leading out of $HOME is refused", () => {
    const w = world();
    rmSync(w.uv, { recursive: true });
    symlinkSync(w.elsewhere, w.uv);
    expect(guardFs({ root: w.uv, path: w.uv }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: w.uv, path: join(w.uv, "precious.txt") }, w.home)).toMatchObject({ ok: false });
  });

  test("GUARD: a cache folder that is a link to another folder of $HOME is refused, and the memory it could lead to is never a target", async () => {
    const w = world();
    const memory = join(w.home, ".claude/projects/acme");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "notes.md"), "remember");
    const npm = join(w.home, ".npm/_cacache");
    mkdirSync(join(w.home, ".npm"), { recursive: true });
    symlinkSync(memory, npm);
    expect(guardFs({ root: npm, path: npm }, w.home)).toMatchObject({ ok: false });
    expect(guardFs({ root: npm, path: join(npm, "notes.md") }, w.home)).toMatchObject({ ok: false });
    expect((await deleteTarget({ via: "fs", root: npm, path: npm }, w.ctx)).status).toBe("refused");
    // a link to a harmless sibling is refused too: the folder is not where its name says
    rmSync(npm);
    symlinkSync(join(w.home, ".cache/other"), npm);
    expect(guardFs({ root: npm, path: npm }, w.home)).toMatchObject({ ok: false });
    expect(readFileSync(join(memory, "notes.md"), "utf8")).toBe("remember");
    expect(existsSync(join(w.home, ".cache/other/x"))).toBe(true);
  });

  test("the allowed roots are all inside the home, and the Claude memory folder is not one of them", () => {
    const home = "/home/dev";
    for (const r of allowedFsRoots(home).keys()) { expect(r.startsWith(`${home}/`)).toBe(true); expect(r).not.toContain(".claude/"); expect(r.endsWith("/.claude")).toBe(false); }
  });
});

describe("deleteTarget: what actually happens", () => {
  test("a session folder goes, its sibling and the file a link inside it pointed at do not", async () => {
    const w = world();
    mkdirSync(join(w.tmp, "p/sess2"), { recursive: true });
    symlinkSync(w.elsewhere, join(w.tmp, "p/sess/link"));
    const r = await deleteTarget({ via: "fs", root: w.tmp, path: join(w.tmp, "p/sess") }, w.ctx);
    expect(r.status).toBe("freed");
    expect(existsSync(join(w.tmp, "p/sess"))).toBe(false);
    expect(existsSync(join(w.tmp, "p/sess2"))).toBe(true);
    expect(readFileSync(join(w.elsewhere, "precious.txt"), "utf8")).toBe("keep");
  });

  test("a cache is emptied and left in place", async () => {
    const w = world();
    expect((await deleteTarget({ via: "fs", root: w.uv, path: w.uv }, w.ctx)).status).toBe("freed");
    expect(existsSync(w.uv)).toBe(true);
    expect(existsSync(join(w.uv, "blob"))).toBe(false);
  });

  test("emptying a folder keeps the folder itself: its mode and its inode, so a process holding it still has it", async () => {
    const w = world();
    chmodSync(w.uv, 0o700);
    mkdirSync(join(w.uv, "deep/er"), { recursive: true });
    const before = statSync(w.uv);
    expect((await deleteTarget({ via: "fs", root: w.uv, path: w.uv }, w.ctx)).status).toBe("freed");
    const after = statSync(w.uv);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o700);
    expect(existsSync(join(w.uv, "deep"))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("a child that cannot be removed does not stop the others, and is reported as needing sudo", async () => {
    const w = world();
    const locked = join(w.uv, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "owned"), "x");
    chmodSync(locked, 0o500);
    try {
      expect((await deleteTarget({ via: "fs", root: w.uv, path: w.uv }, w.ctx)).status).toBe("needs-sudo");
      expect(existsSync(join(w.uv, "blob"))).toBe(false);
    } finally { chmodSync(locked, 0o700); }
  });

  test("emptying the trash empties its index too, so no file manager lists a ghost", async () => {
    const w = world();
    const files = join(w.home, ".local/share/Trash/files"), info = join(w.home, ".local/share/Trash/info");
    mkdirSync(files, { recursive: true });
    mkdirSync(info, { recursive: true });
    writeFileSync(join(files, "old.zip"), "x");
    writeFileSync(join(info, "old.zip.trashinfo"), "[Trash Info]");
    expect((await deleteTarget({ via: "fs", root: files, path: files }, w.ctx)).status).toBe("freed");
    expect(existsSync(join(files, "old.zip"))).toBe(false);
    expect(existsSync(join(info, "old.zip.trashinfo"))).toBe(false);
    expect(existsSync(info)).toBe(true);
  });

  test("GUARD: the last look before the rm: a folder swapped for a link after the check is not followed", () => {
    const w = world();
    const sess = join(w.tmp, "p/sess");
    const g = guardFs({ root: w.tmp, path: sess }, w.home);
    if (!g.ok) throw new Error("setup");
    rmSync(sess, { recursive: true });
    symlinkSync(w.elsewhere, sess);
    expect(() => removeGuarded(g, sess)).toThrow(/changed/);
    expect(readFileSync(join(w.elsewhere, "precious.txt"), "utf8")).toBe("keep");
  });

  test("GUARD: every refusal leaves the disk as it was", async () => {
    const w = world();
    symlinkSync(w.elsewhere, join(w.tmp, "p/escape"));
    const aimed: [string, string][] = [
      [w.tmp, w.tmp], [w.tmp, w.home], [w.home, w.home], [w.tmp, `${w.tmp}/p/../../../important.txt`], [w.tmp, ""], ["", ""],
      [w.tmp, join(w.tmp, "p/escape")], [w.tmp, join(w.home, ".cache/other")], ["/etc", "/etc/hostname"],
    ];
    for (const [root, path] of aimed) expect((await deleteTarget({ via: "fs", root, path }, w.ctx)).status).toBe("refused");
    for (const f of [join(w.home, "important.txt"), join(w.home, ".cache/other/x"), join(w.elsewhere, "precious.txt"), join(w.tmp, "p/sess/a")]) expect(existsSync(f)).toBe(true);
  });

  test("GUARD: with no home to measure against, nothing is removed", async () => {
    const w = world();
    const r = await deleteTarget({ via: "fs", root: w.tmp, path: join(w.tmp, "p/sess") }, { ...w.ctx, home: "" });
    expect(r.status).toBe("refused");
    expect(existsSync(join(w.tmp, "p/sess/a"))).toBe(true);
  });

  test("GUARD: a target of a shape nobody defined is refused", async () => {
    const w = world();
    for (const t of [null, undefined, {}, { via: "shell", cmd: "rm -rf /" }, { via: "fs" }, "rm", 7] as unknown[]) {
      expect((await deleteTarget(t as never, w.ctx)).status).toBe("refused");
    }
    expect(w.calls).toEqual([]);
  });
});

describe("Hugging Face: only hub and xet are roots, never the folder that holds the login", () => {
  function hfWorld() {
    const w = world();
    const hf = join(w.home, ".cache/huggingface");
    for (const d of ["hub", "xet", "accelerate"]) mkdirSync(join(hf, d), { recursive: true });
    writeFileSync(join(hf, "hub/blob"), "x");
    writeFileSync(join(hf, "token"), "hf_invented_token_for_tests");
    writeFileSync(join(hf, "stored_tokens"), "work=hf_invented_other_token");
    writeFileSync(join(hf, "accelerate/default_config.yaml"), "mixed_precision: bf16\n");
    return { ...w, hf };
  }

  test("the roots are hub and xet; their parent is not one", () => {
    const w = hfWorld();
    const roots = [...allowedFsRoots(w.home).keys()];
    expect(roots).toContain(join(w.hf, "hub"));
    expect(roots).toContain(join(w.hf, "xet"));
    expect(roots).not.toContain(w.hf);
  });

  test("GUARD: deleting the token is refused whichever root it is aimed through, and it stays", async () => {
    const w = hfWorld();
    const token = join(w.hf, "token");
    for (const t of [
      { root: w.hf, path: token },                               // the folder above the caches is no root
      { root: w.hf, path: w.hf },
      { root: join(w.hf, "hub"), path: token },                  // beside the root, not inside it
      { root: join(w.hf, "hub"), path: join(w.hf, "hub/../token") },
      { root: join(w.hf, "xet"), path: join(w.hf, "stored_tokens") },
    ]) {
      expect((await deleteTarget({ via: "fs", ...t }, w.ctx)).status).toBe("refused");
    }
    expect(readFileSync(token, "utf8")).toBe("hf_invented_token_for_tests");
    expect(existsSync(join(w.hf, "stored_tokens"))).toBe(true);
    expect(existsSync(join(w.hf, "accelerate/default_config.yaml"))).toBe(true);
  });

  test("the cache itself is emptied and the login beside it is not", async () => {
    const w = hfWorld();
    expect((await deleteTarget({ via: "fs", root: join(w.hf, "hub"), path: join(w.hf, "hub") }, w.ctx)).status).toBe("freed");
    expect(existsSync(join(w.hf, "hub"))).toBe(true);
    expect(existsSync(join(w.hf, "hub/blob"))).toBe(false);
    expect(existsSync(join(w.hf, "token"))).toBe(true);
  });
});

describe("a disk mounted inside a cache is not emptied through the mount", () => {
  test("a child on another device is skipped and named; the others go", async () => {
    const w = world();
    mkdirSync(join(w.uv, "models"), { recursive: true });
    writeFileSync(join(w.uv, "models/big.bin"), "precious model");
    const g = guardFs({ root: w.uv, path: w.uv }, w.home);
    if (!g.ok) throw new Error(g.error);
    // lstat cannot show a second device without root: the comparison is injected
    const left = removeGuarded(g, w.uv, (p) => (p === join(g.real, "models") ? 99 : 1));
    expect(left).toEqual(["models"]);
    expect(existsSync(join(w.uv, "models/big.bin"))).toBe(true);
    expect(existsSync(join(w.uv, "blob"))).toBe(false);
  });

  test("a single path on another device than its root is skipped too", () => {
    const w = world();
    const g = guardFs({ root: w.tmp, path: join(w.tmp, "p/sess") }, w.home);
    if (!g.ok) throw new Error(g.error);
    expect(removeGuarded(g, join(w.tmp, "p/sess"), (p) => (p === g.real ? 99 : 1))).toEqual(["sess"]);
    expect(existsSync(join(w.tmp, "p/sess/a"))).toBe(true);
  });

  test("the answer says so instead of claiming everything went", async () => {
    // deleteFs is exercised through the real lstat: same device everywhere, so nothing is skipped and no detail is added
    const w = world();
    expect(await deleteTarget({ via: "fs", root: w.uv, path: w.uv }, w.ctx)).toEqual({ status: "freed" });
  });
});

describe("Docker: images, build cache and stopped containers, never volumes", () => {
  /** A docker that answers inspect/ps/images from the given text and records every call. */
  function docker(w: ReturnType<typeof world>, o: { inspect?: string; images?: string; ps?: string } = {}) {
    const run: Runner = async (cmd, args) => {
      w.calls.push([cmd, ...args]);
      const out = args[0] === "inspect" ? o.inspect : args[0] === "images" ? o.images : args[0] === "ps" ? o.ps : "";
      return { code: 0, stdout: out ?? "", stderr: "" };
    };
    return { ...w.ctx, run } as DiskCtx;
  }
  const rm = (w: ReturnType<typeof world>) => w.calls.filter((c) => c[1] === "rm");

  test("GUARD: no argv a clean can send contains volume, system or --volumes, and there is no container prune", () => {
    expect(Object.keys(DOCKER_PRUNE).sort()).toEqual(["cache", "images"]);
    for (const argv of Object.values(DOCKER_PRUNE)) {
      expect(argv.join(" ")).not.toMatch(/volume|system|buildx|container/);
      expect(argv).toContain("-f");
    }
  });

  test("images and cache run exactly their argv, each after the check that Docker is this machine's own", async () => {
    const w = world();
    const ctx = docker(w);
    for (const what of ["images", "cache"] as const) expect((await deleteTarget({ via: "docker", what }, ctx)).status).toBe("freed");
    const c = ["docker", "context", "show"];
    // the images prune is preceded by the re-check that no image exists only here
    expect(w.calls.filter((x) => x[1] === "prune" || x[2] === "prune")).toEqual([["docker", ...DOCKER_PRUNE.images], ["docker", ...DOCKER_PRUNE.cache]]);
    expect(w.calls[0]).toEqual(c);
  });

  test("containers go by the exact ids the scan showed: `docker rm <ids>`, no -f, no -v, never a prune", async () => {
    const w = world();
    const ctx = docker(w, { inspect: [row(C1, true), row(C2, true)].join("\n") });
    expect((await deleteTarget({ via: "docker", what: "containers", ids: [C1, C2] }, ctx)).status).toBe("freed");
    expect(rm(w)).toEqual([["docker", "rm", C1, C2]]);
    expect(w.calls).toContainEqual(["docker", "inspect", "--format", INSPECT_FORMAT, C1, C2]);
    expect(w.calls.some((c) => c.includes("prune") && c.includes("container"))).toBe(false);
  });

  test("GUARD: a container that is no longer a finished --rm run is left alone, the others still go", async () => {
    const w = world();
    // C1 was restarted and is running now; C2 is still what the scan showed. A third id was never in the scan.
    const ctx = docker(w, { inspect: [row(C1, true).replace(" false ", " true "), row(C2, true), row("d4".repeat(32), true)].join("\n") });
    const r = await deleteTarget({ via: "docker", what: "containers", ids: [C1, C2] }, ctx);
    expect(r.status).toBe("freed");
    expect(r.detail).toContain("1 container left alone");
    expect(rm(w)).toEqual([["docker", "rm", C2]]);
  });

  test("GUARD: no longer exit 0, no longer --rm, or now a compose service: nothing is removed", async () => {
    for (const inspect of [row(C1, true, { exit: 1 }), row(C1, false), row(C1, true, { compose: "orbit" }), ""]) {
      const w = world();
      const r = await deleteTarget({ via: "docker", what: "containers", ids: [C1] }, docker(w, { inspect }));
      expect(r.status).toBe("refused");
      expect(rm(w)).toEqual([]);
    }
  });

  test("GUARD: ids that are not container ids (a flag, a name, a wildcard, none, too many) never reach docker", async () => {
    const w = world();
    for (const ids of [undefined, [], ["-f"], ["--all"], ["orbit_db"], ["*"], [C1, "--force"], [7], "a1a1a1a1a1a1", Array.from({ length: 201 }, () => C1)] as unknown[]) {
      expect((await deleteTarget({ via: "docker", what: "containers", ids } as never, docker(w))).status).toBe("refused");
    }
    expect(w.calls.some((c) => c[1] === "rm" || c[1] === "inspect")).toBe(false);
  });

  test("an image made here since the scan stops the images prune: it would be gone for good", async () => {
    const w = world();
    const ps = `{"ID":"${C1.slice(0, 12)}","State":"running","Status":"Up","Labels":""}`;
    const local = '{"ID":"e5e5e5e5e5e5","Repository":"acme/tools","Tag":"dev","Digest":"<none>"}';
    const r = await deleteTarget({ via: "docker", what: "images" }, docker(w, { ps, inspect: row(C1, false).replace(" false ", " true "), images: local }));
    expect(r.status).toBe("refused");
    expect(w.calls.some((c) => c.includes("prune"))).toBe(false);
    // the same image, now used by a container, is not at risk
    const w2 = world();
    const used = row(C1, false, { image: "e5e5e5e5e5e5" + "0".repeat(52) }).replace(" false ", " true ");
    expect((await deleteTarget({ via: "docker", what: "images" }, docker(w2, { ps, inspect: used, images: local }))).status).toBe("freed");
  });

  test("GUARD: volumes, 'all', inherited names and nothing are refused and docker is never run", async () => {
    const w = world();
    for (const what of ["volumes", "all", "system", "", "constructor", "__proto__", "toString", undefined, 3]) {
      expect((await deleteTarget({ via: "docker", what } as never, w.ctx)).status).toBe("refused");
    }
    expect(w.calls).toEqual([]);
  });

  test("a docker that fails is a failure with its first line, not a success", async () => {
    const w = world();
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\nmore" });
    const r = await deleteTarget({ via: "docker", what: "cache" }, { ...w.ctx, run });
    expect(r).toEqual({ status: "failed", detail: "Cannot connect to the Docker daemon" });
  });
});

describe("worktrees: only a removable checkout of its repository, under ~/code", () => {
  function setup() {
    const w = world();
    const repo = join(w.home, "code/orbit");
    const wt = join(w.home, "code/orbit-ORBIT-1042");
    const locked = join(w.home, "code/orbit-locked");
    const outside = join(w.base, "orbit-outside");
    for (const d of [repo, wt, locked, outside]) mkdirSync(d, { recursive: true });
    const porcelain = [repo, wt, locked, outside].map((p, i) => `worktree ${p}\nHEAD abcdef0\nbranch refs/heads/b${i}\n${p === locked ? "locked\n" : ""}`).join("\n");
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return args.includes("list") ? { code: 0, stdout: porcelain, stderr: "" } : { code: 0, stdout: "", stderr: "" };
    };
    const removed = () => calls.filter((c) => c.includes("remove"));
    return { ...w, repo, wt, locked, outside, calls, removed, ctx: { ...w.ctx, run } as DiskCtx };
  }

  test("a listed checkout under ~/code is removed by git, without --force", async () => {
    const s = setup();
    expect((await deleteTarget({ via: "worktree", repo: s.repo, path: s.wt }, s.ctx)).status).toBe("freed");
    expect(s.removed()).toEqual([["git", "-C", s.repo, "worktree", "remove", s.wt]]);
  });

  test("GUARD: the main checkout, a locked one, one outside ~/code, one git does not list, '..', and empty are refused", async () => {
    const s = setup();
    const unlisted = join(s.home, "code/orbit-unlisted");
    mkdirSync(unlisted);
    const paths = [s.repo, s.locked, s.outside, unlisted, `${s.wt}/../orbit`, s.home, join(s.home, "code"), "", "relative"];
    for (const path of paths) expect((await deleteTarget({ via: "worktree", repo: s.repo, path }, s.ctx)).status).toBe("refused");
    expect((await deleteTarget({ via: "worktree", repo: "", path: s.wt }, s.ctx)).status).toBe("refused");
    expect(s.removed()).toEqual([]);
  });

  test("GUARD: a link under ~/code that leads out is judged by where it lands", async () => {
    const s = setup();
    const link = join(s.home, "code/orbit-link");
    symlinkSync(s.outside, link);
    expect((await deleteTarget({ via: "worktree", repo: s.repo, path: link }, s.ctx)).status).toBe("refused");
    expect(s.removed()).toEqual([]);
  });

  test("root-owned files: git's 'Permission denied' is 'needs sudo' and nothing escalates", async () => {
    const s = setup();
    const run: Runner = async (cmd, args) => args.includes("list")
      ? { code: 0, stdout: `worktree ${s.repo}\nHEAD a\nbranch refs/heads/main\n\nworktree ${s.wt}\nHEAD b\nbranch refs/heads/x\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: `error: failed to delete '${s.wt}': Permission denied` };
    const r = await deleteTarget({ via: "worktree", repo: s.repo, path: s.wt }, { ...s.ctx, run });
    expect(r.status).toBe("needs-sudo");
  });
});
