// A theme switch must never touch the user's own dotfiles (#238).
//
// A user reported (r/ClaudeAI, v0.5.0) that changing the dashboard theme
// overwrote their personal ~/.tmux.conf. Investigation found no code path,
// current or in v0.5.0, that writes the user's tmux or nvim config: syncTheme
// only ever writes agentglass's own ~/.config/agentglass/ files, the terminal
// opts in with a single `source` line the user pastes themselves, and
// snippetStatus is read-only. This test makes that guarantee permanent — a
// future change that pointed a write at a user dotfile would fail here.
//
// The reload spawns (tmux source-file / nvim :luafile) never write files, so the
// byte-for-byte assertions hold regardless; TMUX_TMPDIR and an empty
// XDG_RUNTIME_DIR keep them from perturbing a real tmux/nvim while tests run.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV0 = { ...process.env };
const home = mkdtempSync(join(tmpdir(), "agx-238-home-"));
const config = join(home, ".config");
const runtime = mkdtempSync(join(tmpdir(), "agx-238-run-"));
const tmuxTmp = mkdtempSync(join(tmpdir(), "agx-238-tmux-"));
mkdirSync(config, { recursive: true });

process.env.HOME = home;
process.env.XDG_CONFIG_HOME = config; // THEME_DIR resolves under here
process.env.XDG_RUNTIME_DIR = runtime; // empty → liveNvimSockets() finds nothing
process.env.TMUX_TMPDIR = tmuxTmp; // empty → tmux source-file finds no server
delete process.env.TMUX; // do not fall through to a real session's socket

// The user's own configs, with content nothing here should ever change.
const userTmux = join(home, ".tmux.conf");
const userTmuxBody = "set -g mouse on\nset -g prefix C-a\n# my personal config\n";
writeFileSync(userTmux, userTmuxBody);
const nvimDir = join(config, "nvim");
mkdirSync(nvimDir, { recursive: true });
const userNvim = join(nvimDir, "init.lua");
const userNvimBody = "vim.opt.number = true\n-- my personal config\n";
writeFileSync(userNvim, userNvimBody);

let ts: typeof import("../src/themesync.ts");

const palette = (bg: string, primary: string) => ({
  "--bg": bg, "--bg2": "#161b22", "--bg3": "#21262d",
  "--text": "#f0f6fc", "--text2": "#c9d1d9", "--text3": "#8b949e",
  "--border": "#30363d", "--primary": primary, "--primary-hover": "#c4b5fd",
  "--success": "#34d399", "--warning": "#fbbf24", "--error": "#f87171", "--info": "#60a5fa",
});

beforeAll(async () => {
  ts = await import("../src/themesync.ts");
});

afterAll(() => {
  for (const k of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMUX_TMPDIR", "TMUX"]) {
    if (ENV0[k] === undefined) delete process.env[k]; else process.env[k] = ENV0[k]!;
  }
});

describe("syncTheme never edits the user's own config", () => {
  test("switching themes many times leaves ~/.tmux.conf and nvim config byte-for-byte unchanged", async () => {
    for (const [bg, primary, name] of [
      ["#0d1117", "#a78bfa", "Forest"],
      ["#1a1333", "#c4b5fd", "Ember"],
      ["#ffffff", "#7c3aed", "Light"],
    ] as const) {
      const r = await ts.syncTheme(palette(bg, primary), name);
      expect(r.ok).toBe(true);
      // Nothing running is repainted from a test. Env isolation cannot deliver
      // this on its own: Bun.spawn gives the child the environment the process
      // started with, so TMUX_TMPDIR set at runtime never reaches tmux.
      expect(r.reloaded).toEqual([]);
      // Every path it reports writing is inside agentglass's own dir.
      for (const p of r.wrote) expect(p.startsWith(ts.themeDir())).toBe(true);
      // And inside the scratch home this file set up, never the real one.
      for (const p of r.wrote) expect(p.startsWith(home)).toBe(true);
    }
    expect(readFileSync(userTmux, "utf8")).toBe(userTmuxBody);
    expect(readFileSync(userNvim, "utf8")).toBe(userNvimBody);
  });

  test("it does write its own theme files, under ~/.config/agentglass only", () => {
    const written = readdirSync(ts.themeDir()).sort();
    expect(written).toContain("theme.tmux.conf");
    expect(written).toContain("theme.lua");
    expect(ts.tmuxThemePath().startsWith(ts.themeDir())).toBe(true);
    expect(ts.nvimThemePath().startsWith(ts.themeDir())).toBe(true);
  });

  /**
   * The leak this file was supposed to prevent, and did not.
   *
   * The paths used to be module constants, so the first import in the process
   * froze them. `security.test.ts` and `terminal-commands.test.ts` sort ahead of
   * this file and pull `themesync.ts` in through `terminal.ts`, which meant the
   * env redirected above arrived too late and the "Light" palette below was
   * written straight into the developer's own `~/.config/agentglass/`. Every
   * tmux server that sourced it afterwards painted its panes `#ffffff`. That is
   * what "the terminal went white on its own" was.
   *
   * Two things stop it now, and both are worth holding: the paths resolve per
   * call, and a write outside the scratch directory is refused outright while
   * NODE_ENV=test.
   */
  test("a test that forgot to redirect its home cannot write the real one", async () => {
    const saved = process.env.XDG_CONFIG_HOME;
    // Deliberately outside os.tmpdir(): this stands in for a real home. Reading
    // the actual one is not an option here, since by this point in a full suite
    // another file may already have moved HOME somewhere harmless.
    const notScratch = "/home/agx-not-a-scratch-dir";
    process.env.XDG_CONFIG_HOME = join(notScratch, ".config");
    try {
      expect(ts.themeDir().startsWith(notScratch)).toBe(true); // resolved live, not at import
      const r = await ts.syncTheme(palette("#ffffff", "#7c3aed"), "Light");
      expect(r.ok).toBe(false);
      expect(r.wrote).toEqual([]);
      expect(r.error).toContain("refusing to write");
      expect(existsSync(notScratch)).toBe(false); // and it created nothing on the way
    } finally {
      process.env.XDG_CONFIG_HOME = saved;
    }
  });

  test("no live tmux is repainted from a test, whatever the file says", () => {
    expect(ts.applyThemeTo([])).toBe(false);
  });

  test("snippetStatus reports opt-in state read-only, without editing anything", () => {
    // os.homedir() ignores $HOME on POSIX, so tmuxConfPath() resolves against the
    // real home — which is exactly why the guarantee matters: snippetStatus only
    // ever reads. It reports booleans and paths and touches nothing.
    const tmuxBefore = readFileSync(userTmux, "utf8");
    const nvimBefore = readFileSync(userNvim, "utf8");
    const s = ts.snippetStatus();
    expect(typeof s.tmux).toBe("boolean");
    expect(typeof s.nvim).toBe("boolean");
    expect(typeof s.tmuxPath).toBe("string");
    expect(readFileSync(userTmux, "utf8")).toBe(tmuxBefore);
    expect(readFileSync(userNvim, "utf8")).toBe(nvimBefore);
  });
});

// --- the status bar belongs to the user -------------------------------------

test("the theme colours the status bar without deciding what is in it", async () => {
  const { tmuxTheme, normalizeVars } = await import("../src/themesync.ts");
  const conf = tmuxTheme(normalizeVars({}), "Midnight Purple");
  // Styles: ours to set. They theme whatever the user has there.
  expect(conf).toContain("status-left-style");
  expect(conf).toContain("status-right-style");
  // Content: not ours. Setting it replaced whatever was already in those
  // segments, and people put working interpolations there — a git branch, a
  // battery, and in one real case `#(continuum_save.sh)`, which IS
  // tmux-continuum's entire save timer. Overwriting it silently turned off
  // session persistence and came back on every theme re-source.
  expect(conf).not.toMatch(/^set -g status-left "/m);
  expect(conf).not.toMatch(/^set -g status-right "/m);
});
