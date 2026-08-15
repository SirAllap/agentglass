// Prepare the packaging inputs: a fresh web build and a standalone server
// sidecar, staged where electron-builder's extraResources expects them. Run by
// the `dist*` scripts before electron-builder so the app is always packaged
// from current source, never a stale dist.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, lstatSync, readlinkSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// --- what tree was actually packaged ---------------------------------------
//
// The stamp used to be `git rev-parse HEAD` and nothing else, which answers a
// question nobody asks: "what was HEAD when the build started". Every input to
// the package comes off DISK — electron/package.json `files` and
// `extraResources` are copied by electron-builder from the working tree, and
// the web bundle and the sidecar are compiled from it a few lines above. So a
// dirty tree produced a binary stamped with a commit it did not contain, and
// the UI rendered that as seven authoritative hex characters.
//
// It cost twice in one day:
//  - a binary stamped 9699619 carried the tailscale-serve auth fix from
//    dd1f558, its CHILD. "Does my installed app have the security fix?" — the
//    one question this field exists for — could not be answered from it.
//  - an install carried another session's uncommitted electron/main.js, which
//    is how a build that could not draw a window reached the desktop.
//
// The threat model now: two different trees MUST NOT produce the same stamp,
// and a build that is not a commit must say so where it is read. So the stamp
// identifies the TREE (a content hash over every source file that feeds the
// package) and only degrades to a bare commit sha when the tree is provably
// that commit. Refusing to build a dirty tree was rejected: this repo is a
// shared worktree with several agents in it and it is dirty most of the day —
// a rule that stops the build would be worse than the bug it prevents.
//
// What this deliberately does NOT cover: node_modules. It is not tracked and
// not enumerable cheaply; bun.lock (which IS hashed) pins the graph, and a
// hand-mutated node_modules is out of reach of any stamp short of hashing the
// finished package.

/**
 * Source paths that end up inside the package, directly or as the input to
 * something that does. This has to track electron/package.json's `files` and
 * `extraResources`: web/dist is built from web/, staging/agentglass-server is
 * compiled from server/src + shared, and hooks/bin/skills are copied verbatim.
 *
 * Tests are left out on purpose, and only where their exclusion is provable:
 * `bun build --compile server/src/index.ts` bundles the reachable import graph,
 * which never reaches server/test, and vite builds from web/index.html. Marking
 * a build dirty because somebody edited a test is how a warning stops being
 * read — the same failure the wifi monitor had. Uncommitted work outside this
 * closure is still counted and reported, just not in the stamp.
 */
const PACKAGED_SOURCE = [
  "electron", "web", "server/src", "shared", "hooks", "bin", "skills",
  "package.json", "bun.lock",
  // Not shipped, but it decides which files below the roots above ARE: adding a
  // line here changes what the hash can see, so a change to it has to count as
  // a change to the package.
  ".gitignore",
];
/** Inside a listed root, but no part of the package. */
const NOT_PACKAGED = [/^web\/test\//];

/** Whether a path belongs to the package, by PREFIX rather than by looking it
 *  up in the enumerated file list.
 *
 *  The list-membership version of this had a hole big enough to reintroduce the
 *  bug: `git mv electron/main.js docs/main.js` leaves electron/main.js in
 *  neither `ls-files -c` nor `-o`, so it was absent from the set, counted as an
 *  edit "outside the package", and the build stamped itself a clean commit sha
 *  with a packaged file missing. A prefix test does not care whether the path
 *  still exists. */
const isPackaged = (p) =>
  PACKAGED_SOURCE.some((root) => p === root || p.startsWith(root + "/")) &&
  !NOT_PACKAGED.some((re) => re.test(p));

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

/** Tracked + untracked-but-not-ignored files under the closure. Uses git's own
 *  ignore rules rather than a hand-kept skip list, so electron/staging and
 *  web/dist (both generated, both gitignored) can never enter the hash. */
function packagedFiles() {
  const r = git("ls-files", "-z", "-c", "-o", "--exclude-standard", "--", ...PACKAGED_SOURCE);
  if (r.status !== 0) return null;
  return (r.stdout ?? "").split("\0")
    .filter((p) => p && !NOT_PACKAGED.some((re) => re.test(p)))
    .sort();
}

/**
 * A content hash of those files: path, executable bit and bytes.
 *
 * The mode is in there because it is part of what ships — bin/agentglass-browser
 * and self-update.sh are only useful executable. A symlink hashes its target
 * rather than being followed, so retargeting one is a different tree.
 */
function hashTree(files) {
  const h = createHash("sha256");
  for (const rel of files) {
    const abs = resolve(REPO, rel);
    let st;
    // A tracked file that is deleted in the working tree is a real difference,
    // so it is hashed as absent rather than skipped.
    try { st = lstatSync(abs); } catch { h.update(`${rel}\0absent\0\0`); continue; }
    if (st.isSymbolicLink()) { h.update(`${rel}\0link\0${readlinkSync(abs)}\0`); continue; }
    const mode = st.mode & 0o111 ? "755" : "644";
    h.update(`${rel}\0${mode}\0${createHash("sha256").update(readFileSync(abs)).digest("hex")}\0`);
  }
  return h.digest("hex");
}

/**
 * `git status --porcelain -z` as { code, paths } records.
 *
 * The -z form is not line-oriented and a rename carries TWO paths, so it cannot
 * be split naively — doing that reads the old path of a rename as a status code
 * for a file called "". Both paths are kept, because a rename that moves a file
 * OUT of the package is a change to the package and only the old path says so.
 */
function statusEntries() {
  const r = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  if (r.status !== 0) return null;
  const fields = (r.stdout ?? "").split("\0");
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const code = f.slice(0, 2).trim() || "?", path = f.slice(3);
    if (f[0] === "R" || f[0] === "C") { out.push({ code, paths: [path, fields[++i] ?? ""] }); continue; }
    out.push({ code, paths: [path] });
  }
  return out;
}

/**
 * Everything the stamp needs to be unable to lie.
 *
 * `stamp` is the single string the UI and the installer show, and its shape is
 * the "obvious at a glance" part: seven hex characters means a commit and
 * nothing else ever does. Anything else carries a word — `+dirty.`, `unknown` —
 * that no sha can contain.
 */
function treeIdentity(commit) {
  const files = packagedFiles();
  const status = files ? statusEntries() : null;
  if (!files || !status) {
    // No git means no way to prove this tree is any commit. "unknown" is the
    // honest answer and, unlike a sha, is obviously not one.
    return { stamp: "unknown", tree: "", dirty: true, dirtyFiles: [], dirtyOther: 0 };
  }
  const dirtyFiles = [], other = [];
  for (const { code, paths } of status) {
    // `M path`, and `R old -> new` for a rename, which is how git itself writes
    // it and the only form that shows a file leaving the package.
    const label = `${code} ${paths.length > 1 ? `${paths[1]} -> ${paths[0]}` : paths[0]}`;
    (paths.some(isPackaged) ? dirtyFiles : other).push(label);
  }
  const tree = hashTree(files);
  const short = commit.slice(0, 7);
  const stamp = !commit ? `nocommit.${tree.slice(0, 7)}`
    : dirtyFiles.length === 0 ? short
    : `${short}+dirty.${tree.slice(0, 7)}`;
  return { stamp, tree, dirty: dirtyFiles.length > 0, dirtyFiles: dirtyFiles.sort(), dirtyOther: other.length };
}

// Re-hash the tree and compare it with a stamp already written into a package.
//
// build.mjs necessarily runs BEFORE electron-builder copies the files, so a
// save landing in that window ships in a package the stamp does not describe —
// which on a worktree three agents are editing is not hypothetical. Callers run
// this after packaging and before doing anything irreversible.
if (process.argv.includes("--check-stamp")) {
  const target = process.argv[process.argv.indexOf("--check-stamp") + 1];
  let stamped;
  try { stamped = JSON.parse(readFileSync(target, "utf8")); }
  catch (e) { console.error(`cannot read the packaged stamp at ${target}: ${e.message}`); process.exit(1); }
  const now = treeIdentity(git("rev-parse", "HEAD").stdout?.trim() ?? "");
  if (!stamped.tree || !now.tree) {
    console.error(`cannot verify the stamp: no tree hash (packaged ${stamped.stamp ?? "?"}, here ${now.stamp})`);
    process.exit(1);
  }
  if (stamped.tree !== now.tree) {
    console.error(`\nthe tree changed while the package was being built.`);
    console.error(`  packaged: ${stamped.stamp}`);
    console.error(`  now:      ${now.stamp}`);
    console.error(`Whatever is in dist-app is stamped with a tree that is no longer here,`);
    console.error(`which is the exact lie this stamp exists to prevent. Build it again.`);
    process.exit(1);
  }
  console.log(`==> stamp verified against the tree: ${now.stamp}`);
  process.exit(0);
}

// CI builds the web UI and cross-compiles the sidecar for each target platform
// itself (a bun `--compile --target=` this host cannot produce), then calls us
// only to stamp provenance. In that mode we must NOT rebuild either — wiping
// staging would delete the cross-built sidecar CI just placed, and recompiling
// would produce a host-arch binary in a package meant for another platform.
//
// This is the seam the desktop-binaries workflow needs: before this existed,
// CI never ran build.mjs at all, so its installers shipped with no
// build-info.json and no self-update.sh — the whole update path was dead on
// every binary anyone downloaded, while local builds (which do run build.mjs)
// worked fine and hid it.
const provenanceOnly = process.argv.includes("--provenance-only");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
}

if (provenanceOnly) {
  // staging already holds CI's cross-compiled sidecar; only make sure the dir
  // is there (idempotent — never wipes) so the writes below land.
  mkdirSync(resolve(HERE, "staging"), { recursive: true });
} else {
  console.log("==> building web UI");
  run("bun", ["run", "build"], resolve(REPO, "web"));

  console.log("==> compiling server sidecar");
  // Wipe staging first. electron-builder copies *everything* in here into the
  // app's resources (extraResources: { from: "staging", to: "." }), so anything
  // left behind ships — a stray build of the sidecar is 100MB, and six of them
  // once made it into an installed app before anyone noticed the size.
  rmSync(resolve(HERE, "staging"), { recursive: true, force: true });
  mkdirSync(resolve(HERE, "staging"), { recursive: true });
  run("bun", [
    "build", "--compile", resolve(REPO, "server/src/index.ts"),
    "--outfile", resolve(HERE, "staging/agentglass-server"),
  ]);
}

/*
 * The bundled tmux, when one has been built.
 *
 * The pane engine already looks for one beside the sidecar (`tmuxbin.ts`); this
 * is what puts it there, so "no tmux on this machine" stops being a thing the
 * terminal has to explain. Same rules as the Taskwarrior block below: optional,
 * so a build machine without one still makes a working app, and matched on the
 * exact target so it can never be the wrong architecture.
 */
const tmuxBuilt = resolve(REPO, "out", `tmux-${
  process.env.TASK_TARGET
  ?? `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`
}`);
if (existsSync(tmuxBuilt)) {
  const dest = resolve(HERE, "staging/tmux");
  copyFileSync(tmuxBuilt, dest);
  chmodSync(dest, 0o755);
  console.log("==> bundling tmux");
} else {
  console.log("==> no bundled tmux — the pane engine will use the system one");
}

/*
 * The bundled Taskwarrior, when one has been built.
 *
 * Local tasks are an agentglass feature, so a packaged app should carry its own
 * `task` rather than telling a fresh machine to go and install one — the same
 * argument the pane engine makes for its static tmux. `scripts/build-task-static.sh`
 * produces `out/task-<target>`; this only places it.
 *
 * Deliberately optional and deliberately quiet about it: a build machine that
 * has not produced one still makes a working app, because the server falls back
 * to whatever `task` is on PATH (see `taskBin`). What it must never do is ship a
 * binary for the WRONG architecture, so the target is matched exactly and a
 * generic `out/task` is not accepted.
 */
const taskTarget = process.env.TASK_TARGET
  ?? `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const taskBuilt = resolve(REPO, "out", `task-${taskTarget}`);
if (existsSync(taskBuilt)) {
  const dest = resolve(HERE, "staging/task");
  copyFileSync(taskBuilt, dest);
  chmodSync(dest, 0o755);
  console.log(`==> bundling taskwarrior (${taskTarget})`);
} else {
  console.log(`==> no bundled taskwarrior for ${taskTarget} — the app will use the system one`);
}

// Provenance, so the installed app knows what it was built from and can offer
// to update itself. Without it the server would have to guess where the source
// lives, and a wrong guess would build a stranger's repository.
const commit = git("rev-parse", "HEAD").stdout?.trim() ?? "";
// What this build IS, as opposed to what HEAD happened to be. See the block at
// the top of the file for why these are not the same thing.
const identity = treeIdentity(commit);
// Two manifests carry a version and only one of them is synced from the tag by
// CI (electron/package.json), so they drift: the v0.4.0 release shipped correct
// installers while every local and self-update build stamped 0.2.0 and the
// About pane reported it for weeks. Read both, take the higher, and say so when
// they disagree — a build that quietly reports the wrong version is how nobody
// notices the bump was half-done.
const readVersion = (p) => {
  try { return JSON.parse(readFileSync(p, "utf8")).version ?? ""; } catch { return ""; }
};
const rank = (v) => (v.match(/\d+/g) ?? []).map(Number).reduce((n, part) => n * 1000 + part, 0);
const shellVersion = readVersion(resolve(HERE, "package.json"));
const rootVersion = readVersion(resolve(REPO, "package.json"));
const manifestVersion = (rank(rootVersion) > rank(shellVersion) ? rootVersion : shellVersion) || "0.0.0";
if (shellVersion && rootVersion && shellVersion !== rootVersion) {
  console.warn(`warn: package.json versions disagree (root ${rootVersion}, electron ${shellVersion}) — using ${manifestVersion}`);
}
// The remote, so the updater can clone it without ever needing this checkout.
const origin = git("remote", "get-url", "origin").stdout?.trim() ?? "";
// `v0.2.1-48-g4a459f5`: the nearest release and the distance from it. This, not
// package.json, is what says whether a published tag is actually newer than
// this build — a version field nobody remembered to bump reads as older than a
// tag it is in fact 48 commits ahead of.
const described = git("describe", "--tags", "--long", "--always").stdout?.trim() ?? "";
const m = /^(v\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(described);
const baseTag = m ? m[1] : "";
const distance = m ? Number(m[2]) : 0;
// Let the tag win when the build is exactly on one. A self-update compiles from
// source on the user's machine with no CI in the path to sync the manifest, so
// after tagging v0.4.1 an "install & restart" would otherwise stamp the previous
// release. distance === 0 means this build IS the tagged release, whoever built
// it; distance > 0 is an in-between build (v0.4.0+4), where the manifest is the
// honest name. Retires the whole class of "manifest bump was half-done", making
// CI's sync step belt-and-braces rather than the only thing holding it up.
// A dirty tree is NOT the tagged release, whatever `describe` says: distance 0
// only means HEAD is on the tag. Letting the tag win there is how a build with
// somebody's uncommitted work in it gets to call itself v0.4.1.
const version = distance === 0 && baseTag && !identity.dirty ? baseTag.replace(/^v/, "") : manifestVersion;
writeFileSync(resolve(HERE, "staging/build-info.json"), JSON.stringify({
  version, commit, builtAt: new Date().toISOString(), source: REPO, origin, baseTag, distance,
  // The tree, not the commit: `stamp` is what gets shown, `tree` is what makes
  // two different trees impossible to confuse, and `dirtyFiles` is the answer
  // to "what did this build carry that nobody committed".
  stamp: identity.stamp, tree: identity.tree, dirty: identity.dirty,
  dirtyFiles: identity.dirtyFiles, dirtyOther: identity.dirtyOther,
}, null, 2));
// Shipped with the app rather than read from the source tree: the update must
// work on a machine where this checkout has been moved or deleted.
copyFileSync(resolve(HERE, "self-update.sh"), resolve(HERE, "staging/self-update.sh"));
console.log(`==> build-info: ${version} ${identity.stamp}${baseTag ? ` (${baseTag}+${distance})` : ""} from ${REPO}`);
if (!identity.tree) {
  // No git, so nothing here can be proved. Said plainly rather than dressed up
  // as a dirty-file list of length zero, which is what it looked like first.
  console.error(`\n!! UNVERIFIABLE: no git here, so this build cannot be tied to any commit or tree.\n`);
} else if (identity.dirty) {
  // Loud, itemised and on stderr: the whole point is that the person kicking
  // off an install can see, before it lands, which uncommitted files are about
  // to ship. That is the one thing that would have caught another session's
  // electron/main.js riding along into a build that could not draw a window.
  console.error(`\n!! NOT A COMMIT: ${identity.dirtyFiles.length} packaged file(s) differ from ${commit.slice(0, 7)}`);
  for (const f of identity.dirtyFiles.slice(0, 20)) console.error(`     ${f}`);
  if (identity.dirtyFiles.length > 20) console.error(`     … and ${identity.dirtyFiles.length - 20} more`);
  console.error(`   This build is ${identity.stamp}. Nothing you can check out reproduces it.\n`);
} else if (identity.dirtyOther) {
  console.log(`    (${identity.dirtyOther} uncommitted file(s) outside the package — not shipped)`);
}

console.log("==> staging ready");
