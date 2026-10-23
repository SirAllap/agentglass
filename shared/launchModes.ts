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
