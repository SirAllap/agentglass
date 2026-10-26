/**
 * One rule list per project that every agent obeys, wherever it was started.
 *
 * A rule is a tool pattern in the `launch.deny` syntax (`Bash(git push:*)`,
 * `Edit`, `mcp__orbit__deploy`) with one of three settings. The list for a
 * project is the base set (`project: "*"`) plus what that project learned;
 * when two rules match a call, the stricter one wins, the way Claude Code
 * lets a deny beat an allow.
 *
 * Shared because the server decides with it, the hook route answers with it
 * and the web shows the same words; the matching lives here once.
 */
import { DENY_MAX, type LaunchMode } from "./launchModes";

export const RULE_SETTINGS = ["allow", "ask", "never"] as const;
export type RuleSetting = (typeof RULE_SETTINGS)[number];
export const isRuleSetting = (v: unknown): v is RuleSetting =>
  typeof v === "string" && (RULE_SETTINGS as readonly string[]).includes(v);

export const RULE_SOURCES = ["base", "chat", "first-seen", "always-allow", "you"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];
export const isRuleSource = (v: unknown): v is RuleSource =>
  typeof v === "string" && (RULE_SOURCES as readonly string[]).includes(v);

/** `project` for a rule every project shares. */
export const BASE_PROJECT = "*";
/** The action key of the one base rule that is a permission mode, not a pattern. */
export const MODE_ACTION = "launch.mode";

export interface AgentRule {
  id: string;
  /** A project root, or `"*"` for the base set. */
  project: string;
  /** A stable key a person can read: `git.push`, `gh.pr.merge`, or a learned `bash.npm.test`. */
  action: string;
  /** The tool pattern, `launch.deny` syntax. Empty for the mode rule. */
  match: string;
  setting: RuleSetting;
  source: RuleSource;
  /** An agent's name, or `"you"` for the person. */
  by: string;
  at: number;
  /** A suggestion or a looser change waiting for the person; it does not apply yet. */
  pending?: boolean;
  /** Only on the `launch.mode` rule. */
  mode?: LaunchMode;
}

export interface RuleChange {
  ruleId: string;
  /** null when the change created the rule. */
  from: RuleSetting | null;
  to: RuleSetting;
  by: string;
  at: number;
  applied: boolean;
  waitsForPerson: boolean;
}

/** What `GET /agent-rules?root=…` answers. */
export interface AgentRulesView {
  root: string;
  mode: LaunchMode;
  base: AgentRule[];
  learned: AgentRule[];
  suggested: AgentRule[];
  history: RuleChange[];
  /** Rules this project learned per week, oldest first, this week last. */
  weekly: number[];
}

/** What `POST /agent-rules` takes. */
export interface RuleRequest {
  root: string;
  action?: string;
  match: string;
  setting: RuleSetting;
  source?: RuleSource;
  /** Only with `action: "launch.mode"`. */
  mode?: LaunchMode;
}

/** What `POST /agent-rules` answers. */
export interface RuleWrite {
  rule: AgentRule;
  applied: boolean;
  /** Set when the change is looser and a person has to answer it. */
  waitsForPerson: boolean;
}

export type RuleDecision = RuleSetting | "unknown";
/** What `GET /agent-rules/check` answers. */
export interface RuleCheck { decision: RuleDecision; ruleId?: string; reason?: string }

/** The base set a fresh install starts with: merging and releasing stay a person's, the rest is visible. */
export const BASE_RULES: readonly { action: string; match: string; setting: RuleSetting }[] = [
  { action: "git.push", match: "Bash(git push:*)", setting: "allow" },
  { action: "gh.pr.merge", match: "Bash(gh pr merge:*)", setting: "never" },
  { action: "gh.release", match: "Bash(gh release:*)", setting: "never" },
];

const RANK: Record<RuleSetting, number> = { allow: 0, ask: 1, never: 2 };
/** Strictest first, so a stricter rule wins over a looser one that also matches. */
export const stricter = (a: RuleSetting, b: RuleSetting): RuleSetting => (RANK[a] >= RANK[b] ? a : b);
/** True when going from `from` to `to` hands an agent more than it had. No rule counts as `ask`. */
export const isLooser = (from: RuleSetting | null, to: RuleSetting): boolean => RANK[to] < RANK[from ?? "ask"];

/** Strictest first: a mode that asks more is stricter. */
const MODE_RANK: Record<LaunchMode, number> = { default: 3, acceptEdits: 2, auto: 1, bypassPermissions: 0 };
export const isLooserMode = (from: LaunchMode, to: LaunchMode): boolean => MODE_RANK[to] < MODE_RANK[from];

/**
 * The string a pattern is matched against: a Bash call's command, a file tool's
 * path, a fetch's URL. `input` is the tool input as JSON or as that string already.
 */
export function primaryInput(input: unknown): string {
  let v = input;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return v as string; }
  }
  if (!v || typeof v !== "object") return typeof v === "string" ? v : "";
  const o = v as Record<string, unknown>;
  for (const k of ["command", "file_path", "filePath", "notebook_path", "path", "url", "pattern"]) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  return "";
}

/**
 * The commands of one shell line, so `cd x && git push` is checked as a push.
 * shortcut: splits on operators and ignores quoting, so an `&&` inside quotes
 * splits too; that only ever adds a segment to check, never hides one.
 */
export function shellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n&]/)
    .map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^\(+|\)+$/g, "").trim())
    .filter(Boolean);
}

const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_-]{0,99})(?:\((.{1,200})\))?$/;

function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*?/g, ".*")}$`, "s");
  return re.test(s);
}

/** Does one segment (a Bash command, or the whole input of another tool) fall under `match`? */
function matchesOne(rule: string, tool: string, input: string): boolean {
  const m = RULE_SHAPE.exec(rule);
  if (!m) return false;
  const [, name, pat] = m;
  if (name !== tool) return false;
  if (pat === undefined || pat === "*") return true;
  if (tool === "Bash") {
    // `git push:*` is a prefix at a word boundary, the way Claude Code reads it.
    if (pat.endsWith(":*")) {
      const pre = pat.slice(0, -2);
      return input === pre || input.startsWith(`${pre} `);
    }
    return globMatch(pat, input);
  }
  return globMatch(pat, input);
}

/** The rules that apply to one project: base and learned, pending ones left out. */
export const rulesFor = (rules: readonly AgentRule[], root: string): AgentRule[] =>
  rules.filter((r) => !r.pending && r.action !== MODE_ACTION && (r.project === BASE_PROJECT || r.project === root));

/**
 * The decision for one tool call. A Bash line is every command in it: the
 * strictest setting of any command wins, and a line where some command has no
 * rule at all is `unknown` unless another command in it is already `never`.
 */
export function decide(rules: readonly AgentRule[], root: string, tool: string, input: unknown): RuleCheck {
  const live = rulesFor(rules, root);
  const text = primaryInput(input);
  const segments = tool === "Bash" ? shellSegments(text) : [text];
  if (segments.length === 0) segments.push("");
  let best: { setting: RuleSetting; rule: AgentRule } | null = null;
  let unknown = false;
  for (const seg of segments) {
    let seen: { setting: RuleSetting; rule: AgentRule } | null = null;
    for (const r of live) {
      if (!matchesOne(r.match, tool, seg)) continue;
      // A project's own rule speaks for that project over the base set; within one tier, stricter wins.
      if (!seen || (r.project !== BASE_PROJECT && seen.rule.project === BASE_PROJECT) ||
          (r.project === seen.rule.project && stricter(r.setting, seen.setting) === r.setting && r.setting !== seen.setting)) {
        seen = { setting: r.setting, rule: r };
      }
    }
    if (!seen) { unknown = true; continue; }
    if (!best || stricter(seen.setting, best.setting) === seen.setting && seen.setting !== best.setting) best = seen;
  }
  if (best?.setting === "never") return { decision: "never", ruleId: best.rule.id, reason: reasonFor(best.rule) };
  if (unknown) return { decision: "unknown" };
  if (!best) return { decision: "unknown" };
  return { decision: best.setting, ruleId: best.rule.id, reason: reasonFor(best.rule) };
}

const reasonFor = (r: AgentRule): string =>
  `agentglass rule ${r.action} (${r.match}) is "${r.setting}" ${r.project === BASE_PROJECT ? "for every project" : "in this project"}; set by ${r.by}.`;

/** Tools that only read, and read-only shell words: they never become a suggestion. */
const QUIET_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "ToolSearch", "WebSearch"]);
const QUIET_WORDS = new Set(["ls", "cat", "head", "tail", "grep", "rg", "wc", "echo", "pwd", "which", "cd", "true", "test", "printf", "date", "sort", "uniq", "jq"]);

/**
 * The rule a person would write for one call: a Bash command keeps its first
 * two words (`git commit` → `Bash(git commit:*)`), any other tool its name.
 * null for a call that only reads. shortcut: two words is one size for every
 * CLI; `docker compose run` and `git commit` land at the same depth.
 */
export function ruleFor(tool: string, input: unknown): { action: string; match: string } | null {
  if (QUIET_TOOLS.has(tool) || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(tool)) return null;
  if (tool !== "Bash") return { action: tool.toLowerCase(), match: tool };
  const seg = shellSegments(primaryInput(input))[0];
  if (!seg) return null;
  // The first two words as written: a word that is not plain (a path, a quote) ends the rule there, it is never skipped to reach the next.
  const words = seg.split(/\s+/).slice(0, 2);
  const plain = words.findIndex((w) => !/^[A-Za-z0-9_.@+-]{1,60}$/.test(w));
  if (plain >= 0) words.length = plain;
  if (words.length === 0 || QUIET_WORDS.has(words[0]!)) return null;
  // A second word that is a flag or a path is not a subcommand.
  const keep = words.length === 2 && /^[a-z][a-z0-9-]*$/.test(words[1]!) ? words : words.slice(0, 1);
  return { action: `bash.${keep.join(".")}`, match: `Bash(${keep.join(" ")}:*)` };
}

/** Same bound as the deny list a launch carries, so the flags never outgrow one argv element. */
export const RULES_MAX_PER_PROJECT = DENY_MAX * 4;
