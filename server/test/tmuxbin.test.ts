// The tmux binary resolver's precedence and isolation.
//
// Nothing here runs tmux. The point is the ORDER: env override beats config
// beats bundled beats system PATH, and under `bun test` the developer's real
// state dir and execPath must never answer a test.
import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keyed by the REAL variable names: the restore below writes `process.env[k]`,
// so a nickname here would put back a variable nobody reads and leave the one
// the test changed set for every file after it in the same `bun test` process.
const ENV: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  AGENTGLASS_TMUX_PATH: process.env.AGENTGLASS_TMUX_PATH,
  AGENTGLASS_TMUX_DIR: process.env.AGENTGLASS_TMUX_DIR,
  AGENTGLASS_STATE_DIR: process.env.AGENTGLASS_STATE_DIR,
  AGENTGLASS_TMUX_SOCKET: process.env.AGENTGLASS_TMUX_SOCKET,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let mod: typeof import("../src/tmuxbin.ts");
beforeEach(async () => {
  mod = await import(`../src/tmuxbin.ts?u=${Math.random()}`);
});

function fakeTmux(dir: string, name = "tmux"): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

test("resolves nothing when env, config and PATH all lack tmux", () => {
  process.env.PATH = "/nonexistent";
  delete process.env.AGENTGLASS_TMUX_PATH;
  delete process.env.AGENTGLASS_TMUX_DIR;
  expect(mod.resolveTmuxBin()).toBeNull();
});

test("AGENTGLASS_TMUX_PATH wins over everything, even a bundled dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-tb-"));
  const env = fakeTmux(dir, "env-tmux");
  process.env.AGENTGLASS_TMUX_PATH = env;
  process.env.AGENTGLASS_TMUX_DIR = dir;
  process.env.PATH = "/nonexistent";
  expect(mod.resolveTmuxBin()).toBe(env);
});

test("a bundled dir is preferred over system PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-tb-"));
  const bundled = fakeTmux(dir, "tmux");
  process.env.AGENTGLASS_TMUX_DIR = dir;
  process.env.AGENTGLASS_TMUX_PATH = "";
  delete process.env.AGENTGLASS_TMUX_PATH;
  delete process.env.AGENTGLASS_STATE_DIR;
  expect(mod.resolveTmuxBin()).toBe(bundled);
});

test("falls back to system PATH when no bundled binary exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-tb-"));
  fakeTmux(dir, "other-bin"); // no `tmux` in the bundled dir
  process.env.AGENTGLASS_TMUX_DIR = dir;
  delete process.env.AGENTGLASS_TMUX_PATH;
  // system tmux (the developer's) is on PATH in this suite's environment
  const bin = mod.resolveTmuxBin();
  expect(bin).not.toBeNull();
  expect(existsSync(bin!)).toBe(true);
});

test("the real state dir never answers a test", () => {
  // Point the state dir at something real-shaped; the resolver must not look
  // inside it under `bun test` (tmuxbin.ts honours AGENTGLASS_STATE_DIR only
  // under scratch).
  const real = mkdtempSync(join(tmpdir(), "agx-tb-"));
  process.env.AGENTGLASS_STATE_DIR = real; // outside tmpdir? no — still scratch
  // With no env dir and no PATH tmux the answer must be null even though a
  // bundled binary would live under a REAL state dir in production.
  process.env.AGENTGLASS_TMUX_DIR = "";
  delete process.env.AGENTGLASS_TMUX_DIR;
  process.env.PATH = "/nonexistent";
  expect(mod.resolveTmuxBin()).toBeNull();
});

// A server already running on the engine's socket vetoes the priority list: a
// client tmux refuses to speak to is a dead terminal, not a lesser option.
// These run no tmux — `pickCompatible` takes the probe, and the integration
// test below fakes both binaries with shell scripts.

test("a bundled binary the running server refuses loses to the system one", () => {
  const speaks = (bin: string) => bin !== "/bundled/tmux";
  expect(mod.pickCompatible(["/bundled/tmux", "/usr/bin/tmux"], speaks)).toBe("/usr/bin/tmux");
});

test("the bundled binary still wins when it can speak to the server", () => {
  expect(mod.pickCompatible(["/bundled/tmux", "/usr/bin/tmux"], () => true)).toBe("/bundled/tmux");
});

test("nothing is picked when no candidate can speak to the server", () => {
  expect(mod.pickCompatible(["/bundled/tmux", "/usr/bin/tmux"], () => false)).toBeNull();
});

/** A fake tmux that answers `has-session` the way a mismatched client does. */
function mismatchedTmux(dir: string): string {
  const p = join(dir, "tmux");
  writeFileSync(p, "#!/bin/sh\necho 'server exited unexpectedly' >&2\nexit 1\n");
  chmodSync(p, 0o755);
  return p;
}

/** Socket file for a server that is "up", under a redirected TMUX_TMPDIR so no
 *  probe can ever reach the developer's real engine server. */
function fakeSocket(base: string, name: string): void {
  const dir = join(base, `tmux-${process.getuid!()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "");
}

test("with a server up, a bundled tmux that cannot talk to it hands over to PATH", () => {
  const bundledDir = mkdtempSync(join(tmpdir(), "agx-tb-b-"));
  const pathDir = mkdtempSync(join(tmpdir(), "agx-tb-p-"));
  const sockBase = mkdtempSync(join(tmpdir(), "agx-tb-s-"));
  mismatchedTmux(bundledDir);
  const system = fakeTmux(pathDir, "tmux"); // exits 0: it speaks
  process.env.AGENTGLASS_TMUX_DIR = bundledDir;
  process.env.PATH = pathDir;
  process.env.TMUX_TMPDIR = sockBase;
  process.env.AGENTGLASS_TMUX_SOCKET = "agx-test-sock";
  delete process.env.AGENTGLASS_TMUX_PATH;
  fakeSocket(sockBase, "agx-test-sock");
  expect(mod.resolveTmuxBin()).toBe(system);
});

test("with no server up, the bundled tmux is used without being probed", () => {
  const bundledDir = mkdtempSync(join(tmpdir(), "agx-tb-b-"));
  const pathDir = mkdtempSync(join(tmpdir(), "agx-tb-p-"));
  const sockBase = mkdtempSync(join(tmpdir(), "agx-tb-s-"));
  const bundled = mismatchedTmux(bundledDir); // would fail a probe; none is run
  fakeTmux(pathDir, "tmux");
  process.env.AGENTGLASS_TMUX_DIR = bundledDir;
  process.env.PATH = pathDir;
  process.env.TMUX_TMPDIR = sockBase; // no socket file inside it
  process.env.AGENTGLASS_TMUX_SOCKET = "agx-test-sock";
  delete process.env.AGENTGLASS_TMUX_PATH;
  expect(mod.resolveTmuxBin()).toBe(bundled);
});

test("status reports why the engine is off", () => {
  process.env.PATH = "/nonexistent";
  delete process.env.AGENTGLASS_TMUX_PATH;
  delete process.env.AGENTGLASS_TMUX_DIR;
  const st = mod.tmuxBinStatus();
  expect(st.available).toBe(false);
  expect(st.reason).toContain("not installed");
  expect(st.source).toBe("none");
});

test("a PATH override that is not executable is refused with its reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-tb-"));
  const p = join(dir, "tmux");
  writeFileSync(p, "#!/bin/sh\n"); // not chmod +x
  process.env.AGENTGLASS_TMUX_PATH = p;
  const st = mod.tmuxBinStatus();
  expect(st.available).toBe(false);
  expect(st.source).toBe("env");
  expect(st.reason).toContain("not executable");
});
