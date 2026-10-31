/*
 * THE RULES SECTION, AS DECISIONS.
 *
 * What a rule is called, where it came from, how long ago, which ones fold, how
 * the eight-week strip grows and which agent a suggestion is holding up are
 * worked out here from what `GET /agent-rules` already sends, so the component
 * draws and a test can pin each rule. Nothing here is stored: a rule carries a
 * pattern and an action key, and the person's words for it are derived.
 *
 * The vocabulary is small on purpose: the rules people meet first have a house
 * name, everything else reads "Run <command>" or "Use <tool>". A rule that
 * needs a better name than that is a rule whose action key should say it.
 */
import { BASE_PROJECT, MODE_ACTION, decide, primaryInput, shellSegments, type AgentRule, type RuleSetting } from "../../../shared/agentRules.ts";
import type { LaunchMode } from "../../../shared/launchModes.ts";
import type { PhName } from "../components/agents/phosphor.tsx";

const DAY = 86_400_000;
export const WEEK = 7 * DAY;
/** The newest rules shown before the rest fold into "N older learned rules". */
export const LEARNED_SHOWN = 6;

/* ── what a rule is called ────────────────────────────────────────────── */

const SHAPE = /^([A-Za-z][A-Za-z0-9_-]*)(?:\(([\s\S]*)\))?$/;

/** The words a person would type for a rule: `make check`, `Edit docs/**`, `chat.post`. */
export function ruleCode(r: Pick<AgentRule, "match" | "action">): string {
  if (r.action === MODE_ACTION) return "permission mode";
  const m = SHAPE.exec(r.match.trim());
  if (!m) return r.match.trim();
  const [, tool, pat] = m as unknown as [string, string, string | undefined];
  if (tool === "Bash") return pat === undefined || pat === "*" ? "any shell command" : pat.replace(/:\*$/, "");
  if (pat !== undefined && pat !== "*") return `${tool} ${pat}`;
  /* A tool with no pattern: its action key when that is a readable one (`chat.post`), else the tool. */
  return r.action.includes(".") ? r.action : tool;
}

const TITLE: Record<string, string> = {
  "permission mode": "Run without asking",
  "git push": "Push code",
  "gh pr merge": "Merge pull requests",
  "gh release": "Publish a release",
  "gh pr create": "Open pull requests",
  "npm install": "Install packages",
  sudo: "Run a script as root",
  "chat.post": "Post in the team chat",
  "tracker.move_card": "Move tracker cards",
  "db.read prod": "Read the production database",
};
const PHRASE: Record<string, string> = {
  "make deploy-staging": "deploy to staging",
  "tracker.move_card": "move a tracker card",
  "make migrate": "run a database migration",
};

/** The vocabulary entry for a code: an exact word, or a command that continues one (`git push --force`). */
const known = <T>(table: Record<string, T>, code: string): T | undefined =>
  table[code] ?? Object.entries(table).find(([k]) => code.startsWith(`${k} `))?.[1];

const FILE_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

/** A person's name for a rule. `Edit docs/**` is "Edit files under docs/"; a command nobody named reads "Run <command>". */
export function ruleTitle(r: Pick<AgentRule, "match" | "action">): string {
  const code = ruleCode(r);
  const named = known(TITLE, code);
  if (named) return named;
  const m = SHAPE.exec(r.match.trim());
  const tool = m?.[1] ?? "";
  if (FILE_TOOLS.test(tool)) {
    const dir = (m?.[2] ?? "").replace(/\*+$/, "");
    if (dir) return tool === "Edit" || tool === "MultiEdit" ? `Edit files under ${dir}` : `Write to ${dir}`;
    return tool === "Edit" || tool === "MultiEdit" ? "Edit files" : "Write files";
  }
  return tool === "Bash" ? `Run ${code}` : `Use ${code}`;
}

/** A pattern's name when only the pattern is known (a request's diff line). */
export const titleOfMatch = (match: string): string => ruleTitle({ match, action: "" });

/** "deploy to staging": the half of a suggestion's headline after "New in acme/orbit:". */
export function suggestionPhrase(r: Pick<AgentRule, "match" | "action">): string {
  const named = known(PHRASE, ruleCode(r));
  if (named) return named;
  const t = ruleTitle(r);
  return t.charAt(0).toLowerCase() + t.slice(1);
}

const ICONS: Record<string, PhName> = {
  "permission mode": "lightning",
  "git push": "arrow-right",
  "gh pr merge": "check-circle",
  "gh release": "rocket-launch",
  "gh pr create": "git-branch",
  "npm install": "hard-drives",
  sudo: "lock-key",
  "chat.post": "chat-circle-text",
  "tracker.move_card": "list-checks",
  "db.read prod": "hard-drives",
};
export function ruleIcon(r: Pick<AgentRule, "match" | "action">): PhName {
  const code = ruleCode(r);
  const named = known(ICONS, code);
  if (named) return named;
  const tool = SHAPE.exec(r.match.trim())?.[1] ?? "";
  if (FILE_TOOLS.test(tool)) return "pencil-simple";
  return tool === "Bash" && /^make\b/.test(code) ? "play" : "terminal-window";
}

/* ── where it came from, and when ─────────────────────────────────────── */

export type ChipKind = "chat" | "first" | "always" | "plain";
export interface SourceChip { kind: ChipKind; icon: PhName; label: string }

/**
 * The chip of a rule's origin. A base rule is a base rule whoever last touched
 * it; the `you` source (a rule written with the person's own hand, through the
 * CLI or a click on a row) has no chip in the approved design and is the one
 * extra word here.
 */
export function sourceChip(r: Pick<AgentRule, "source">, base = false): SourceChip {
  if (base) return { kind: "plain", icon: "circle-dashed", label: "base rule" };
  switch (r.source) {
    case "chat": return { kind: "chat", icon: "chat-circle-text", label: "you said it in chat" };
    case "first-seen": return { kind: "first", icon: "sparkle", label: "seen for the first time" };
    case "always-allow": return { kind: "always", icon: "check-circle", label: "you pressed Always allow here" };
    case "base": return { kind: "plain", icon: "circle-dashed", label: "base rule" };
    default: return { kind: "plain", icon: "user-circle", label: "you set it" };
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
/** "3 days ago", "2 weeks ago": whole words, the way the design writes them. */
export function agoWords(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return plural(Math.floor(ms / 60_000), "minute");
  if (ms < DAY) return plural(Math.floor(ms / 3_600_000), "hour");
  if (ms < 2 * WEEK) return plural(Math.floor(ms / DAY), "day");
  if (ms < 60 * DAY) return plural(Math.floor(ms / WEEK), "week");
  return plural(Math.floor(ms / (30 * DAY)), "month");
}

/** The grey half of a rule's second line: "told to builder-1, 3 days ago", "docs-4, 3 weeks ago", "since install". */
export function ruleWhen(r: Pick<AgentRule, "source" | "by" | "at">, now: number, base = false): string {
  if (base) return "since install";
  const ago = agoWords(r.at, now);
  const agent = r.by && r.by !== "you" ? r.by : "";
  if (r.source === "chat") return agent ? `told to ${agent}, ${ago}` : ago;
  if (r.source === "always-allow") return agent ? `${agent}, ${ago}` : ago;
  return ago;
}

/* ── the lists ────────────────────────────────────────────────────────── */

export interface LearnedRow { rule: AgentRule; fresh: boolean }

/** Newest first; the ones learned in the last week are marked, and past `limit` the rest fold. */
export function splitLearned(learned: readonly AgentRule[], now: number, limit = LEARNED_SHOWN): { shown: LearnedRow[]; older: LearnedRow[] } {
  const rows = [...learned].sort((a, b) => b.at - a.at).map((rule): LearnedRow => ({ rule, fresh: now - rule.at < WEEK }));
  return { shown: rows.slice(0, limit), older: rows.slice(limit) };
}

export interface Totals { total: number; base: number; learned: number; week: number }
export function ruleTotals(v: { base: readonly unknown[]; learned: readonly unknown[]; weekly: readonly number[] }): Totals {
  const week = v.weekly.length ? v.weekly[v.weekly.length - 1]! : 0;
  return { total: v.base.length + v.learned.length, base: v.base.length, learned: v.learned.length, week: Number.isFinite(week) && week > 0 ? week : 0 };
}

/** The base rules in the order the design lists them: the patterns as stored, the permission mode last. */
export const baseOrder = (base: readonly AgentRule[]): AgentRule[] => [...base.filter((r) => r.action !== MODE_ACTION), ...base.filter((r) => r.action === MODE_ACTION)];

/* ── the permission mode, as the design's words ───────────────────────── */

/** Every launch mode has a button: the base rule can hold any of the four (Settings offers all of them),
 *  and a control with none lit says nothing about what is in force. */
export const MODE_CHOICES: readonly { mode: LaunchMode; word: string }[] = [
  { mode: "default", word: "Ask" }, { mode: "auto", word: "Auto" }, { mode: "acceptEdits", word: "Edits" }, { mode: "bypassPermissions", word: "Bypass" },
];

/* ── the first-run line ───────────────────────────────────────────────── */

const NEVER_WORD: Record<string, string> = { "git push": "no push", "gh pr merge": "no merge", "gh release": "no release" };
const MODE_WORD: Record<LaunchMode, string> = {
  default: "ask before risky things", acceptEdits: "edits need no asking, the rest asks", auto: "run on its own", bypassPermissions: "nothing asks first",
};

/** "4 base rules are on: no push, no merge, no release, ask before risky things." The base set in one breath, from what is set now. */
export function baseSummary(base: readonly AgentRule[], mode: LaunchMode): { count: number; lead: string; rest: string } {
  const words = base.filter((r) => r.action !== MODE_ACTION && r.setting !== "allow")
    .map((r) => (r.setting === "never" ? known(NEVER_WORD, ruleCode(r)) ?? `no ${ruleCode(r)}` : `ask before ${ruleCode(r)}`));
  const count = base.length;
  return { count, lead: `${count} base ${count === 1 ? "rule is" : "rules are"} on:`, rest: `${[...words, MODE_WORD[mode]].join(", ")}.` };
}

/* ── a suggestion that is holding an agent up ─────────────────────────── */

/** Is `path` the project's root or somewhere inside it (a worktree under it included)? */
export const isUnder = (path: string, root: string): boolean => {
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
};

export interface HeldCall { session_id: string; tool_name: string; summary: string }

/**
 * The agent a suggestion is blocking right now: the one whose held call this
 * rule would have decided. Null is "nobody is waiting", and the card says it
 * is a quiet badge. The call is matched with the shared decision itself, so the
 * words here cannot disagree with what the hook does.
 */
export function blockedBy(rule: AgentRule, root: string, held: readonly HeldCall[], nameOf: (session: string) => string | undefined): string | null {
  const one = [{ ...rule, pending: false, project: BASE_PROJECT }];
  for (const g of held) {
    /* One command at a time: `cd x && make deploy` is held on the deploy, and a segment with no rule must not hide it. */
    const parts = g.tool_name === "Bash" ? shellSegments(primaryInput(g.summary)) : [g.summary];
    if (parts.some((p) => decide(one, root, g.tool_name, p).decision !== "unknown")) return nameOf(g.session_id) ?? "an agent";
  }
  return null;
}

/** A person's click on a row: the pattern keeps its words and its origin when the origin is one a click may carry. */
export function rowRequest(rule: AgentRule, setting: RuleSetting) {
  return {
    root: rule.project, action: rule.action, match: rule.match, setting,
    ...(rule.source === "chat" || rule.source === "always-allow" ? { source: rule.source } : null),
  };
}

/** The projects the Agents screen's picker offers: the open ones, then any with a coordinator, then any that
 *  only has live sessions (a cockpit opened on one project still has agents running in another). */
export const pickerProjects = (open: readonly string[], chairRoots: readonly string[], rows: readonly { project?: string; gone?: boolean }[]): string[] =>
  [...new Set([...open, ...chairRoots, ...rows.filter((r) => !r.gone && r.project).map((r) => r.project!)])];
