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

test("a rejected override leaves the one that was working in place", () => {
  /*
   * The revert used to read the settings back AFTER writing them, so it saved
   * the values it had just saved: a no-op wearing the shape of a rollback. The
   * rejected text stayed in config.json, came back in the settings box on the
   * next open, and was regenerated into the conf at the next start — which is
   * how a machine ended up with the engine off and the bad line still on screen.
   */
  const good = conf.applyTmuxConf("append", "# keep me\nset -g prefix C-z\n");
  expect(good.ok).toBe(true);

  /* What the gate can actually catch, measured on tmux 3.6a: nothing in a
     config makes it exit non-zero — an unknown option, an unterminated quote
     and `source-file` on a missing path all exit 0 — so the only real refusal
     is the probe, and `set -g status on` alone loses to the footer that
     re-asserts it off. A hook fires AFTER that footer, which is how a plugin
     would take the bar back, and is exactly the case worth refusing. */
  const bad = conf.applyTmuxConf("append", '# nope\nset-hook -g after-new-session "set -g status on"\n');
  expect(bad.ok).toBe(false);
  expect(bad.appliedAtNextStart).toBe(false);

  expect(cfg.tmuxOverride()).toContain("keep me");
  expect(cfg.tmuxOverride()).not.toContain("nope");
  expect(cfg.tmuxConfMode()).toBe("append");
  // And the generated file agrees with the settings rather than lagging them.
  expect(conf.confContent()).toContain("C-z");
});

test("a mark left by a config that has since been fixed does not keep the engine off", () => {
  /*
   * `confHealth` short-circuited on the flag, so once set it was permanent:
   * the panel read "Pane engine unavailable" while the conf on disk passed the
   * gate by hand. The file is the truth; the flag is a note about the file.
   */
  expect(conf.applyTmuxConf("append", "# fine\nset -g prefix C-z\n").ok).toBe(true);
  conf.ensureConf();
  cfg.setTmuxConfBroken(true, "something that is no longer true");
  conf.__resetTmuxConfState();

  const health = conf.confHealth();
  expect(health.ok).toBe(true);
  expect(cfg.tmuxConfBroken().broken).toBe(false);
});

test("a healthy engine is not reported as rejected on every read after the first", () => {
  /*
   * The check that was missing, and the bug it hid: `tmuxConfBroken()` returns
   * `{ broken, reason }` — an object, so always truthy — and both readers here
   * asked `if (tmuxConfBroken())`. Every config that had ever been written
   * therefore read as rejected. That is why a machine whose conf passed this
   * very gate by hand sat on "Pane engine unavailable", and why the engine's
   * socket never existed at all.
   *
   * The first call takes the validate path, which is why it has to be asked
   * twice: the second read is the one that consults the flag.
   */
  expect(conf.applyTmuxConf("append", "# healthy\nset -g prefix C-z\n").ok).toBe(true);
  conf.ensureConf();
  cfg.setTmuxConfBroken(false);
  conf.__resetTmuxConfState();

  expect(conf.confHealth().ok).toBe(true);
  expect(conf.confHealth().ok).toBe(true);
});

test("a config that really is broken still says so, in tmux's own words", () => {
  // The other direction of the same check: self-healing must not become
  // self-ignoring.
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(conf.confPath(), "set -g status on\n");
  conf.__resetTmuxConfState();
  const health = conf.confHealth();
  expect(health.ok).toBe(false);
  expect(health.reason).toContain("status bar");
  // Left marked, so the next reader does not pay for the check again.
  expect(cfg.tmuxConfBroken().broken).toBe(true);
  // Put the suite back where it found it.
  cfg.setTmuxConfBroken(false);
  conf.ensureConf();
  conf.__resetTmuxConfState();
});

test("the prefix is written as the three lines tmux needs, not one", () => {
  /*
   * `set -g prefix` alone leaves C-b bound, so both keys work and the change
   * reads as half-applied; `send-prefix` is what lets the new chord be typed
   * through to a program inside the pane. Three lines to move one keystroke is
   * exactly why this is a setting rather than a paragraph in the override box.
   */
  expect(cfg.writeTmuxSettings({ tmuxPrefix: "C-a" }).ok).toBe(true);
  const content = conf.confContent();
  expect(content).toContain("unbind C-b");
  expect(content).toContain("set -g prefix C-a");
  expect(content).toContain("bind C-a send-prefix");
  expect(conf.validateConf(content).ok).toBe(true);
});

test("choosing the default writes it out, rather than saying nothing", () => {
  /*
   * The bug this replaces: leaving the block out when the setting was empty.
   * A saved config is handed to the RUNNING server with `source-file`, which
   * can only add — so re-sourcing a file that no longer mentions the prefix did
   * not undo the `set -g prefix C-a` the previous one applied. Going back to
   * the default was the one direction that really needed a restart. Measured on
   * a live engine: no prefix on disk, server still on C-a.
   */
  expect(cfg.writeTmuxSettings({ tmuxPrefix: "" }).ok).toBe(true);
  const content = conf.confContent();
  expect(content).toContain("set -g prefix C-b");
  expect(content).toContain("bind C-b send-prefix");
  expect(conf.validateConf(content).ok).toBe(true);
});

test("only a key name can reach the config file", () => {
  /* The value is interpolated into a file tmux executes, so anything that
     could end that command and start another one is refused rather than
     escaped. The reader enforces it too, in case something else writes the
     file: a bad value on disk reads as "no prefix". */
  for (const bad of ["C-a; kill-server", "a b", "'C-a'", "$(id)", "C-a\nkill-server", ""]) {
    expect(cfg.validTmuxPrefix(bad), bad).toBe(false);
  }
  for (const good of ["C-a", "C-Space", "M-x", "F5", "C-M-a"]) {
    expect(cfg.validTmuxPrefix(good), good).toBe(true);
  }
  cfg.writeTmuxSettings({ tmuxPrefix: "C-a; kill-server" });
  expect(cfg.tmuxPrefix()).toBe("");
  // Not silence — the default, spelled out. A value the reader refuses lands
  // the config on C-b, which is a state, rather than on "whatever the running
  // server happens to have".
  expect(conf.confContent()).not.toContain("kill-server");
  expect(conf.confContent()).toContain("set -g prefix C-b");
  cfg.writeTmuxSettings({ tmuxPrefix: "" });
});

test("replace mode makes the override the whole config", () => {
  const r = conf.applyTmuxConf("replace", "# bare\nset -g default-terminal screen-256color\n");
  expect(r.ok).toBe(true);
  const content = conf.confContent();
  expect(content).toContain("screen-256color");
  expect(content).not.toContain("history-limit");
  expect(content).not.toContain("mouse");
});
