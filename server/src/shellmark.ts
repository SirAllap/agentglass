/**
 * Teach the panel's shell to say what it is doing.
 *
 * The cockpit has a real PTY, and it was the one place work happened that
 * produced no telemetry at all. Everything an agent does through Claude Code is
 * measured; everything it does in the shell was a wall of text you had to read
 * to find out which command failed, how long it took, or where it ran.
 *
 * The fix is the standard one — OSC 133, the shell-integration sequences iTerm2
 * introduced and every serious terminal now understands. The shell emits a
 * marker when it prints a prompt, another when a command starts, and another
 * when it finishes carrying the exit status. No output parsing, no prompt
 * scraping, no heuristics that break the moment somebody customises PS1.
 *
 * ## What this file will not do
 *
 * It does not touch the user's dotfiles. Ever. An app that edits `~/.zshrc` to
 * measure something has made a trade nobody offered it, and the failure mode —
 * a broken login shell on a machine you are not sitting at — is far worse than
 * the missing telemetry. Everything here is a temporary shim in a scratch
 * directory, sourced *after* the user's own configuration, thrown away when the
 * session ends.
 *
 * ## And it must never cost somebody their shell
 *
 * A terminal that refuses to open is not a terminal (see terminal.ts). So every
 * path here is failure-tolerant in the same direction: if the shim cannot be
 * written, if the shell is one we have no snippet for, if the snippet errors —
 * the shell opens anyway, unmarked, and the telemetry is simply absent. That is
 * the "degrade silently" the issue asks for, and it is why `install()` returns
 * null rather than throwing.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * The marker vocabulary, in one place.
 *
 * `A` prompt start · `B` command line start · `C` output start · `D;<code>`
 * command finished. `633;E;<cmd>` is the de-facto extension VS Code added for
 * the command *text*, which plain OSC 133 does not carry — without it the
 * record can say a command failed but not which one, and "which one" is the
 * question the issue opens with. Terminals that do not know 633 ignore it, the
 * same way they ignore any unrecognised OSC.
 */
export const OSC = {
  promptStart: "\\033]133;A\\007",
  commandStart: "\\033]133;B\\007",
  outputStart: "\\033]133;C\\007",
  /** `D;<exit>` — the only marker that carries a value the panel acts on. */
  commandEnd: (code: string) => `\\033]133;D;${code}\\007`,
} as const;

/** Set on the shell so a snippet can tell it is running under the cockpit —
 *  and so a user who sources our snippet twice does not install it twice. */
export const MARKER_ENV = "AGENTGLASS_SHELL_INTEGRATION";

/**
 * Off switch, because this is code injected into somebody's login shell.
 *
 * Anyone whose prompt this upsets needs a way out that does not involve
 * uninstalling the app, and it must be reachable without a working terminal —
 * which is exactly the state a bad interaction would leave them in.
 */
export const MARKERS_DISABLED =
  process.env.AGENTGLASS_SHELL_MARKERS === "0" || process.env.AGENTGLASS_SHELL_MARKERS === "off";

export type Family = "bash" | "zsh" | "fish";

/** Which snippet, if any, fits this shell binary. */
export function familyOf(shellPath: string): Family | null {
  const name = basename(shellPath || "").toLowerCase().replace(/\.exe$/, "");
  if (name === "bash" || name === "sh") return "bash";
  if (name === "zsh") return "zsh";
  if (name === "fish") return "fish";
  return null;
}

/*
 * ---------------------------------------------------------------------------
 * The snippets.
 *
 * Each one is written to be sourced after the user's own configuration and to
 * be a no-op if anything about it is unwelcome. Two rules run through all
 * three:
 *
 *  - *Chain, never replace.* bash's `PROMPT_COMMAND` and zsh's `precmd_functions`
 *    are shared slots. Assigning to them is how an integration eats somebody's
 *    prompt, their git status, their window title. Every hook here appends.
 *  - *Emit on stdout, not stderr.* These sequences have to reach the terminal
 *    in stream order with the output they bracket, and stderr is a separate
 *    pipe that the pump interleaves by arrival.
 */

/**
 * bash.
 *
 * `trap DEBUG` fires before each command, which is where the command text comes
 * from — `$BASH_COMMAND` — and `PROMPT_COMMAND` fires before each prompt, which
 * is where the exit status is still readable. The pair is what the two markers
 * need, and the ordering matters: `$?` must be captured on the first line of
 * the prompt hook, before anything else in it can clobber it.
 *
 * The DEBUG trap also fires for every command *inside* the prompt hook, which
 * is how a naive version records `_agx_precmd` as something the user ran. The
 * `_agx_*` name guard is what stops that, and it took driving a real shell to
 * find — see test/fixtures/shell-drive.ts.
 */
const BASH_SNIPPET = `
# agentglass shell integration (OSC 133). Sourced after your own config; edits
# nothing. Set AGENTGLASS_SHELL_MARKERS=0 to turn it off.
if [ -z "\${${MARKER_ENV}_ON:-}" ]; then
  ${MARKER_ENV}_ON=1
  _agx_running=0
  _agx_at_prompt=1
  _agx_preexec() {
    # Completion runs the trap too, and a tab press is not a command.
    [ -n "\${COMP_LINE:-}" ] && return
    # Everything PROMPT_COMMAND runs fires this trap as well — ours and, more
    # importantly, *theirs*. Without this the history shows a user's own
    # \`__git_ps1\` as something they typed, once per prompt, forever.
    if [ "\$_agx_at_prompt" = "1" ]; then
      case "\$PROMPT_COMMAND" in *"\$BASH_COMMAND"*) return ;; esac
      _agx_at_prompt=0
    fi
    # Only the first simple command of a line: \`a && b\` must not restart the
    # clock halfway through.
    [ "\$_agx_running" = "1" ] && return
    _agx_running=1
    # The line as typed, not \$BASH_COMMAND, which is the individual simple
    # command — so \`mkdir sub && cd sub\` would report itself as \`mkdir sub\`
    # while carrying the exit status of the whole line. One subshell per typed
    # line is the price, and it is the one bash-preexec pays too.
    local _agx_line
    _agx_line=\$(HISTTIMEFORMAT= history 1 2>/dev/null)
    _agx_line=\${_agx_line#"\${_agx_line%%[![:space:]]*}"}   # leading blanks
    _agx_line=\${_agx_line#*[0-9] }                          # the history number
    printf '\\033]633;E;%s\\007${OSC.outputStart}' "\${_agx_line:-\$BASH_COMMAND}"
  }
  _agx_precmd() {
    local _agx_status=\$?
    _agx_at_prompt=1
    [ "\$_agx_running" = "1" ] && printf '${OSC.commandEnd("%s")}' "\$_agx_status"
    _agx_running=0
    printf '${OSC.promptStart}\\033]7;file://%s%s\\007${OSC.commandStart}' "\${HOSTNAME:-}" "\$PWD"
    # Hand the status back untouched. Anything else in PROMPT_COMMAND — a git
    # prompt, a window title, an exit-code glyph — reads \$? and would see ours.
    return \$_agx_status
  }
  # FIRST in the chain, not appended. \$? belongs to the command that just
  # finished, and the user's own hook runs before ours would have read it: with
  # a PROMPT_COMMAND of theirs in place, every failure was recorded as a success.
  if [ -n "\${PROMPT_COMMAND:-}" ]; then
    PROMPT_COMMAND="_agx_precmd;\${PROMPT_COMMAND#;}"
  else
    PROMPT_COMMAND="_agx_precmd"
  fi
  # LAST, and that is load-bearing: a DEBUG trap fires for every command that
  # follows it, including the rest of this snippet. Installed any earlier and
  # the first thing the history shows is a line of our own setup code.
  trap '_agx_preexec' DEBUG
fi
`;

/**
 * zsh.
 *
 * `preexec` gets the command line as `$1` — better than bash's `$BASH_COMMAND`,
 * which is the expanded single command rather than what was typed. `precmd` has
 * `$?`. Both are appended to the standard hook *arrays*, which is zsh's own
 * mechanism for exactly this and cannot collide with anybody else's.
 */
const ZSH_SNIPPET = `
# agentglass shell integration (OSC 133). Sourced after your own config; edits
# nothing. Set AGENTGLASS_SHELL_MARKERS=0 to turn it off.
if [[ -z "\${${MARKER_ENV}_ON:-}" ]]; then
  ${MARKER_ENV}_ON=1
  _agx_running=0
  _agx_preexec() {
    _agx_running=1
    printf '\\033]633;E;%s\\007${OSC.outputStart}' "\$1"
  }
  _agx_precmd() {
    local _agx_status=\$?
    [[ "\$_agx_running" == "1" ]] && printf '${OSC.commandEnd("%s")}' "\$_agx_status"
    _agx_running=0
    printf '${OSC.promptStart}\\033]7;file://%s%s\\007${OSC.commandStart}' "\${HOST:-}" "\$PWD"
  }
  # zsh's own hook arrays — appending here cannot clobber anyone.
  autoload -Uz add-zsh-hook 2>/dev/null && {
    add-zsh-hook preexec _agx_preexec
    add-zsh-hook precmd _agx_precmd
  }
fi
`;

/**
 * fish.
 *
 * Events rather than hook variables, so there is nothing to chain and nothing
 * to clobber. `$status` has to be read on the first line of the prompt handler
 * for the same reason it does everywhere else.
 */
const FISH_SNIPPET = `
# agentglass shell integration (OSC 133). Runs after your own config; edits
# nothing. Set AGENTGLASS_SHELL_MARKERS=0 to turn it off.
if not set -q ${MARKER_ENV}_ON
  set -g ${MARKER_ENV}_ON 1
  set -g _agx_running 0
  function _agx_preexec --on-event fish_preexec
    set -g _agx_running 1
    printf '\\033]633;E;%s\\007${OSC.outputStart}' "\$argv[1]"
  end
  function _agx_precmd --on-event fish_prompt
    set -l _agx_status \$status
    if test "\$_agx_running" = "1"
      printf '${OSC.commandEnd("%s")}' "\$_agx_status"
    end
    set -g _agx_running 0
    printf '${OSC.promptStart}\\033]7;file://%s%s\\007${OSC.commandStart}' (hostname) "\$PWD"
  end
end
`;

export const SNIPPETS: Record<Family, string> = {
  bash: BASH_SNIPPET,
  zsh: ZSH_SNIPPET,
  fish: FISH_SNIPPET,
};

export interface Installed {
  family: Family;
  /** Replaces the argv the caller would otherwise have used. */
  argv: (shell: string) => string[];
  /** Merged over the spawn environment. */
  env: Record<string, string>;
  /** Remove the scratch directory. Safe to call twice. */
  dispose(): void;
}

/**
 * Wire a shell up, without touching anything of the user's.
 *
 * Each family gets there differently, and the differences are not cosmetic:
 *
 * **zsh** reads its startup files from `$ZDOTDIR`. Pointing that at a scratch
 * directory whose files source the real ones is the standard trick, works with
 * a login shell, and is what every other integration does.
 *
 * **fish** has `--init-command`, which runs after its own config. Nothing to
 * shim at all.
 *
 * **bash** is the awkward one. `--rcfile` is *ignored* for a login shell, and
 * the panel deliberately opens a login shell so the user gets their real PATH.
 * Reimplementing bash's login sequence in a shim means getting `/etc/profile`,
 * `~/.bash_profile`, `~/.bash_login` and `~/.profile` right in the correct
 * order with the correct first-match-wins rule, which is a lot of subtle
 * behaviour to owe somebody's shell. So instead: run the login shell for real,
 * and have it `exec` an interactive shell that reads our shim. The login files
 * run exactly as bash intends and export what they export; the inner shell
 * inherits all of it and picks up the markers.
 */
export function install(shellPath: string): Installed | null {
  if (MARKERS_DISABLED) return null;
  const family = familyOf(shellPath);
  if (!family) return null;

  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "agentglass-shell-"));
  } catch {
    // No scratch space is not an error worth failing a shell over.
    return null;
  }
  const dispose = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };
  const env: Record<string, string> = { [MARKER_ENV]: "1" };

  try {
    if (family === "zsh") {
      /*
       * Resolved by the shell, not by this process.
       *
       * `homedir()` here is the *server's* home, and the shell's may not be the
       * same one — a different HOME in the environment, a service account, a
       * container. Baking a path in at install time means shimming a file the
       * shell was never going to read, and the symptom is somebody's zsh coming
       * up bare with no error anywhere. So the shim asks `$HOME` at runtime.
       */
      const origExpr = `"\${AGENTGLASS_ZDOTDIR_ORIG:-$HOME}"`;
      // Every file zsh might read, each sourcing the real one first. Guarded
      // with `-f`, because `source` on a file that is not there is an error in
      // zsh and an error here lands in the user's face at every login.
      for (const f of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) {
        const lines = [
          `# agentglass: a shim, not your file. Yours is sourced below, unchanged.`,
          `export ZDOTDIR=${origExpr}`,
          `[ -f ${origExpr}/${f} ] && source ${origExpr}/${f}`,
        ];
        // The markers go in last, after everything of theirs has run — a
        // snippet installed before the user's config is one their config can
        // silently undo.
        if (f === ".zshrc") lines.push(ZSH_SNIPPET);
        writeFileSync(join(dir, f), lines.join("\n") + "\n");
      }
      if (process.env.ZDOTDIR) env.AGENTGLASS_ZDOTDIR_ORIG = process.env.ZDOTDIR;
      env.ZDOTDIR = dir;
      return { family, argv: (s) => [s, "-il"], env, dispose };
    }

    if (family === "fish") {
      // `-C` runs after fish's own configuration, which is exactly where this
      // belongs, and needs no files at all.
      dispose();
      return { family, argv: (s) => [s, "-il", "-C", FISH_SNIPPET], env, dispose: () => {} };
    }

    // bash: login shell for real, then exec an interactive one that reads the
    // shim. See the note above for why `--rcfile` alone cannot work here.
    const rc = join(dir, "agentglass.bash");
    writeFileSync(rc, [
      `# agentglass: a shim, not your file. Yours is sourced below, unchanged.`,
      // `$HOME` at runtime, not this process's home — see the note in the zsh
      // branch for why baking the path in is wrong.
      `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`,
      BASH_SNIPPET,
    ].join("\n") + "\n");
    return {
      family,
      argv: (s) => [s, "-lc", `exec ${shq(s)} --rcfile ${shq(rc)} -i`],
      env,
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}

/** Single-quote for a POSIX shell. The only quoting rule that needs no
 *  exceptions: everything is literal inside single quotes except the quote. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
