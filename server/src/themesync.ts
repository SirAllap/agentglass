// Carry the cockpit's theme out to the terminal apps running inside it.
//
// The panel already themes xterm from the active palette, but the moment you
// start tmux or nvim in there you're looking at *their* colours, and the window
// stops reading as one thing. Two dozen surfaces agreeing on a palette and the
// two you spend the most time in disagreeing is worse than not theming at all.
//
// Deliberately NOT by owning anyone's config. agentglass writes two small files
// of its own and each config opts in with a single `source` line, which means:
//   * nothing of the user's is edited, moved or backed up-and-replaced;
//   * it works with any setup — LazyVim, kickstart, a hand-rolled init.lua —
//     rather than only the one we happened to bundle;
//   * uninstalling is deleting one line, not restoring a backup.
//
// A config manager would be a bigger feature and a much worse trade: replacing
// somebody's editor config is the most destructive thing this app could do, and
// it would put our update cycle in a fight with their local edits forever.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { liveNvimSockets } from "./editor.ts";

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
export const THEME_DIR = join(CONFIG_HOME, "agentglass");
export const NVIM_THEME = join(THEME_DIR, "theme.lua");
export const TMUX_THEME = join(THEME_DIR, "theme.tmux.conf");

/** The subset of the palette worth exporting. Everything here exists in every
 *  theme; anything theme-specific would break the ones that lack it. */
export interface ThemeVars {
  bg: string; bg2: string; bg3: string; bg4: string;
  text: string; text2: string; text3: string; text4: string;
  border: string; border2: string; primary: string; primaryHover: string;
  success: string; warning: string; error: string; info: string;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;
/** Reject anything that isn't a plain hex colour. These strings are written
 *  into files that a shell and a Lua interpreter will read, so the one rule
 *  that matters is that nothing arbitrary reaches them. */
function hex(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v.trim()) ? v.trim() : fallback;
}

/**
 * themeName is the only free-text value written into the generated files, and
 * both files are *executed* — the Lua module by nvim, the conf by tmux's parser.
 * It lands in a comment (`-- Theme: …` / `# Theme: …`), which looks harmless
 * until you notice the name arrives straight from the /theme/sync request body:
 * a newline in it ends the comment line and turns whatever follows into code the
 * interpreter runs (`\n:!rm -rf ~` in Lua, `\nrun-shell '…'` in tmux). So it
 * gets the same rule the colours already follow — reduce it to an inert label
 * (letters, digits, spaces, dash, underscore) so nothing arbitrary can reach an
 * interpreter — capped in length and with a neutral fallback when nothing is
 * left. Applied inside the generators, not just at the entry point, so the files
 * are safe no matter who calls them.
 */
function safeName(name: unknown): string {
  const s = (typeof name === "string" ? name : "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 64);
  return s || "custom";
}

export function normalizeVars(input: Record<string, unknown>): ThemeVars {
  const g = (k: string, f: string) => hex(input[k] ?? input[`--${k}`], f);
  return {
    bg: g("bg", "#0d1117"), bg2: g("bg2", "#161b22"), bg3: g("bg3", "#21262d"), bg4: g("bg4", "#30363d"),
    text: g("text", "#f0f6fc"), text2: g("text2", "#c9d1d9"), text3: g("text3", "#8b949e"), text4: g("text4", "#6e7681"),
    border: g("border", "#30363d"), border2: g("border2", "#3d444d"),
    primary: g("primary", "#a78bfa"), primaryHover: g("primary-hover", "#c4b5fd"),
    success: g("success", "#34d399"), warning: g("warning", "#fbbf24"),
    error: g("error", "#f87171"), info: g("info", "#60a5fa"),
  };
}

/**
 * A Lua table of colours, plus the highlight groups worth overriding.
 *
 * Not a colorscheme — deliberately. Replacing the user's scheme would throw
 * away all the language-aware highlighting they chose. This only repaints the
 * *chrome*: the backgrounds, the splits, the statusline, the float borders —
 * the parts that sit against agentglass's own panels and give the seam away.
 * Syntax stays entirely theirs.
 */
export function nvimTheme(v: ThemeVars, themeName: string): string {
  const hi = (group: string, spec: string) => `  hl("${group}", { ${spec} })`;
  /*
   * Syntax, derived from the palette.
   *
   * The first version repainted only the chrome and left syntax to the user's
   * colorscheme — which meant switching from Deep Sea to Rosewood moved the
   * background and nothing else. nvim read as "dark" or "light" rather than as
   * the theme, and the twenty-odd palettes the app ships were wasted on it.
   *
   * The mapping is by *role*, not by hue, so it holds for every theme: the
   * accent carries keywords (the thing you scan for), success carries strings
   * (large blocks, so the calm colour), warning carries literals, info carries
   * callables, and the text ramp carries everything structural. A theme with a
   * teal accent gets teal keywords; a rose one gets rose. No per-theme tables.
   *
   * The trade is real and worth stating: an eight-colour ramp is coarser than a
   * hand-tuned colorscheme with per-language rules. What you get back is a
   * window where the editor and the app are unmistakably the same product.
   */
  const groups: Array<[string, string]> = [
    // --- chrome ---
    ["Normal", `bg = "${v.bg}", fg = "${v.text2}"`],
    ["NormalNC", `bg = "${v.bg}", fg = "${v.text3}"`],
    ["NormalFloat", `bg = "${v.bg2}", fg = "${v.text2}"`],
    ["FloatBorder", `bg = "${v.bg2}", fg = "${v.border2}"`],
    ["FloatTitle", `bg = "${v.bg2}", fg = "${v.primary}", bold = true`],
    ["SignColumn", `bg = "${v.bg}"`],
    ["LineNr", `bg = "${v.bg}", fg = "${v.text4}"`],
    ["CursorLineNr", `bg = "${v.bg2}", fg = "${v.primary}", bold = true`],
    ["CursorLine", `bg = "${v.bg2}"`],
    ["ColorColumn", `bg = "${v.bg2}"`],
    ["VertSplit", `fg = "${v.border}", bg = "${v.bg}"`],
    ["WinSeparator", `fg = "${v.border}", bg = "${v.bg}"`],
    ["StatusLine", `bg = "${v.bg2}", fg = "${v.text2}"`],
    ["StatusLineNC", `bg = "${v.bg}", fg = "${v.text4}"`],
    ["Visual", `bg = "${v.bg3}"`],
    ["Search", `bg = "${v.primary}", fg = "${v.bg}"`],
    ["IncSearch", `bg = "${v.warning}", fg = "${v.bg}"`],
    ["MatchParen", `fg = "${v.primary}", bold = true`],
    ["Pmenu", `bg = "${v.bg2}", fg = "${v.text2}"`],
    ["PmenuSel", `bg = "${v.bg3}", fg = "${v.text}", bold = true`],
    ["PmenuSbar", `bg = "${v.bg2}"`],
    ["PmenuThumb", `bg = "${v.border2}"`],
    ["WinBar", `bg = "${v.bg}", fg = "${v.text3}"`],
    ["WinBarNC", `bg = "${v.bg}", fg = "${v.text4}"`],
    // --- the tab/buffer strip, which is what you see across the top ---
    // Transparent fill: it sits directly against the panel, and a slab of a
    // slightly-different grey there is the seam that gives the embed away.
    ["TabLineFill", `bg = "${v.bg}"`],
    ["TabLine", `bg = "${v.bg}", fg = "${v.text4}"`],
    ["TabLineSel", `bg = "${v.bg2}", fg = "${v.primary}", bold = true`],
    ["BufferLineFill", `bg = "${v.bg}"`],
    ["BufferLineBackground", `bg = "${v.bg}", fg = "${v.text4}"`],
    ["BufferLineBufferSelected", `bg = "${v.bg2}", fg = "${v.primary}", bold = true`],
    ["BufferLineBufferVisible", `bg = "${v.bg}", fg = "${v.text3}"`],
    ["BufferLineSeparator", `bg = "${v.bg}", fg = "${v.bg}"`],
    ["BufferLineIndicatorSelected", `bg = "${v.bg2}", fg = "${v.primary}"`],
    ["BufferLineModified", `bg = "${v.bg}", fg = "${v.warning}"`],
    ["BufferLineModifiedSelected", `bg = "${v.bg2}", fg = "${v.warning}"`],
    // --- syntax, by role ---
    ["Comment", `fg = "${v.text4}", italic = true`],
    ["Keyword", `fg = "${v.primary}"`],
    ["Statement", `fg = "${v.primary}"`],
    ["Conditional", `fg = "${v.primary}"`],
    ["Repeat", `fg = "${v.primary}"`],
    ["Operator", `fg = "${v.text3}"`],
    ["Delimiter", `fg = "${v.text3}"`],
    ["Identifier", `fg = "${v.text2}"`],
    ["Function", `fg = "${v.info}"`],
    ["String", `fg = "${v.success}"`],
    ["Character", `fg = "${v.success}"`],
    ["Number", `fg = "${v.warning}"`],
    ["Boolean", `fg = "${v.warning}"`],
    ["Constant", `fg = "${v.warning}"`],
    ["Type", `fg = "${v.primaryHover}"`],
    ["Structure", `fg = "${v.primaryHover}"`],
    ["PreProc", `fg = "${v.info}"`],
    ["Special", `fg = "${v.primaryHover}"`],
    ["Title", `fg = "${v.primary}", bold = true`],
    ["Todo", `fg = "${v.bg}", bg = "${v.warning}", bold = true`],
    ["Error", `fg = "${v.error}"`],
    // Treesitter links to the classic groups above, so these are the few that
    // carry meaning of their own.
    ["@variable", `fg = "${v.text2}"`],
    ["@variable.builtin", `fg = "${v.error}"`],
    ["@property", `fg = "${v.text2}"`],
    ["@parameter", `fg = "${v.text3}"`],
    ["@function.builtin", `fg = "${v.info}"`],
    ["@constructor", `fg = "${v.primaryHover}"`],
    ["@punctuation.bracket", `fg = "${v.text3}"`],
    ["@tag", `fg = "${v.primary}"`],
    ["@tag.attribute", `fg = "${v.info}"`],
    // --- diagnostics and diffs ---
    ["DiagnosticError", `fg = "${v.error}"`],
    ["DiagnosticWarn", `fg = "${v.warning}"`],
    ["DiagnosticInfo", `fg = "${v.info}"`],
    ["DiagnosticHint", `fg = "${v.primary}"`],
    ["DiffAdd", `fg = "${v.success}"`],
    ["DiffDelete", `fg = "${v.error}"`],
    ["DiffChange", `fg = "${v.warning}"`],
    ["DiffText", `fg = "${v.warning}", bold = true`],
    ["GitSignsAdd", `fg = "${v.success}"`],
    ["GitSignsChange", `fg = "${v.warning}"`],
    ["GitSignsDelete", `fg = "${v.error}"`],
  ];
  return `-- Generated by agentglass — do not edit.
-- Theme: ${safeName(themeName)}
--
-- Rewritten on every theme change in the cockpit and pushed straight into any
-- running nvim, so the editor wears the same palette as the app around it.
--
-- This DOES repaint syntax, by role: the accent carries keywords, success
-- carries strings, warning carries literals, info carries callables. That is
-- coarser than a hand-tuned colorscheme — the trade is a window that reads as
-- one product. Delete lua/plugins/agentglass-theme.lua to opt out.

local M = {}

M.colors = {
  bg = "${v.bg}", bg2 = "${v.bg2}", bg3 = "${v.bg3}", bg4 = "${v.bg4}",
  fg = "${v.text}", fg2 = "${v.text2}", fg3 = "${v.text3}", fg4 = "${v.text4}",
  border = "${v.border}", border2 = "${v.border2}",
  primary = "${v.primary}", primary_hover = "${v.primaryHover}",
  success = "${v.success}", warning = "${v.warning}", error = "${v.error}", info = "${v.info}",
}

function M.apply()
  local hl = function(g, o) vim.api.nvim_set_hl(0, g, o) end
${groups.map(([g, spec]) => hi(g, spec)).join("\n")}
end

-- lualine draws its own statusline and never reads the StatusLine highlight
-- group, so it has to be handed a theme in its own shape or it stays on
-- whatever its plugin config picked — which is exactly the pale bar that gives
-- the whole thing away.
--
-- The current config is read back and only options.theme is replaced, so the
-- sections, separators and extensions you configured are untouched.
function M.lualine()
  local ok, lualine = pcall(require, "lualine")
  if not ok then return end
  local c = M.colors
  local seg = { a = { bg = c.primary, fg = c.bg, gui = "bold" },
                b = { bg = c.bg3, fg = c.fg2 },
                c = { bg = c.bg, fg = c.fg3 } }
  local theme = {
    -- Each mode keeps lualine's convention of colouring only the leftmost
    -- block, so the mode stays scannable without repainting the whole bar.
    normal   = seg,
    insert   = { a = { bg = c.success, fg = c.bg, gui = "bold" }, b = seg.b, c = seg.c },
    visual   = { a = { bg = c.warning, fg = c.bg, gui = "bold" }, b = seg.b, c = seg.c },
    replace  = { a = { bg = c.error, fg = c.bg, gui = "bold" }, b = seg.b, c = seg.c },
    command  = { a = { bg = c.info, fg = c.bg, gui = "bold" }, b = seg.b, c = seg.c },
    terminal = { a = { bg = c.primary_hover, fg = c.bg, gui = "bold" }, b = seg.b, c = seg.c },
    inactive = { a = { bg = c.bg, fg = c.fg4 }, b = { bg = c.bg, fg = c.fg4 }, c = { bg = c.bg, fg = c.fg4 } },
  }
  local cfg = lualine.get_config()
  cfg.options = cfg.options or {}
  cfg.options.theme = theme
  -- Flush with the editor background, like the tab strip above it.
  cfg.options.section_separators = cfg.options.section_separators or { left = "", right = "" }
  pcall(lualine.setup, cfg)
end

-- Re-applied after any colorscheme load: a scheme set later in startup would
-- otherwise paint straight over this and the window would split in two again.
vim.api.nvim_create_autocmd("ColorScheme", { callback = function() M.apply(); M.lualine() end })
M.apply()
-- Applied on every plausible "plugins are ready" moment, because losing this
-- race is the difference between a themed statusline and a pale bar nobody can
-- explain. lualine is set up by the plugin manager *after* this file runs, so a
-- single deferred call gets overwritten; VeryLazy fires once everything has
-- loaded, and LazyLoad catches the case where lualine itself is lazy-loaded
-- later still. Re-running is cheap and idempotent — it only swaps one field.
-- Every BufferLine* group, not the handful worth naming.
--
-- bufferline defines dozens — one per devicon, per diagnostic severity, per
-- selected/visible/hidden state — and each carries its own background. Setting
-- only the few obvious ones leaves the rest on bufferline's default, which is
-- what draws that darker box around the filename inside an otherwise correct
-- tab. Rewriting the background of all of them is both complete and immune to
-- bufferline adding more.
function M.bufferline()
  local c = M.colors
  local ok, all = pcall(vim.api.nvim_get_hl, 0, {})
  if not ok then return end
  for name, def in pairs(all) do
    -- A linked group follows its target; forcing anything here would break the
    -- link and lose whatever it pointed at.
    if type(name) == "string" and not def.link then
      if name:find("^BufferLine") then
        local bg = name:find("Selected") and c.bg2 or c.bg
        pcall(vim.api.nvim_set_hl, 0, name, vim.tbl_extend("force", def, { bg = bg }))
      elseif name:find("^DevIcon") and def.bg then
        -- nvim-web-devicons ships a background on its icon groups, and
        -- bufferline draws the icon with them directly — which is the dark box
        -- left around the icon after every BufferLine* group is correct.
        --
        -- Cleared rather than repainted: these same groups render in the file
        -- explorer, the picker and the statusline, each with a different
        -- background behind them. With no background of their own the icon
        -- inherits whatever it is drawn on, which is right everywhere instead
        -- of right in one place.
        local next_def = vim.tbl_extend("force", def, {})
        next_def.bg = nil
        pcall(vim.api.nvim_set_hl, 0, name, next_def)
      end
    end
  end
end

local function refresh()
  -- Both, not just lualine: bufferline sets its own highlight groups when it
  -- loads and paints straight over the tab strip, which is where that dark
  -- slab behind the active buffer comes from.
  M.apply()
  -- After apply(), so the sweep sees the groups it just set as well as
  -- bufferline's own.
  M.bufferline()
  M.lualine()
end

vim.schedule(refresh)
vim.api.nvim_create_autocmd("User", { pattern = "VeryLazy", callback = function() vim.schedule(refresh) end })

-- A few retries over the first couple of seconds.
--
-- Not elegant, and chosen deliberately over guessing harder. Every plugin that
-- draws chrome decides for itself when to set its highlights — on setup, on
-- VeryLazy, on its own lazy-load, on the first redraw — and each guess about
-- *which* moment to hook only fixed the plugin it was guessed for while the
-- next one still lost the race on a cold start. Re-applying a handful of times
-- while startup settles wins regardless of ordering, and each pass is one table
-- swap plus a sweep of the highlight table: microseconds, a few times, once per
-- session. The autocmds above still carry everything after that.
for _, ms in ipairs({ 100, 300, 800, 2000 }) do
  vim.defer_fn(refresh, ms)
end

-- bufferline builds its devicon groups lazily — the first time a buffer of that
-- filetype is shown — so a sweep that ran at startup never saw them, and the
-- icon kept its own dark background inside an otherwise correct tab.
-- Re-sweeping when buffers appear catches them; debounced to one pass per tick
-- because opening a session restores a dozen buffers at once and the sweep
-- walks every highlight group.
local pending = false
vim.api.nvim_create_autocmd({ "BufWinEnter", "FileType" }, {
  callback = function()
    if pending then return end
    pending = true
    vim.schedule(function() pending = false; M.bufferline() end)
  end,
})
vim.api.nvim_create_autocmd("User", {
  pattern = "LazyLoad",
  callback = function(ev)
    -- Any of the plugins that own chrome. Re-running is one table swap and a
    -- handful of nvim_set_hl calls, so being generous here costs nothing.
    local d = tostring(ev.data or "")
    if d:match("lualine") or d:match("bufferline") or d:match("barbar") or d:match("heirline") then
      vim.schedule(refresh)
    end
  end,
})

return M
`;
}

/**
 * tmux's chrome, in the app's palette.
 *
 * The status bar is the one element that sits flush against agentglass's own
 * panel, so it gets the *page* background rather than a panel-coloured slab —
 * a bar in a slightly different grey is exactly the seam that gives away that
 * the terminal is embedded in something else. The active window is picked out
 * with the accent instead, which is both prettier and more useful.
 */
export function tmuxTheme(v: ThemeVars, themeName: string): string {
  return `# Generated by agentglass — do not edit.
# Theme: ${safeName(themeName)}
#
# Rewritten on every theme change in the cockpit and sourced live, so this is
# only about surviving a restart:
#   source-file -q ~/.config/agentglass/theme.tmux.conf

# Flush with the terminal background — no bar-shaped slab across the bottom.
set -g status-style "bg=${v.bg},fg=${v.text3}"
set -g status-left-style "bg=${v.bg},fg=${v.primary},bold"
set -g status-right-style "bg=${v.bg},fg=${v.text4}"

# The current window is the only thing that needs to stand out, so it carries
# the accent and everything else recedes.
setw -g window-status-style "bg=${v.bg},fg=${v.text4}"
setw -g window-status-current-style "bg=${v.bg2},fg=${v.primary},bold"
setw -g window-status-activity-style "bg=${v.bg},fg=${v.warning}"
setw -g window-status-bell-style "bg=${v.bg},fg=${v.error},bold"
setw -g window-status-separator ""

# The window list, shaped like the app's own tabs: a dim index, the name, and
# the active one lifted onto a panel-coloured pill with the accent. Padding
# rather than powerline glyphs — those need a patched font, and a status bar
# that renders as question marks on someone else's machine is worse than a
# plain one that always works.
setw -g window-status-format " #[fg=${v.text4}]#I #[fg=${v.text3}]#W "
setw -g window-status-current-format " #[fg=${v.primary},bold]#I #[fg=${v.text}]#W "

# Left: the session, as the app renders the open project.
set -g status-left " #[fg=${v.primary},bold]#S #[fg=${v.border2}]│"
set -g status-left-length 30

# Right: kept quiet. The cockpit already shows the clock, the branch and the
# plan meters, and repeating them here is noise competing with itself.
set -g status-right "#[fg=${v.text4}]#{?client_prefix,#[fg=${v.warning}]^b ,}%H:%M "
set -g status-right-length 40
set -g status-justify left

# Borders: the inactive one a hairline against the panel, the active one the
# only thing saying where your keystrokes are going.
set -g pane-border-style "fg=${v.border}"
set -g pane-active-border-style "fg=${v.primary}"
set -g pane-border-lines single

set -g message-style "bg=${v.bg3},fg=${v.text}"
set -g message-command-style "bg=${v.bg3},fg=${v.text}"
set -g mode-style "bg=${v.bg3},fg=${v.text}"

set -g display-panes-colour "${v.text4}"
set -g display-panes-active-colour "${v.primary}"
set -g clock-mode-colour "${v.primary}"

# The pane background, so anything a program hasn't drawn to matches the panel
# behind it instead of falling back to the terminal default.
set -g window-style "bg=${v.bg}"
set -g window-active-style "bg=${v.bg}"

# Copy-mode selection, in the same accent the app uses for selection.
setw -g copy-mode-match-style "bg=${v.bg3},fg=${v.warning}"
setw -g copy-mode-current-match-style "bg=${v.primary},fg=${v.bg}"
`;
}

export type SyncResult = { ok: boolean; wrote: string[]; reloaded: string[]; error?: string };

/**
 * Write both files and nudge whatever is running to pick them up.
 *
 * Reload is best-effort by design: the files are the contract, and a tmux or
 * nvim that isn't running (or refuses) just picks them up next time it starts.
 * A failure here must never make the theme switch itself look broken.
 */
export async function syncTheme(vars: Record<string, unknown>, themeName: string): Promise<SyncResult> {
  const v = normalizeVars(vars);
  const wrote: string[] = [];
  const reloaded: string[] = [];
  try {
    mkdirSync(THEME_DIR, { recursive: true });
    writeFileSync(NVIM_THEME, nvimTheme(v, themeName));
    wrote.push(NVIM_THEME);
    writeFileSync(TMUX_THEME, tmuxTheme(v, themeName));
    wrote.push(TMUX_THEME);
  } catch (e) {
    return { ok: false, wrote, reloaded, error: String(e) };
  }

  // tmux: cheap and safe — sourcing a file it already sources is a no-op if
  // nothing changed, and there is no session to disturb if it isn't running.
  try {
    const p = Bun.spawn(["tmux", "source-file", TMUX_THEME], { stdout: "ignore", stderr: "ignore" });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 2000);
    if ((await p.exited) === 0) reloaded.push("tmux");
    clearTimeout(t);
  } catch { /* no tmux on PATH, or no server running */ }

  /*
   * nvim: pushed straight into every running instance.
   *
   * This is what makes the feature work with *any* config and no setup at all.
   * The `dofile` line below is only about persistence — surviving a restart —
   * whereas this repaints editors that have never heard of agentglass, right
   * now. `luafile` because the generated file is a module that applies itself
   * and registers its own ColorScheme autocmd.
   */
  try {
    const socks = await liveNvimSockets();
    const keys = `<C-\\><C-N>:luafile ${NVIM_THEME}<CR>`;
    const done = await Promise.all(socks.map(async (sock) => {
      try {
        const p = Bun.spawn(["nvim", "--server", sock, "--remote-send", keys], { stdout: "ignore", stderr: "ignore" });
        const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
        await p.exited;
        clearTimeout(t);
        return true;
      } catch { return false; }
    }));
    const n = done.filter(Boolean).length;
    if (n) reloaded.push(`nvim×${n}`);
  } catch { /* no nvim, or none reachable — the file is still there for next launch */ }

  return { ok: true, wrote, reloaded };
}

/** The one line each config needs, so the UI can show exactly what to paste
 *  rather than describing it. */
export const SNIPPETS = {
  nvim: `return dofile(vim.fn.expand("~/.config/agentglass/theme.lua"))`,
  tmux: `source-file -q ~/.config/agentglass/theme.tmux.conf`,
};

/**
 * Where this machine's tmux config actually lives.
 *
 * tmux reads `~/.tmux.conf` *and* `$XDG_CONFIG_HOME/tmux/tmux.conf`, and the
 * second one is where a config written this decade tends to be. Looking only at
 * the first told anyone on the XDG path that they had not added the snippet
 * when they had, and offered to have them paste it into a file they do not
 * keep — so the theme quietly stopped applying every time their tmux server
 * restarted, which for anyone running tmux-continuum is every reboot.
 *
 * The one that exists wins; the XDG one wins if both do, because that is the
 * one being maintained. With neither, `~/.tmux.conf` is the answer, since tmux
 * reads it and it is the path every tmux answer on the internet names.
 */
export function tmuxConfPath(): string {
  const xdg = join(CONFIG_HOME, "tmux", "tmux.conf");
  const dot = join(homedir(), ".tmux.conf");
  if (existsSync(xdg)) return xdg;
  return existsSync(dot) ? dot : xdg;
}

/**
 * Push the generated theme into one specific tmux server.
 *
 * `syncTheme` already does this on the default socket when the palette changes,
 * which covers "the user picked a new theme". It does not cover the other
 * direction: a tmux *server* that started after the last sync — a reboot, a
 * `kill-server`, or a tmux-continuum restore — comes up with none of it, and
 * everything the panel does not draw itself (the message row, the prompt, the
 * pane borders) falls back to whatever tmux ships with. That is a black bar in
 * the middle of a themed panel, and nothing in the app explains why.
 *
 * Sourcing our own generated file is the same act the theme switch already
 * performs, at the moment it is actually needed, and `-q` makes it silent when
 * the file is not there yet.
 */
export function applyThemeTo(socket: string[]): boolean {
  if (!existsSync(TMUX_THEME)) return false;
  try {
    const p = Bun.spawnSync(["tmux", ...socket, "source-file", "-q", TMUX_THEME], {
      stdout: "ignore", stderr: "ignore", timeout: 2000,
    });
    return p.exitCode === 0;
  } catch { return false; }
}

/** Has the user already opted in? Read-only — this never edits their files. */
export function snippetStatus(): { nvim: boolean; tmux: boolean; nvimPath: string; tmuxPath: string } {
  const nvimPath = join(CONFIG_HOME, "nvim", "lua", "plugins", "theme.lua");
  const tmuxPath = tmuxConfPath();
  const has = (p: string, needle: string) => {
    try { return existsSync(p) && readFileSync(p, "utf8").includes(needle); } catch { return false; }
  };
  return {
    nvim: has(nvimPath, "agentglass/theme.lua"),
    tmux: has(tmuxPath, "agentglass/theme.tmux.conf"),
    nvimPath, tmuxPath,
  };
}

export { dirname };
