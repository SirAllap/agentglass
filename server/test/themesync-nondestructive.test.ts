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

  test("live reload targets the AgentGlass engine socket, never the default socket", () => {
    const saved = process.env.AGENTGLASS_TMUX_SOCKET;
    process.env.AGENTGLASS_TMUX_SOCKET = "agx-theme-test";
    try {
      expect(ts.themeTmuxTarget()).toEqual(["-L", "agx-theme-test"]);
    } finally {
      if (saved === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
      else process.env.AGENTGLASS_TMUX_SOCKET = saved;
    }
  });

  /*
   * #455, the route #564 did not close: `followSession` in terminal.ts calls
   * applyThemeTo on whatever socket the panel is following, which for the
   * ordinary `tmux attach` spellings is the user's own server — no pick, no
   * gesture, and after the sync boundary moved, a palette that is no longer
   * kept current for that socket. The engine's own socket stays automatic;
   * the user's server waits for the opt-in they write themselves.
   */
  describe("an unasked repaint stays inside the engine's socket", () => {
    const xdgTmux = join(config, "tmux", "tmux.conf");
    const withConf = (body: string | null, run: () => void) => {
      const saved = existsSync(xdgTmux) ? readFileSync(xdgTmux, "utf8") : null;
      try {
        if (body === null) { mkdirSync(join(config, "tmux"), { recursive: true }); writeFileSync(xdgTmux, "# nothing of ours\n"); }
        else { mkdirSync(join(config, "tmux"), { recursive: true }); writeFileSync(xdgTmux, body); }
        run();
      } finally {
        if (saved === null) writeFileSync(xdgTmux, "# nothing of ours\n"); else writeFileSync(xdgTmux, saved);
      }
    };

    test("the engine's own socket is repainted with no opt-in at all", () => {
      withConf(null, () => {
        expect(ts.themeEngineSocket(ts.themeTmuxTarget())).toBe(true);
        expect(ts.themeRepaintAllowed(ts.themeTmuxTarget())).toBe(true);
      });
    });

    test("the user's own server is not — a bare socket is exactly what terminal.ts passes", () => {
      withConf(null, () => {
        expect(ts.themeEngineSocket([])).toBe(false);
        expect(ts.themeRepaintAllowed([])).toBe(false);
        expect(ts.themeRepaintAllowed(["-L", "someone-elses"])).toBe(false);
      });
    });

    test("and is, once they have pasted the snippet into their own config", () => {
      withConf(`set -g mouse on\n${ts.SNIPPETS.tmux}\n`, () => {
        expect(ts.themeRepaintAllowed([])).toBe(true);
      });
    });
  });

  /*
   * The browser-side fence in web/src/lib/themes.ts reads navigator.webdriver,
   * which a plain CDP attach leaves false — measured on a Chrome launched the
   * way every script in scripts/ launches it. The User-Agent it sends is the
   * part it cannot keep to itself, and #455 asked for the refusal to live here,
   * on the server, beside the NODE_ENV=test one.
   */
  describe("an automated browser is refused server-side", () => {
    const HEADLESS = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";
    const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

    test("headless Chrome — the exact User-Agent our own harnesses send", () => {
      expect(ts.automatedThemeClient(HEADLESS)).toBe(true);
    });

    test("the other automation stacks that announce themselves", () => {
      for (const ua of ["Playwright/1.4", "python-selenium/4", "WebDriver", "PhantomJS/2.1", "puppeteer"]) {
        expect(ts.automatedThemeClient(ua)).toBe(true);
      }
    });

    test("a browser someone is sitting at is not refused", () => {
      expect(ts.automatedThemeClient(CHROME)).toBe(false);
      expect(ts.automatedThemeClient("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15")).toBe(false);
      // Absent is not automated: a phone or a CLI may send nothing, and the
      // route is already behind the token and the origin gate.
      expect(ts.automatedThemeClient(null)).toBe(false);
      expect(ts.automatedThemeClient("")).toBe(false);
    });
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
