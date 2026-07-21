// Prepare the packaging inputs: a fresh web build and a standalone server
// sidecar, staged where electron-builder's extraResources expects them. Run by
// the `dist*` scripts before electron-builder so the app is always packaged
// from current source, never a stale dist.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
}

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

console.log("==> staging ready");
