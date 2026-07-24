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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
      // Every path it reports writing is inside agentglass's own dir.
      for (const p of r.wrote) expect(p.startsWith(ts.THEME_DIR)).toBe(true);
    }
    expect(readFileSync(userTmux, "utf8")).toBe(userTmuxBody);
    expect(readFileSync(userNvim, "utf8")).toBe(userNvimBody);
  });

  test("it does write its own theme files, under ~/.config/agentglass only", () => {
    const written = readdirSync(ts.THEME_DIR).sort();
    expect(written).toContain("theme.tmux.conf");
    expect(written).toContain("theme.lua");
    expect(ts.TMUX_THEME.startsWith(ts.THEME_DIR)).toBe(true);
    expect(ts.NVIM_THEME.startsWith(ts.THEME_DIR)).toBe(true);
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
