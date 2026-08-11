// The tmux binary resolver's precedence and isolation.
//
// Nothing here runs tmux. The point is the ORDER: env override beats config
// beats bundled beats system PATH, and under `bun test` the developer's real
// state dir and execPath must never answer a test.
import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = {
  PATH: process.env.PATH,
  TMP: process.env.AGENTGLASS_TMUX_PATH,
  DIR: process.env.AGENTGLASS_TMUX_DIR,
  STATE: process.env.AGENTGLASS_STATE_DIR,
  XDG: process.env.XDG_CONFIG_HOME,
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
