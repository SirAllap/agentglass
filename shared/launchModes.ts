/**
 * The permission mode a terminal agentglass opens starts its agent in, and the
 * tools it may never use there.
 *
 * Shared because the server builds the command line and the web shows the same
 * four names in Settings, in a prompt's editor and in the Review menu; two
 * copies of this list is how a mode would exist on one side only.
 *
 * `default` is Claude Code's own "ask before every tool". It is what a new
 * install starts with: skipping prompts is something a person turns on.
 */
export const LAUNCH_MODES = ["default", "auto", "acceptEdits", "bypassPermissions"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export const LAUNCH_MODE_LABEL: Record<LaunchMode, string> = {
  default: "Ask",
  auto: "Auto",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass",
};

/** The quiet badge next to an item that does not follow the global mode. */
export const LAUNCH_MODE_BADGE: Record<LaunchMode, string> = {
  default: "ask",
  auto: "auto",
  acceptEdits: "edits",
  bypassPermissions: "bypass",
};

export const isLaunchMode = (v: unknown): v is LaunchMode =>
  typeof v === "string" && (LAUNCH_MODES as readonly string[]).includes(v);

/** What a fresh install denies everywhere: merging and releasing stay a person's. */
export const DEFAULT_LAUNCH_DENY: readonly string[] = ["Bash(gh pr merge:*)", "Bash(gh release:*)"];

/**
 * One deny rule: a tool name, optionally with a pattern in parentheses —
 * `Edit`, `Bash(gh pr merge:*)`, `mcp__orbit__deploy`.
 *
 * The pattern may not hold a quote, a backtick, `$`, a backslash or another
 * parenthesis. Every launch passes the list as one argv element, never through
 * a shell, but a saved Command types its line into one, and a rule that cannot
 * contain shell syntax cannot become any there either.
 */
const DENY_RULE = /^[A-Za-z][A-Za-z0-9_-]{0,99}(\([^()'"`$\\\n]{1,200}\))?$/;
export const DENY_MAX = 50;

/** One rule per line; blank lines dropped; what does not parse comes back in `bad`. */
export function parseDenyRules(text: string): { rules: string[]; bad: string[] } {
  const rules: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (DENY_RULE.test(line)) { if (!rules.includes(line)) rules.push(line); }
    else bad.push(line);
  }
  if (rules.length > DENY_MAX) bad.push(`more than ${DENY_MAX} rules`);
  return { rules: rules.slice(0, DENY_MAX), bad };
}

/** What `GET /launch-permissions` answers. */
export interface LaunchPermissions { mode: LaunchMode; deny: string[] }

/**
 * One mode's flags for one CLI, as a person types them: a line of words.
 *
 * They go to the CLI as argv, never through a shell, but a saved Command types
 * its line into one, so a word may hold none of the characters a shell reads:
 * letters, digits and `_ - . , : = @ + %` only (no `/`, so no path). A flag longer than 100
 * characters or a line of more than 12 words is not a launch flag.
 */
const FLAG_WORD = /^[A-Za-z0-9_.,:=@+%-]{1,100}$/;
/**
 * A person keeps flags, not config: a flag that points the CLI at other config,
 * another directory or a command to run (`-c key=value` is TOML in Codex and can
 * start any binary) turns a launch flag into code execution. Refused by name,
 * `=` form and attached short form included.
 */
const NOT_A_LAUNCH_FLAG = /^(-[cCp]|--?(config|profile|cd|cwd|add-dir|settings|setting-sources|mcp[\w-]*|plugin[\w-]*|env|exec|command|cmd|shell|hooks?[\w-]*|dir|directory|file|path|home|model-provider|provider)(?==|$))/i;
export const FLAG_WORDS_MAX = 12;

export function parseFlagLine(line: string): { ok: true; argv: string[] } | { ok: false; error: string } {
  if (/[\r\n]/.test(line)) return { ok: false, error: "one line, no line breaks" };
  const argv = line.trim().split(/\s+/).filter(Boolean);
  if (argv.length > FLAG_WORDS_MAX) return { ok: false, error: `more than ${FLAG_WORDS_MAX} words` };
  const bad = argv.find((w) => !FLAG_WORD.test(w) || NOT_A_LAUNCH_FLAG.test(w));
  return bad === undefined ? { ok: true, argv } : { ok: false, error: `not a plain flag word: ${bad.slice(0, 20)}` };
}

/** Per engine, per mode: the flags a person typed over the built-in ones. */
export type FlagOverrides = Record<string, Partial<Record<LaunchMode, string[]>>>;
