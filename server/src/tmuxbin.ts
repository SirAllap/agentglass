// Where the pane engine's tmux binary comes from.
//
// The pane engine (tmuxpane.ts) runs its own tmux server on its own socket with
// its own config, so the binary that runs it is an implementation detail — and
// that is exactly why it is worth resolving in one place. Priority:
//
//   1. AGENTGLASS_TMUX_PATH (environment) — a one-off escape hatch;
//   2. `tmuxPath` in config.json when `tmuxSource` is "custom" — set from the
//      settings panel, persisted for a desktop launcher that inherits no env;
//   3. the bundled static tmux that ships with the packaged app, or one a
//      headless install fetched into its state dir;
//   4. whatever is on PATH.
//
// "System" is chosen from the settings panel by setting `tmuxSource` to
// "system"; it is also the automatic fallback when nothing bundled exists,
// which is the whole dev-machine story. The mirror path in tmuxctl.ts — where
// the app follows a tmux the USER started — is deliberately NOT resolved here:
// that path must always use the user's own tmux, because it is their server.
//
// The user's own ~/.tmux.conf is never involved in any of this: the conf the
// engine runs is agentglass's own (see tmuxconf.ts), whatever binary wins.
import { existsSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { tmuxSource, tmuxPathSetting } from "./config.ts";

/** Override that beats everything: AGENTGLASS_TMUX_PATH=/usr/bin/tmux. */
const ENV_OVERRIDE = "AGENTGLASS_TMUX_PATH";
/** Where a packaged app or headless install keeps its bundled binary. Set by a
 *  launcher that knows better than the guesses below; checked first. */
const BUNDLED_DIR_ENV = "AGENTGLASS_TMUX_DIR";

const IS_TEST = process.env.NODE_ENV === "test";
const underScratch = (p: string): boolean => p.startsWith(tmpdir());

/** Directories a bundled tmux might live in, most explicit first.
 *
 *  `process.execPath` is the compiled sidecar under a packaged desktop app; the
 *  static tmux ships next to it via electron-builder's extraResources. A
 *  headless install fetches into its state dir (see the download path in
 *  index.ts). Under test only env-provided dirs are honoured — the real state
 *  dir and the developer's execPath must never answer a test. */
function bundledDirs(): string[] {
  const dirs: string[] = [];
  const asked = process.env[BUNDLED_DIR_ENV];
  if (asked) dirs.push(asked);
  if (!IS_TEST) {
    try { dirs.push(dirname(process.execPath)); } catch { /* no execPath */ }
    const state = process.env.AGENTGLASS_STATE_DIR;
    if (state && (!IS_TEST || underScratch(state))) dirs.push(join(state, "tmux"));
  }
  return dirs;
}

/** Is `p` a regular file the current user can execute? */
function usable(p: string): boolean {
  if (!p || p.includes("\0")) return false;
  try {
    if (!existsSync(p)) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: { key: string; bin: string | null } | null = null;
/** The pane engine's tmux binary, or null when nothing usable exists.
 *
 *  Cached per (env override, config source/path, bundled dirs, PATH) tuple so
 *  the app pays one filesystem walk per configuration, not one per tmux call —
 *  a chat turn makes several. The tuple makes `bun test` safe: a suite that
 *  redirects AGENTGLASS_TMUX_PATH between tests still gets each answer fresh.
 *
 *  PATH is snapshotted the way tmuxctl.ts documents: `Bun.which()` answers
 *  about the environment this process started in, so it is handed the PATH we
 *  mean rather than let to guess.
 */
export function resolveTmuxBin(): string | null {
  const source = tmuxSource();
  const pathSetting = source === "custom" ? tmuxPathSetting() : "";
  const key = [process.env[ENV_OVERRIDE] ?? "", source, pathSetting, bundledDirs().join(","), process.env.PATH ?? ""].join("|");
  if (cached && cached.key === key) return cached.bin;

  let bin: string | null = null;
  const envPath = process.env[ENV_OVERRIDE];
  if (envPath && usable(envPath)) {
    bin = envPath;
  } else if (source === "custom" && pathSetting && usable(pathSetting)) {
    bin = pathSetting;
  } else if (source !== "system") {
    // Bundled first, then system PATH — the fallback that makes dev machines
    // and old installs work without shipping anything.
    for (const dir of bundledDirs()) {
      const candidate = join(dir, "tmux");
      if (usable(candidate)) { bin = candidate; break; }
    }
  }
  if (!bin) bin = Bun.which("tmux", { PATH: process.env.PATH ?? "" }) ?? null;
  cached = { key, bin };
  return bin;
}

/** The binary the pane engine would use, described for the settings panel.
 *
 *  `source` is *why* this binary won — useful when a config option looks like
 *  it did nothing (AGENTGLASS_TMUX_PATH beat it, say). */
export interface TmuxBinStatus {
  available: boolean;
  source: "env" | "custom" | "bundled" | "system" | "none";
  /** Absolute path of the winning binary, when there is one. */
  path: string;
  /** `tmux 3.5a`-style version string, or null if it could not be asked. */
  version: string | null;
  reason: string;
}

let versionCache: { bin: string; version: string | null } | null = null;
/** `tmux -V` of a specific binary. One shell-out per binary per process. */
export function tmuxVersion(bin: string): string | null {
  if (versionCache && versionCache.bin === bin) return versionCache.version;
  let version: string | null = null;
  try {
    const r = Bun.spawnSync([bin, "-V"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) version = r.stdout.toString().trim() || null;
  } catch { /* unaskable binary */ }
  versionCache = { bin, version };
  return version;
}

/** Full status for the settings panel and the degraded-reason paths. */
export function tmuxBinStatus(): TmuxBinStatus {
  if (process.platform === "win32") {
    return { available: false, source: "none", path: "", version: null, reason: "tmux chat panes need a Unix shell — not available on Windows" };
  }
  const envPath = process.env[ENV_OVERRIDE];
  if (envPath && !usable(envPath)) {
    return { available: false, source: "env", path: envPath, version: null, reason: `AGENTGLASS_TMUX_PATH is set to ${envPath}, which is not executable` };
  }
  const bin = resolveTmuxBin();
  if (!bin) {
    return { available: false, source: "none", path: "", version: null, reason: "tmux is not installed — install it, or use the bundled binary" };
  }
  const source = envPath && usable(envPath)
    ? "env"
    : tmuxSource() === "custom" ? "custom"
    : bundledDirs().some((d) => bin === join(d, "tmux")) ? "bundled"
    : "system";
  return { available: true, source, path: bin, version: tmuxVersion(bin), reason: "" };
}

/** Test seam: forget the caches so a suite that redirects env gets fresh
 *  answers, without touching any real tmux. */
export function __resetTmuxBinCache(): void {
  cached = null;
  versionCache = null;
}

/** The state dir the bundled/downloaded binary and restore data live in.
 *
 *  Kept here next to the resolver: same dir, same isolation rule. Under test,
 *  only a scratch dir may be used (the real one holds a downloaded binary and
 *  restore captures that must never be read or clobbered by a suite). */
export function tmuxStateDir(): string {
  const asked = process.env.AGENTGLASS_STATE_DIR;
  if (asked && (!IS_TEST || underScratch(asked))) return join(asked, "tmux");
  if (!IS_TEST) return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass", "tmux");
  return join(tmpdir(), "agentglass-test-state", "tmux");
}
