// `git status` is not a safe answer to "is anything in this worktree?".
//
// The branches panel's bulk delete has to remove a worktree before it can
// delete the branch checked out in it, and `git worktree remove` deletes the
// whole directory — gitignored files included, with no `--force` needed and no
// warning printed. A checkout holding `compose/envs/*.env` and a page of local
// notes reports `status --porcelain` completely empty, so anything that asks
// git "is it clean?" and acts on a yes has already lost that work.
//
// These pin the difference: the ignored file that git hides, the noise that
// would bury it, and the two answers that must never read as "nothing to lose"
// — a path that isn't ours, and a checkout we couldn't read at all.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-leftovers-")));
const REPO = join(dir, "repo");
const WT = join(dir, "repo-feature");   // has ignored work in it
const BARE = join(dir, "repo-empty");   // nothing but rebuildable noise
const GHOST = join(dir, "repo-ghost");  // removed from under git

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own scope
process.env.AGENTGLASS_DB = join(dir, "l.db");
// Writes are scope-gated (guard() -> inScope()), and `bun test` runs every file
// in ONE process — so without this the scope left behind by whichever file ran
// before decides whether rescueLeftovers() is allowed to touch this temp repo.
// Passing on its own and failing in the suite is the symptom.
process.env.AGENTGLASS_ROOT = dir;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let gw: typeof import("../src/gitwork.ts");
/** The report lists entries now, not bare strings — each carries its size and
 *  what the main checkout has at that path. These tests care about the names. */
const paths = (r: { entries: { path: string }[] }) => r.entries.map((e) => e.path);

beforeAll(async () => {
  process.env.AGENTGLASS_ROOT = dir; // again here: another file may have moved it
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "t");
  // `.specs/` names the DIRECTORY, which is the common shape and the one that
  // defeats git's own expansion — see the "whole directory" test below.
  writeFileSync(join(REPO, ".gitignore"), "*.env\n__pycache__/\nnode_modules/\n.mypy_cache/\nnotes-local.md\n.specs/\n");
  writeFileSync(join(REPO, "README"), "x\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "root");

  // The checkout that matters: clean to git, holding real work on disk.
  git(REPO, "branch", "feature");
  git(REPO, "worktree", "add", "-q", WT, "feature");
  writeFileSync(join(WT, "secrets.env"), "API_KEY=real\n");
  writeFileSync(join(WT, "notes-local.md"), "what I found\n");
  mkdirSync(join(WT, "src", "__pycache__"), { recursive: true });
  writeFileSync(join(WT, "src", "__pycache__", "mod.cpython-311.pyc"), "\x00");
  mkdirSync(join(WT, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(WT, "node_modules", "left-pad", "index.js"), "//\n");
  // A directory holding nothing tracked collapses to one line in git's output.
  // `cfg/` alone says nothing about which of these two it is, and they need
  // opposite answers.
  mkdirSync(join(WT, "cfg", "__pycache__"), { recursive: true });
  writeFileSync(join(WT, "cfg", "local.env"), "DB=here\n");
  writeFileSync(join(WT, "cfg", "__pycache__", "c.cpython-311.pyc"), "\x00");

  // Both checkouts have a `.specs/`, ignored by a rule that names the whole
  // directory. The main one holds an old note; the worktree holds one nobody
  // else has. Only the second must be offered, and it can only BE offered if
  // the directory gets broken open first.
  mkdirSync(join(REPO, ".specs"), { recursive: true });
  writeFileSync(join(REPO, ".specs", "older.md"), "from before\n");
  mkdirSync(join(WT, ".specs"), { recursive: true });
  writeFileSync(join(WT, ".specs", "findings.md"), "the notes I need\n");

  // The three answers the main checkout can give about a path, which is what
  // decides whether an entry is hidden, offered, or offered-with-a-warning.
  writeFileSync(join(REPO, "shared.env"), "SAME=1\n");        // identical in both
  writeFileSync(join(WT, "shared.env"), "SAME=1\n");
  writeFileSync(join(REPO, "drifted.env"), "MAIN=1\n");       // exists in both, different
  writeFileSync(join(WT, "drifted.env"), "WORKTREE=1\n");

  // Nothing but rebuildable output — the one case that IS safe to remove.
  git(REPO, "branch", "spare");
  git(REPO, "worktree", "add", "-q", BARE, "spare");
  mkdirSync(join(BARE, ".mypy_cache"), { recursive: true });
  writeFileSync(join(BARE, ".mypy_cache", "cache.json"), "{}\n");

  // Still registered with git, directory gone from disk.
  git(REPO, "branch", "ghost");
  git(REPO, "worktree", "add", "-q", GHOST, "ghost");
  rmSync(GHOST, { recursive: true, force: true });

  gw = await import("../src/gitwork.ts");
});

describe("worktreeLeftovers", () => {
  test("names the ignored files git reports as clean", async () => {
    // The premise. If this ever stops holding, the rest of this file is moot
    // and `git status` would be a fine guard on its own.
    expect(git(WT, "status", "--porcelain")).toBe("");

    const r = await gw.worktreeLeftovers(REPO, WT);
    expect(r.error).toBeUndefined();
    expect(paths(r)).toContain("secrets.env");
    expect(paths(r)).toContain("notes-local.md");
  });

  test("counts rebuildable output instead of listing it", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    // Four hundred `__pycache__/` lines would bury the one `.env` that matters,
    // and a dialog nobody reads to the end guards nothing.
    expect(paths(r).some((f: string) => f.includes("__pycache__"))).toBe(false);
    expect(paths(r).some((f: string) => f.includes("node_modules"))).toBe(false);
    expect(r.skipped).toBeGreaterThanOrEqual(2);
  });

  test("opens a collapsed directory rather than reporting its name", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    // git prints `cfg/` and stops, because nothing in it is tracked. Listing
    // that verbatim hides the env file and cries wolf about the cache; both
    // halves have to come out.
    expect(paths(r)).toContain("cfg/local.env");
    expect(paths(r)).not.toContain("cfg/");
    // `src/` collapses the same way but holds only a cache — it must vanish
    // from the list entirely, not sit in it as an unexplained directory.
    expect(paths(r).some((f: string) => f.startsWith("src"))).toBe(false);
  });

  test("an empty answer means empty — only when it really is", async () => {
    const r = await gw.worktreeLeftovers(REPO, BARE);
    expect(r.error).toBeUndefined();
    expect(paths(r)).toEqual([]);
    // Reported, so the UI can say "nothing but caches" rather than "empty" —
    // the two look identical in `files` alone.
    expect(r.skipped).toBeGreaterThan(0);
  });

  test("a checkout it cannot read reports an error, not an empty list", async () => {
    const r = await gw.worktreeLeftovers(REPO, GHOST);
    // "Couldn't look" and "nothing there" must never produce the same value:
    // the caller removes on the second and refuses on the first.
    expect(r.error).toBeTruthy();
    expect(paths(r)).toEqual([]);
  });

  test("refuses a path that is not a worktree of this repo", async () => {
    const r = await gw.worktreeLeftovers(REPO, dir);
    expect(r.error).toBeTruthy();
    expect(paths(r)).toEqual([]);
  });

  test("hides what the main checkout already has, byte for byte", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    // A worktree is a second copy of the repo, so most of what looks alarming
    // in it is a duplicate. Deleting a duplicate loses nothing, and listing it
    // buries the entries that do matter.
    expect(paths(r)).not.toContain("shared.env");
    expect(r.identical).toBeGreaterThanOrEqual(1);
  });

  test("marks a path that exists in the main checkout but differs", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    const e = r.entries.find((x) => x.path === "drifted.env");
    // Offered — the worktree's copy may well be the newer one — but flagged,
    // because copying it back OVERWRITES the main checkout's version.
    expect(e?.vsMain).toBe("differs");
    expect(r.entries.find((x) => x.path === "secrets.env")?.vsMain).toBe("absent");
  });

  test("breaks open a directory ignored as a whole directory", async () => {
    // The case that nearly cost the whole feature. When .gitignore names the
    // directory (`.specs/`), `git status --ignored=matching -- .specs/` answers
    // `.specs/` again and never descends — so the list would offer one
    // undivided `.specs/`, which is "differs" against the main checkout's own
    // `.specs/` and therefore never pre-ticked and refused as already-existing.
    // The one file nobody has a copy of would never be offered at all.
    const r = await gw.worktreeLeftovers(REPO, WT);
    expect(paths(r)).toContain(".specs/findings.md");
    expect(paths(r)).not.toContain(".specs/");
    // And the file that only the main checkout has must not appear at all: it
    // isn't in this worktree, so nothing about it is at risk.
    expect(paths(r)).not.toContain(".specs/older.md");
    expect(r.entries.find((e) => e.path === ".specs/findings.md")?.vsMain).toBe("absent");
  });

  test("sorts the safe ones first, smallest first", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    const firstDiffers = r.entries.findIndex((e) => e.vsMain === "differs");
    const lastAbsent = r.entries.map((e) => e.vsMain).lastIndexOf("absent");
    // Otherwise a 708K directory of screenshots hides behind 22 MB of build
    // output in a list that gets cut at twelve.
    if (firstDiffers >= 0) expect(firstDiffers).toBeGreaterThan(lastAbsent);
    expect(r.entries.every((e) => e.bytes >= 0)).toBe(true);
  });
});

/** Runs after the block above ON PURPOSE: these copy `notes-local.md` and
 *  `secrets.env` INTO the main checkout, which turns them into `identical` and
 *  removes them from what worktreeLeftovers() lists. Reorder the two describes
 *  and the first one starts failing for a reason that has nothing to do with
 *  it. */
describe("foreignOwned", () => {
  test("says nothing when every file is ours", () => {
    // The normal case, and the one that must not cost anything: a false
    // positive here refuses a removal that would have worked fine.
    expect(gw.foreignOwned(WT)).toBeNull();
  });

  test("a directory nobody can read is not a directory full of strangers", () => {
    expect(gw.foreignOwned(join(dir, "does-not-exist"))).toBeNull();
  });
});

describe("fixWorktreeOwnership", () => {
  test("refuses a path that is not a worktree of this repo", () => {
    // This is the ONE call that reaches root. The path must come from git, not
    // from the request, or a crafted call points chown at anything.
    const r = gw.fixWorktreeOwnership(REPO, dir);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a worktree");
  });

  test("refuses the main checkout", () => {
    const r = gw.fixWorktreeOwnership(REPO, REPO);
    expect(r.ok).toBe(false);
  });

  test("does nothing, and elevates nothing, when the files are already ours", () => {
    // No pkexec, no dialog, no root: there is nothing to hand back. If this
    // ever starts prompting on a clean checkout, that is the bug.
    const r = gw.fixWorktreeOwnership(REPO, WT);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("already yours");
  });
});

describe("rescueLeftovers", () => {
  test("copies into the main checkout at the same relative path", async () => {
    const r = await gw.rescueLeftovers(REPO, WT, ["notes-local.md"]);
    expect(r.ok).toBe(true);
    expect(r.copied).toEqual(["notes-local.md"]);
    expect(readFileSync(join(REPO, "notes-local.md"), "utf8")).toBe("what I found\n");
    // And the worktree still has it — this is a copy, not a move. The removal
    // that follows is what takes the original, and it must be able to fail
    // without having already destroyed anything.
    expect(existsSync(join(WT, "notes-local.md"))).toBe(true);
  });

  test("copies a directory whole", async () => {
    const r = await gw.rescueLeftovers(REPO, WT, ["cfg/"]);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(REPO, "cfg", "local.env"), "utf8")).toBe("DB=here\n");
  });

  test("REFUSES to overwrite what the main checkout already has", async () => {
    // The whole safety property. `drifted.env` differs in the two checkouts, and
    // a "rescue" that clobbers the main copy with the dying worktree's version
    // is the exact accident this feature exists to prevent.
    const before = readFileSync(join(REPO, "drifted.env"), "utf8");
    const r = await gw.rescueLeftovers(REPO, WT, ["drifted.env"]);
    expect(r.ok).toBe(false);
    expect(r.copied).toEqual([]);
    expect(r.skipped?.[0]?.why).toContain("already exists");
    expect(readFileSync(join(REPO, "drifted.env"), "utf8")).toBe(before);
  });

  test("refuses to climb out of the worktree", async () => {
    const r = await gw.rescueLeftovers(REPO, WT, ["../../../etc/passwd", "../repo/README"]);
    expect(r.copied).toEqual([]);
    expect(r.skipped).toHaveLength(2);
    for (const s of r.skipped!) expect(s.why).toContain("outside");
  });

  test("refuses a path that is not a worktree of this repo", async () => {
    const r = await gw.rescueLeftovers(REPO, dir, ["anything"]);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("reports each failure rather than stopping at the first", async () => {
    const r = await gw.rescueLeftovers(REPO, WT, ["nope-does-not-exist", "secrets.env"]);
    expect(r.copied).toEqual(["secrets.env"]);
    expect(r.skipped?.[0]?.path).toBe("nope-does-not-exist");
  });
});
