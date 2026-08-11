// The config gate for the engine's tmux: generation, the override, and the
// validation that keeps a broken config from ever applying.
//
// The validation half runs the REAL tmux — the machine's own binary, against a
// scratch socket under a scratch TMUX_TMPDIR, exactly as chat-pane.test.ts
// does — so a suite needs tmux on PATH. The generation half is pure and runs
// everywhere.
import { test, expect, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-conf-test-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tmux-conf-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
// config.ts refuses to WRITE to a real config dir under test (writeTmuxSettings
// guard), so point it at scratch like terminal-disabled-config.test.ts does.
const REAL_XDG = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(tmpdir(), `agx-tmux-conf-home-${process.pid}`);

let conf: typeof import("../src/tmuxconf.ts");
let cfg: typeof import("../src/config.ts");

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  mkdirSync(process.env.XDG_CONFIG_HOME!, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  conf = await import("../src/tmuxconf.ts");
  cfg = await import("../src/config.ts");
});

afterAll(() => {
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.XDG_CONFIG_HOME!, { recursive: true, force: true }); } catch { /* never made */ }
});

test("the base config never mentions the user's tmux.conf and keeps the status bar off", () => {
  const content = conf.confContent();
  expect(content).toContain("set -g status off");
  expect(content).not.toContain("~/.tmux.conf");
});

test("append mode runs the override after the base and re-asserts status off last", () => {
  const content = conf.confContent();
  const statusOff = [...content.matchAll(/set -g status off/g)].length;
  expect(statusOff).toBeGreaterThanOrEqual(2); // base + the re-assertion
});

test("a valid override passes the gate", () => {
  const r = conf.validateConf(conf.confContent());
  expect(r.ok).toBe(true);
});

test("a config that turns the status bar on is rejected by the probe", () => {
  // tmux 3.6a silently swallows most junk in a config (unknown commands,
  // unknown options, unterminated quotes all exit 0), so the gate probes the
  // value the config actually applied: the bar must stay off.
  const r = conf.validateConf("set -g status on\n");
  expect(r.ok).toBe(false);
  expect(r.stderr).toContain("status bar");
});

test("an override cannot hand the bar back even in replace mode", () => {
  // The enforcement is structural: the generated config re-asserts status off
  // after whatever the user wrote, in both modes.
  const r = conf.applyTmuxConf("replace", "# my bare server\nset -g status on\n");
  expect(r.ok).toBe(true);
  expect(conf.confContent()).toMatch(/\nset -g status off\n$/);
});

test("applyTmuxConf accepts a good override and writes it", () => {
  const r = conf.applyTmuxConf("append", "# my customisation\nset -g prefix C-z\n");
  expect(r.ok).toBe(true);
  expect(r.appliedAtNextStart).toBe(true);
  expect(cfg.tmuxOverride()).toContain("C-z");
});

test("replace mode makes the override the whole config", () => {
  const r = conf.applyTmuxConf("replace", "# bare\nset -g default-terminal screen-256color\n");
  expect(r.ok).toBe(true);
  const content = conf.confContent();
  expect(content).toContain("screen-256color");
  expect(content).not.toContain("history-limit");
  expect(content).not.toContain("mouse");
});
