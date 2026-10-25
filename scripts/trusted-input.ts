/*
 * Proves the acting verbs deliver input a page believes: the real verbs
 * (web/src/lib/browserDrive.ts, bundled) against a fixture whose handlers act
 * only on `event.isTrusted`, in an Electron window that is never shown, with
 * the shell's own input module (electron/trusted-input.js).
 *
 *   bun scripts/trusted-input.ts         every check green, or exit 1
 *   bun scripts/trusted-input.ts --off   the script path forced: must go red
 *
 * Not part of `bun test`: it needs Electron and a display to open the hidden
 * window on (`--ozone-platform=headless` crashes Electron 43 — see
 * scripts/agx-bench/instance.sh). The window is never shown.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const off = process.argv.includes("--off");
if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
  console.error("trusted-input: needs a display to open its hidden window on (none set)");
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "agx-trusted-"));
/* process.exit inside the try would skip the finally and leave `work` behind. */
let code = 1;
try {
  for (const f of ["fixture.html", "host.html", "host.js"]) cpSync(join(repo, "scripts/trusted-input", f), join(work, f));
  const built = await Bun.build({ entrypoints: [join(repo, "web/src/lib/browserDrive.ts")], target: "browser", format: "esm" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  await Bun.write(join(work, "drive.js"), built.outputs[0]);

  /* The binary itself, not the node wrapper in node_modules/.bin. A fresh
     worktree has the package without its download: AGX_ELECTRON points at one. */
  const electron = process.env.AGX_ELECTRON || join(repo, "electron/node_modules/electron/dist/electron");
  if (!existsSync(electron)) throw new Error(`no Electron binary at ${electron} — set AGX_ELECTRON`);
  const env: Record<string, string> = { ...process.env as Record<string, string>,
    XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data"), XDG_CACHE_HOME: join(work, "cache"),
    AGENTGLASS_STATE_DIR: join(work, "state"), AGENTGLASS_DB: join(work, "agx.db") };
  for (const k of ["TMUX", "AGENTGLASS_BIND", "AGENTGLASS_TRUST_LAN", "ELECTRON_RUN_AS_NODE"]) delete env[k];
  const platform = process.env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : [];
  const proc = Bun.spawn([electron, join(repo, "scripts/trusted-input/main.cjs"), ...platform, "--no-sandbox", `--dir=${work}`, ...(off ? ["--off"] : [])],
    { env, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const lines = stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { name: string; ok: boolean });
  for (const l of lines) console.log(`${l.ok ? "pass" : "FAIL"}  ${l.name}  ${l.ok ? "" : JSON.stringify(l)}`);
  const failed = lines.filter((l) => !l.ok).length;
  console.log(`trusted-input: ${lines.length - failed} pass, ${failed} fail${off ? " (script path forced)" : ""}`);
  code = failed || !lines.length ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
