// Prepare the packaging inputs: a fresh web build and a standalone server
// sidecar, staged where electron-builder's extraResources expects them. Run by
// the `dist*` scripts before electron-builder so the app is always packaged
// from current source, never a stale dist.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

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

// Provenance, so the installed app knows what it was built from and can offer
// to update itself. Without it the server would have to guess where the source
// lives, and a wrong guess would build a stranger's repository.
const commit = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
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
const version = (rank(rootVersion) > rank(shellVersion) ? rootVersion : shellVersion) || "0.0.0";
if (shellVersion && rootVersion && shellVersion !== rootVersion) {
  console.warn(`warn: package.json versions disagree (root ${rootVersion}, electron ${shellVersion}) — using ${version}`);
}
// The remote, so the updater can clone it without ever needing this checkout.
const origin = spawnSync("git", ["-C", REPO, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout?.trim() ?? "";
// `v0.2.1-48-g4a459f5`: the nearest release and the distance from it. This, not
// package.json, is what says whether a published tag is actually newer than
// this build — a version field nobody remembered to bump reads as older than a
// tag it is in fact 48 commits ahead of.
const described = spawnSync("git", ["-C", REPO, "describe", "--tags", "--long", "--always"], { encoding: "utf8" }).stdout?.trim() ?? "";
const m = /^(v\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(described);
const baseTag = m ? m[1] : "";
const distance = m ? Number(m[2]) : 0;
writeFileSync(resolve(HERE, "staging/build-info.json"), JSON.stringify({
  version, commit, builtAt: new Date().toISOString(), source: REPO, origin, baseTag, distance,
}, null, 2));
// Shipped with the app rather than read from the source tree: the update must
// work on a machine where this checkout has been moved or deleted.
copyFileSync(resolve(HERE, "self-update.sh"), resolve(HERE, "staging/self-update.sh"));
console.log(`==> build-info: ${version} ${commit.slice(0, 7)}${baseTag ? ` (${baseTag}+${distance})` : ""} from ${REPO}`);

console.log("==> staging ready");
