/**
 * One rule list per project that every agent obeys, wherever it was started.
 *
 * A rule is a tool pattern in the `launch.deny` syntax (`Bash(git push:*)`,
 * `Edit`, `mcp__orbit__deploy`) with one of three settings. The list for a
 * project is the base set (`project: "*"`) plus what that project learned.
 * When two rules match a call, the narrower pattern speaks for it, so a broad
 * allow never loosens a narrower never; on the same pattern the project's own
 * rule beats the base one, and inside one tier the stricter wins.
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

/** Words that shape a shell line but are not commands: a suggestion built from one is noise. */
export const SHELL_WORDS = new Set(["for", "in", "do", "done", "while", "until", "if", "then", "elif", "else", "fi", "case", "esac", "select", "function", "time", "{", "}", "!"]);
/** Words that open a command: `do gh pr view` is the command `gh pr view`. */
const LEADS = /^(?:(?:do|then|else|elif|if|while|until|time|!|\{)\s+)+/;

/**
 * Could this word start a command? Not a flag (`- master`), a number (`408`),
 * an all-caps word (`ERROR`, `EOF`, `ORBIT-1042`) or a shell keyword: those are
 * text that an older split cut out of a quote or a heredoc. `Rscript` is a command.
 */
export const isCommandWord = (w: string): boolean =>
  /^[A-Za-z0-9_.@+-]{1,60}$/.test(w) && !w.startsWith("-") && !/^\d+$/.test(w) &&
  !(/^[A-Z][A-Z0-9_-]*$/.test(w) && /[A-Z].*[A-Z]/.test(w)) && !SHELL_WORDS.has(w);

/** Past the `'` that closes a quote opened before `i`; `ansi` is `$'...'`, where a backslash escapes. */
function singleEnd(s: string, i: number, ansi: boolean): number {
  for (; i < s.length; i++) {
    if (ansi && s[i] === "\\") i++;
    else if (s[i] === "'") return i + 1;
  }
  return s.length;
}

/** Past the `))` that closes `$((` opened before `i`: arithmetic, no command in it. */
function arithEnd(s: string, i: number): number {
  for (let depth = 2; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i + 1;
  }
  return s.length;
}

/**
 * Text where only substitutions run: inside double quotes (`end` is `"`) or a
 * heredoc body whose tag is unquoted (`end` is ""). The commands of each
 * `$(...)` and backtick go to `out`; the rest is text. Returns past `end`.
 */
function quotedText(s: string, i: number, end: string, out: string[]): number {
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") i += 2;
    else if (end && c === end) return i + 1;
    else if (c === "$" && s.startsWith("$((", i)) i = arithEnd(s, i + 3);
    else if (c === "$" && s[i + 1] === "(") i = scanShell(s, i + 2, ")", out);
    else if (c === "`") i = scanShell(s, i + 1, "`", out);
    else i++;
  }
  return i;
}

/**
 * Split shell text into raw commands, the way the shell reads it: on unquoted
 * `|`, `||`, `&&`, `;`, `&`, newline and subshell parentheses. Quotes and
 * comments are text; a heredoc body is text, and with an unquoted tag its
 * substitutions run, as they do in bash. A `$(...)` or backtick is its own
 * command, listed after the one it sits in. `close` is the `)` or backtick
 * this call stops at; it returns the index past it.
 */
function scanShell(s: string, i: number, close: ")" | "`" | "", out: string[]): number {
  let cur = "";
  let inner: string[] = [];
  let depth = 0;
  const docs: { tag: string; strip: boolean; expand: boolean }[] = [];
  const flush = () => { out.push(cur, ...inner); cur = ""; inner = []; };
  while (i < s.length) {
    const c = s[i]!;
    const start = i;
    if (c === "\\") i += 2;
    else if (c === close && (close === "`" || depth === 0)) { i++; break; }
    else if (c === "'") i = singleEnd(s, i + 1, false);
    else if (c === "$" && s[i + 1] === "'") i = singleEnd(s, i + 2, true);
    else if (c === '"') i = quotedText(s, i + 1, '"', inner);
    else if (c === "$" && s.startsWith("$((", i)) i = arithEnd(s, i + 3);
    else if (c === "$" && s[i + 1] === "(") i = scanShell(s, i + 2, ")", inner);
    else if (c === "`") i = scanShell(s, i + 1, "`", inner);
    else if (c === "#" && (cur === "" || /\s$/.test(cur))) { while (i < s.length && s[i] !== "\n") i++; continue; }
    else if (c === "<" && s.startsWith("<<", i) && s[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*((?:[^\s;|&<>()'"\\]|\\.|'[^']*'|"[^"]*")+)/.exec(s.slice(i));
      if (!m) { cur += "<<"; i += 2; continue; }
      docs.push({ tag: m[2]!.replace(/['"\\]/g, ""), strip: m[1] === "-", expand: !/['"\\]/.test(m[2]!) });
      i += m[0].length;
    } else if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")" ||
               (c === "&" && s[i + 1] !== ">" && !/[<>]$/.test(cur))) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      flush();
      i++;
      if (c === "\n") {
        // Every heredoc opened on the line just ended has its body here, one after another.
        for (const d of docs.splice(0)) {
          let body = "";
          while (i < s.length) {
            const nl = s.indexOf("\n", i);
            const lineEnd = nl < 0 ? s.length : nl;
            const line = s.slice(i, lineEnd);
            i = nl < 0 ? s.length : nl + 1;
            if ((d.strip ? line.replace(/^\t+/, "") : line) === d.tag) break;
            body += `${line}\n`;
          }
          if (d.expand) quotedText(body, 0, "", out);
        }
      }
      continue;
    } else i++;
    cur += s.slice(start, i);
  }
  flush();
  return i;
}

/** Flags a CLI takes before its subcommand, and whether each one takes the next word as its value. */
const GLOBAL_FLAGS: Record<string, Record<string, boolean>> = {
  gh: { "-R": true, "--repo": true, "--hostname": true },
  git: { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--no-pager": false, "--paginate": false, "-p": false, "--no-optional-locks": false },
};

/**
 * `gh --repo acme/orbit pr checks 12` and `git -C dir log` are `gh pr` and
 * `git log` to a rule: the flags before the subcommand say where, not what.
 * shortcut: only gh and git, only the flags listed above; another CLI's global
 * flags still end its rule at the flag, as before.
 */
function skipGlobalFlags(seg: string): string {
  const words = seg.split(/\s+/);
  const flags = GLOBAL_FLAGS[words[0]!];
  if (!flags) return seg;
  let i = 1;
  while (i < words.length && words[i]!.startsWith("-")) {
    const w = words[i]!;
    const takesValue = flags[w];
    if (takesValue === undefined && !/^--[a-z-]+=/.test(w)) break;
    i += takesValue ? 2 : 1;
  }
  return i === 1 ? seg : [words[0], ...words.slice(i)].join(" ");
}

/**
 * The commands of one shell line, so `cd x && git push` is checked as a push.
 * Quoted text and heredoc bodies are not commands, so `grep -E "a|b"` and a
 * commit message with `- item` lines are one command each; a command inside
 * `$(...)` or backticks is one, quoted or not, so a "never" still holds there.
 * Loop and `if` heads, `done`/`fi` and the like drop out; the command after
 * `do`/`then`/`else` stays. `case` patterns (`a) cmd`) are not unpicked.
 */
export function shellSegments(command: string): string[] {
  const raw: string[] = [];
  scanShell(command, 0, "", raw);
  return raw.flatMap((s) => unwrapped(s))
    .filter((s) => s && !SHELL_WORDS.has(s) && !/^(?:for|select|case|function)\b/.test(s));
}

/**
 * Words that run the command after them. Each lists the flags that take the
 * next word as their value, and how many plain words come before the command
 * (`timeout 60 git push`). shortcut: the common flags only; an unlisted flag
 * that takes a value leaves its value as the command, which no rule matches.
 */
const WRAPPERS: Record<string, { valued: string[]; args?: number }> = {
  env: { valued: ["-u", "--unset", "-C", "--chdir"] },
  sudo: { valued: ["-u", "--user", "-g", "--group", "-C", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "-t", "-U"] },
  doas: { valued: ["-u", "-C"] },
  command: { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ["-a"] },
  nice: { valued: ["-n", "--adjustment"] },
  nohup: { valued: [] },
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], args: 1 },
  stdbuf: { valued: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: { valued: ["-n", "-L", "-P", "-I", "-d", "-E", "-s", "-a", "--max-args", "--max-lines", "--max-procs", "--delimiter", "--eof", "--arg-file", "--max-chars"] },
};
/** `bash -c '...'`, `sh -lc "..."`: the string is the command line. */
const SHELL_C = /^(?:ba|z|da|k)?sh\s+(?:-[A-Za-z-]+\s+)*?-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/;

/** Is this segment a wrapper or a `-c` shell, whose own name is no rule anybody means? */
export const isWrapper = (seg: string): boolean =>
  seg.split(/\s+/)[0]! in WRAPPERS || SHELL_C.test(seg) || /^eval\s/.test(seg);

/** Words as the shell reads them: quotes removed, backslashes resolved. Enough for the string of a `-c`. */
function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (/\s/.test(c)) { if (any) out.push(cur); cur = ""; any = false; continue; }
    any = true;
    if (c === "'") { const e = s.indexOf("'", i + 1); const end = e < 0 ? s.length : e; cur += s.slice(i + 1, end); i = end; }
    else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) { if (s[j] === "\\" && /["\\$`]/.test(s[j + 1] ?? "")) j++; cur += s[j]; }
      i = j;
    } else if (c === "\\") cur += s[++i] ?? "";
    else cur += c;
  }
  if (any) out.push(cur);
  return out;
}

/** The command a wrapper runs, or the segment itself when it is not a wrapper or runs nothing. */
function unwrap(seg: string): string {
  const words = seg.split(/\s+/);
  const w = WRAPPERS[words[0]!];
  // `command -v gh` asks where gh is; it runs nothing.
  if (!w || (words[0] === "command" && /^-[vV]$/.test(words[1] ?? ""))) return seg;
  let i = 1;
  while (i < words.length && (words[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))) {
    const f = words[i++]!;
    if (f === "--") break;
    if (w.valued.includes(f)) i++;
  }
  i += w.args ?? 0;
  return i < words.length ? words.slice(i).join(" ") : seg;
}

/**
 * One raw command as a rule reads it. A wrapper (`env X=1`, `sudo`,
 * `timeout 60`, `xargs -n1`) is kept as written and the command it runs is
 * listed after it, so a never on either holds; the string of `bash -c` and
 * `eval` is read as a shell line of its own.
 */
function unwrapped(raw: string, depth = 0): string[] {
  const s = raw.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(LEADS, "").trim();
  if (depth > 8) return [s];
  const inner = unwrap(s);
  if (inner !== s) return [s, ...unwrapped(inner, depth + 1)];
  const c = SHELL_C.exec(s);
  const line = c ? shellWords(c[1]!)[0] : /^eval\s/.test(s) ? shellWords(s.slice(5)).join(" ") : undefined;
  if (line !== undefined) {
    const raws: string[] = [];
    scanShell(line, 0, "", raws);
    return [s, ...raws.flatMap((r) => unwrapped(r, depth + 1))];
  }
  return [skipGlobalFlags(s)];
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

/** How much of a call a pattern names: `Bash(gh pr merge:*)` is narrower than `Bash(gh:*)`, which is narrower than `Bash`. */
function specificity(match: string): number {
  const pat = RULE_SHAPE.exec(match)?.[2];
  return pat === undefined ? 0 : pat.replace(/:\*$/, "").replace(/\*/g, "").length + 1;
}

/** The rule that speaks for one segment: the narrowest pattern; on the same width the project's own; then the stricter. */
function winner(live: readonly AgentRule[], tool: string, seg: string): AgentRule | null {
  let best: AgentRule | null = null;
  let width = -1;
  for (const r of live) {
    if (!matchesOne(r.match, tool, seg)) continue;
    const w = specificity(r.match);
    const d = !best ? 1 : w !== width ? w - width
      : (r.project !== BASE_PROJECT) !== (best.project !== BASE_PROJECT) ? (r.project !== BASE_PROJECT ? 1 : -1)
      : RANK[r.setting] - RANK[best.setting];
    if (d > 0) { best = r; width = w; }
  }
  return best;
}

/**
 * `git push` that rewrites or deletes on the remote: `--force`, `-f` (alone or
 * in `-uf`), `--force-with-lease`, a `+refspec`, `--delete`, `-d` or a
 * `:branch` refspec. It asks, whatever allows `git push`, unless the rule that
 * speaks for it names the force or the delete itself.
 */
const isForcePush = (seg: string): boolean => {
  const w = seg.split(/\s+/);
  return w[0] === "git" && w[1] === "push" &&
    w.slice(2).some((x) => /^--(?:force(?:-with-lease)?|delete)(?:=|$)/.test(x) || /^-[A-Za-z]*[fd][A-Za-z]*$/.test(x) || /^[+:]./.test(x));
};
const namesForce = (match: string): boolean => /--force|--delete|\s-[A-Za-z]*[fd]\b|\s[+:]/.test(match);

/** Order of a line's verdict: a command no rule covers outweighs an allow, never an ask. */
const LINE_RANK: Record<RuleDecision, number> = { allow: 0, unknown: 1, ask: 2, never: 3 };

/**
 * The decision for one tool call. A Bash line is every command in it, and the
 * strictest wins: never, then ask, then a command no rule covers (`unknown`),
 * then allow. So `cd pkg && npm publish` asks when publishing asks.
 */
export function decide(rules: readonly AgentRule[], root: string, tool: string, input: unknown): RuleCheck {
  const live = rulesFor(rules, root);
  const text = primaryInput(input);
  const segments = tool === "Bash" ? shellSegments(text) : [text];
  if (segments.length === 0) segments.push("");
  let line: RuleCheck = { decision: "allow" };
  let any = false;
  for (const seg of segments) {
    const r = winner(live, tool, seg);
    let here: RuleCheck = r ? { decision: r.setting, ruleId: r.id, reason: reasonFor(r) } : { decision: "unknown" };
    if (tool === "Bash" && isForcePush(seg) && LINE_RANK[here.decision] < LINE_RANK.ask && !(r && namesForce(r.match))) {
      here = { decision: "ask", ...(r ? { ruleId: r.id } : {}), reason: "a force push or a remote delete asks first, whatever allows git push; a rule that names --force or --delete can change that." };
    }
    if (!any || LINE_RANK[here.decision] > LINE_RANK[line.decision]) line = here;
    any = true;
  }
  return line;
}

/**
 * What is in force today for the calls a pattern names, read as one of those
 * calls (`Bash(gh pr:*)` as `gh pr`). null when no rule covers it. A write is
 * looser when it hands an agent more than this.
 */
export function inForceFor(rules: readonly AgentRule[], root: string, match: string): RuleSetting | null {
  const m = RULE_SHAPE.exec(match);
  if (!m) return null;
  const call = (m[2] ?? "").replace(/:\*$/, "").replace(/\*+/g, "");
  const d = decide(rules, root, m[1]!, m[1] === "Bash" ? { command: call } : call).decision;
  return d === "unknown" ? null : d;
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
  // The first command that is not a wrapper: `timeout 60 npm test` is a rule about `npm test`.
  const seg = shellSegments(primaryInput(input)).find((x) => !isWrapper(x));
  if (!seg) return null;
  // The first two words as written: a word that is not plain (a path, a quote) ends the rule there, it is never skipped to reach the next.
  const words = seg.split(/\s+/).slice(0, 2);
  const plain = words.findIndex((w) => !/^[A-Za-z0-9_.@+-]{1,60}$/.test(w));
  if (plain >= 0) words.length = plain;
  if (words.length === 0 || QUIET_WORDS.has(words[0]!) || !isCommandWord(words[0]!)) return null;
  // A second word that is a flag or a path is not a subcommand.
  const keep = words.length === 2 && /^[a-z][a-z0-9-]*$/.test(words[1]!) ? words : words.slice(0, 1);
  return { action: `bash.${keep.join(".")}`, match: `Bash(${keep.join(" ")}:*)` };
}

/**
 * Would Claude Code stop and ask the person for this call, in this session mode
 * (the `permission_mode` of a hook payload)? `default` asks for anything its
 * allow list does not cover, `plan` for whatever it is about to do, and
 * `acceptEdits` for everything but file edits. `bypassPermissions`, `auto`,
 * `dontAsk` and a payload with no mode (OpenCode, an older hook) never ask, so
 * a call under them is not worth a suggestion: it ran without asking anybody.
 * shortcut: the session's own allow list is not in the payload, so a `default`
 * session that had allowed `git add` still files it, until a prompt hook says so.
 */
export function wouldPrompt(mode: string | undefined, tool: string): boolean {
  if (mode === "default" || mode === "plan") return true;
  return mode === "acceptEdits" && !/^(?:Edit|MultiEdit|Write|NotebookEdit)$/.test(tool);
}

/** Same bound as the deny list a launch carries, so the flags never outgrow one argv element. */
export const RULES_MAX_PER_PROJECT = DENY_MAX * 4;
