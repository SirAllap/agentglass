#!/usr/bin/env bun
/**
 * Does the COMMIT compile — for somebody who does not have your working tree?
 *
 * Nothing else in this repo asks that. `make typecheck` and CI's typecheck
 * steps both read the files on disk, and on this branch the files on disk are
 * never the commit: work-2026-08-05 is the shared trunk that every session
 * commits into and rebuilds from, so a dirty tree here is the normal state,
 * not an exception.
 *
 * The breakage that bought this script, 2026-08-06. Commit 5d2ac02 was made
 * with `git add -A` in a shared worktree and swept up four in-flight lines
 * belonging to another session: the `PanesResponse` import and a `const body`
 * in server/src/index.ts, and the import plus `get<PanesResponse>` in
 * web/src/lib/api.ts. They landed committed, importing a type that
 * shared/types.ts AT THAT COMMIT did not export. Extract 5d2ac02 clean and it
 * is two lines of tsc:
 *
 *   server/src/index.ts(5,49):  error TS2305: Module '"../../shared/types.ts"'
 *                               has no exported member 'PanesResponse'.
 *   web/src/lib/api.ts(2,1103): error TS2305: … same.
 *
 * And yet `bun run typecheck` was green in every single working tree, all day.
 * Every session had the good shared/types.ts sitting uncommitted on disk, so
 * every session's compiler saw the export. Only a clean checkout saw the truth,
 * and it was found by accident. That is the whole reason this exists: the check
 * has to look at the commit, and there has to be no path by which the working
 * tree can answer for it.
 *
 * So:
 *
 *   git archive <sha> | tar -x -C <sandbox>   the tree as anyone else would get
 *   ln -s <repo>/…/node_modules <sandbox>/…   borrowed, never installed
 *   bunx --no-install tsc --noEmit -p …       every tsconfig, in parallel
 *
 * The one thing linking buys back is the one thing that could ruin it — a path
 * out of the sandbox and into the working tree — so it is not assumed away.
 * Every run passes `--listFiles` and asserts that every file the compiler
 * actually opened was either inside the sandbox or inside a node_modules. A
 * guard that silently passes is worse than no guard, and this one would have
 * to lie about a file list to do it.
 *
 *   bun scripts/headcheck.ts              # HEAD
 *   bun scripts/headcheck.ts 5d2ac02      # any commit
 *   bun scripts/headcheck.ts --keep       # leave the sandbox to poke at
 *   bun scripts/headcheck.ts --repo DIR   # another checkout (the test uses this)
 *
 * Exit codes are three, not two, because "the checker could not run" must never
 * be readable as "the commit is fine":
 *   0  the commit compiles
 *   1  the commit does not compile
 *   2  the check could not be trusted — no node_modules, nothing to check, or
 *      the compiler reached a file outside the sandbox
 */

import { spawn } from "bun";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/**
 * The two workspaces the repo's own typechecks cover — `make typecheck` and
 * ci.yml both run exactly `cd web && bun run typecheck` and `cd server && …`.
 * This deliberately matches that set rather than exceeding it: a check that
 * fails on something CI is happy with teaches people to ignore it.
 *
 * mobile/ is not here on purpose. It is not a bun workspace member, it installs
 * with `npm ci` from its own package-lock.json, and its postinstall GENERATES
 * src/terminal/engine.generated.ts and nerdfont.generated.ts — both gitignored,
 * both imported by terminal-html.ts. A clean extraction of a commit therefore
 * does not contain them, so `tsc` there fails on a missing module rather than
 * on anything real, and the only honest fix is a full `npm ci` per run. That is
 * the 8-second budget below spent several times over on a workspace that no
 * other workspace imports. Its CI job covers it on a clean checkout already.
 * electron/ is absent for the simpler reason that it has no tsconfig — it is
 * hand-written .js and nothing type-checks it today.
 */
const WORKSPACES = ["server", "web"];

/** Where node_modules is borrowed from, repo-relative. "" is the workspace root. */
const NODE_MODULES_AT = ["", "server", "web"];

const usage = `bun scripts/headcheck.ts [<commit>] [--repo DIR] [--keep]

Type-check a commit in a clean extraction of itself, so a dirty working tree
cannot answer for it. Defaults to HEAD.`;

let ref = "HEAD";
let repoArg = process.cwd();
let keep = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--commit") ref = argv[++i] ?? ref;
  else if (a === "--repo") repoArg = argv[++i] ?? repoArg;
  else if (a === "--keep") keep = true;
  else if (a === "-h" || a === "--help") { console.log(usage); process.exit(0); }
  else if (a.startsWith("-")) { console.error(`headcheck: unknown flag ${a}\n\n${usage}`); process.exit(2); }
  else ref = a;
}

/**
 * Thrown, not `process.exit(2)`d. An exit skips `finally`, and this script owns
 * a temp tree and up to three compiler processes at the moment things go wrong
 * — which is exactly when they must not be left lying around.
 */
class Untrustworthy extends Error {}
function untrustworthy(why: string): never { throw new Untrustworthy(why); }

function git(...args: string[]): string {
  const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) untrustworthy(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

/* Everything below is set inside run(), not at the top level, because
 * `untrustworthy` throws: a throw before the try/catch at the bottom of this
 * file escapes as a stack trace, and — worse — one thrown between mkdtemp and
 * the try would leave the extraction behind on every failure. */
let REPO = "";
let SHA = "";
let SHORT = "";
let sandbox = "";
const linked: string[] = [];
const running = new Set<{ kill(): void }>();

async function run(): Promise<number> {
  const t0 = performance.now();

  const top = spawnSync("git", ["-C", repoArg, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) untrustworthy(`not a git repository: ${repoArg}`);
  REPO = top.stdout.trim();
  SHA = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  SHORT = SHA.slice(0, 7);

  sandbox = mkdtempSync(join(tmpdir(), "agx-headcheck-"));
  // The sandbox landing inside the repo would defeat the entire point — tsc
  // would be resolving relative paths back into the checkout it is supposed to
  // ignore, and the escape guard below would have nothing to catch.
  if (resolve(sandbox).startsWith(resolve(REPO) + sep)) {
    untrustworthy(`refusing to work inside the repository (TMPDIR=${tmpdir()} is under ${REPO})`);
  }

  // ── the tree as anyone else would get it ────────────────────────────────
  const archive = spawn(["git", "-C", REPO, "archive", "--format=tar", SHA], { stdout: "pipe", stderr: "pipe" });
  const untar = spawn(["tar", "-x", "-C", sandbox], { stdin: archive.stdout, stderr: "pipe" });
  const [arcCode, tarCode] = await Promise.all([archive.exited, untar.exited]);
  if (arcCode !== 0 || tarCode !== 0) {
    untrustworthy(`could not extract ${SHORT}: ${(await new Response(untar.stderr).text()).trim() || `git archive exited ${arcCode}`}`);
  }

  // A `.gitattributes` carrying `export-ignore` makes `git archive` drop files
  // without a word, and a project missing half its sources can type-check
  // green. There is no such file today; this is what notices the day there is.
  const tracked = git("ls-tree", "-r", "-z", "--name-only", SHA).split("\0").filter(Boolean);
  const dropped = tracked.filter((p) => !existsSync(join(sandbox, p)));
  if (dropped.length) {
    untrustworthy(`git archive dropped ${dropped.length} tracked file(s) — export-ignore? e.g. ${dropped.slice(0, 3).join(", ")}`);
  }

  // ── node_modules, borrowed rather than installed ────────────────────────
  for (const rel of NODE_MODULES_AT) {
    // Asked of the COMMIT, not of the checkout: a commit from before web/
    // existed should not be failed for a node_modules it never wanted.
    if (!existsSync(join(sandbox, rel))) continue;
    const real = join(REPO, rel, "node_modules");
    const here = join(sandbox, rel, "node_modules");
    if (!existsSync(real)) untrustworthy(`${join(rel, "node_modules")} is missing — run \`bun install\` first`);
    // node_modules is gitignored twice over (both forms, deliberately), so an
    // extracted one means somebody committed it and the borrowed copy would be
    // silently ignored in favour of it.
    if (existsSync(here)) untrustworthy(`${SHORT} has ${join(rel, "node_modules")} committed — refusing to check against it`);
    symlinkSync(real, here);
    linked.push(here);
  }

  // Every tsconfig in those workspaces, not a hard-coded list of three: web/
  // grew tsconfig.test.json this week precisely because its 122 suites were
  // being type-checked by nobody, and a list in this file would have missed it.
  const projects: { label: string; dir: string; config: string }[] = [];
  for (const ws of WORKSPACES) {
    const dir = join(sandbox, ws);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((f) => /^tsconfig.*\.json$/.test(f)).sort()) {
      projects.push({ label: `${ws}/${f}`, dir, config: f });
    }
  }
  if (!projects.length) untrustworthy(`${SHORT} has no tsconfig under ${WORKSPACES.join(", ")} — nothing was checked`);

  console.log(`headcheck ${SHORT} — ${projects.length} project(s), extracted clean, your working tree not consulted`);

  // In parallel because the three are independent and the wall clock is what
  // decides whether this gets run: measured on this machine (20 cores), 12.9s
  // one after another against 8.0s together, of which web/tsconfig.json alone
  // is 7.2s. Serial would have put it over the line.
  const results = await Promise.all(projects.map(check));

  const ms = performance.now() - t0;
  console.log("");
  for (const r of results) {
    const mark = r.ok ? "ok  " : "FAIL";
    console.log(`  ${mark}  ${r.label.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s  ${r.files} files read`);
  }

  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    // Labelled per project, and not de-duplicated across them: web/'s two
    // configs overlap on src/lib/, so one bad line there is genuinely two
    // failing projects, and collapsing them would hide which config to fix.
    for (const r of bad) {
      console.log(`\n── ${r.label} ──`);
      for (const line of r.diagnostics) console.log(line);
    }
    console.log(`\n${SHORT} does NOT compile on its own — ${bad.map((b) => b.label).join(", ")}.  (${(ms / 1000).toFixed(1)}s)`);
    console.log(`Your tree may well be green: it has files ${SHORT} does not. Commit them, or take them back out of the commit.`);
    return 1;
  }
  console.log(`\n${SHORT} compiles on its own.  (${(ms / 1000).toFixed(1)}s)`);
  return 0;
}

/** A tsc diagnostic: `src/index.ts(5,49): error TS2305: …`. */
const DIAGNOSTIC = /^(.*?)\((\d+),(\d+)\): (error|warning) TS\d+/;

async function check(p: { label: string; dir: string; config: string }) {
  const t0 = performance.now();
  // `bunx --no-install`, never a bare `bunx`: bunx runs the local binary if there
  // is one and silently DOWNLOADS the newest published otherwise, which is how
  // server/ once got type-checked by TypeScript 7.0.2 while web/ used 5.9.3.
  // --no-install turns that into a loud failure. --listFiles is what feeds the
  // did-it-escape check below, and --pretty false keeps the diagnostics one
  // line each so they can be rewritten into repo-relative paths.
  const proc = spawn(["bunx", "--no-install", "tsc", "--noEmit", "--pretty", "false", "--listFiles", "-p", p.config], {
    cwd: p.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  running.add(proc);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  running.delete(proc);
  const ms = performance.now() - t0;

  const files: string[] = [];
  const diagnostics: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("/") && !DIAGNOSTIC.test(line)) { files.push(line); continue; }
    // Paths come out relative to the project dir; ../shared/types.ts and
    // src/App.tsx both want to read as they would from the repo root.
    diagnostics.push(line.replace(DIAGNOSTIC, (_m, f: string, l: string, c: string, sev: string) =>
      `${relative(sandbox, resolve(p.dir, f))}(${l},${c}): ${sev} ${_m.slice(_m.lastIndexOf("TS"))}`));
  }

  // ── the guard: did the compiler read anything of yours? ─────────────────
  // The sandbox borrows three node_modules by symlink, and a symlink is the
  // one way a path could climb back out into the checkout whose contents this
  // whole script exists to disregard. So rather than reasoning about it, ask
  // the compiler what it opened. Anything that is neither inside the sandbox
  // nor inside a node_modules is a leak, and a leak is not a warning: a check
  // that quietly consulted the working tree is the bug, wearing a green tick.
  const escaped = files.filter((f) => !f.startsWith(sandbox + sep) && !f.includes(`${sep}node_modules${sep}`));
  if (escaped.length) {
    untrustworthy(`${p.label} read ${escaped.length} file(s) from outside the extraction — the check was consulting the working tree:\n  ${escaped.slice(0, 5).join("\n  ")}`);
  }
  if (!files.length) untrustworthy(`${p.label} type-checked no files at all${err.trim() ? `: ${err.trim()}` : ""}`);
  // tsc exits 1 with diagnostics and 0 without. Any other combination — a
  // crash, a config it could not read, a tsc that is not there — is the
  // checker failing, not the commit, and must not be reported as either green
  // or red.
  if (exit !== 0 && !diagnostics.length) {
    untrustworthy(`${p.label}: tsc exited ${exit} with nothing to say${err.trim() ? `\n${err.trim()}` : ""}`);
  }
  if (exit === 0 && diagnostics.length) {
    untrustworthy(`${p.label}: tsc exited 0 but printed diagnostics — output could not be parsed:\n${diagnostics.slice(0, 3).join("\n")}`);
  }

  return { label: p.label, ok: exit === 0, ms, files: files.length, diagnostics };
}

// Last in the file, and it stays last. Everything above is a top-level `const`,
// and a `run()` called before them reaches a temporal dead zone rather than a
// value — this script's first run died on exactly that, on the regex two
// functions up. The same trap put a black window on the desktop once.
let code = 0;
try {
  code = await run();
} catch (e) {
  if (!(e instanceof Untrustworthy)) throw e;
  console.error(`headcheck: ${e.message}`);
  code = 2;
} finally {
  // A guard that trips mid-flight leaves the other two compilers working on a
  // tree that is about to be deleted.
  for (const p of running) { try { p.kill(); } catch {} }
  if (!sandbox) {
    // Failed before there was anything to clean up.
  } else if (keep) {
    console.log(`\nsandbox kept at ${sandbox}`);
  } else {
    // The links are unlinked by hand BEFORE the recursive delete. rmSync does
    // not follow symlinks, so this is belt and braces — but the thing on the
    // other end of them is the real node_modules of a worktree three other
    // sessions are working in, and "should not follow" is not a good enough
    // reason to point a recursive delete at it.
    for (const l of linked) { try { unlinkSync(l); } catch {} }
    rmSync(sandbox, { recursive: true, force: true });
  }
}
process.exit(code);
