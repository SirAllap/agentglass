// Shared event + analytics contract between server and web.
// Keep this file dependency-free so both sides can import it.

export type HookEventType =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "PreCompact";

/** Raw payload posted by the Claude Code hook. */
export interface IngestBody {
  source_app: string;
  session_id: string;
  hook_event_type: HookEventType | string;
  payload?: Record<string, unknown>;
  /** Optional transcript array (assistant/user messages with `usage`). */
  chat?: unknown[];
  summary?: string;
  model_name?: string;
  timestamp?: number; // ms; server stamps if absent
}

/** A normalized, stored event as returned by the API / WS. */
export interface WatchEvent {
  id: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  tool_name: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  model_name: string | null;
  is_error: number; // 0 | 1
  error_text: string | null;
  duration_ms: number | null; // filled on PostToolUse via pre→post pairing
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  summary: string | null;
  timestamp: number; // ms
  payload: Record<string, unknown>;
}

export interface SessionRollup {
  session_id: string;
  source_app: string;
  model_name: string | null;
  /** Directory the session ran in — what a resume needs to run in the right
   *  place. Null for rows recorded before the column existed. */
  project_path?: string | null;
  /** The exact checkout it ran in, when that isn't the repo root — a linked
   *  worktree or a monorepo subdir. This is what tells two agents apart when
   *  several are working the same project on different branches. */
  cwd_path?: string | null;
  /** What this session is called. `custom_title` is a rename by hand and wins;
   *  `ai_title` is the one the agent generated. Both come from the transcript,
   *  so they're absent for hook-only sessions. Use sessionTitle() rather than
   *  reading them directly — the precedence is the whole point. */
  custom_title?: string | null;
  ai_title?: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen: number;
  event_count: number;
  tool_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface CostByModel {
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  sessions: number;
}

export interface ToolLatencyStat {
  tool_name: string;
  calls: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  avg_ms: number;
  total_ms: number;
}

export interface TimeBucket {
  t: number; // bucket start, ms
  events: number;
  errors: number;
  cost_usd: number;
  tokens: number;
}

export interface SkillUsage {
  skill: string;
  calls: number;
  /** Cost attributed to this skill (events charged to the running skill). */
  cost_usd: number;
  last_used: number;
  /** Run counts across the window, oldest bucket first. */
  buckets: number[];
}

export interface AppUsage {
  source_app: string;
  events: number;
  sessions: number;
  tool_calls: number;
  cost_usd: number;
  tokens: number;
}

export interface TypeCount {
  hook_event_type: string;
  count: number;
}

/** A skill or slash-command discovered on disk, joined with its recorded usage. */
export interface SkillInfo {
  name: string;
  kind: "skill" | "command";
  description: string;
  argument_hint: string | null;
  /** Canonical origin: "user" or the project dir name (e.g. "shop-api"). */
  source: string;
  /** How many locations define it (worktree copies collapse into one entry). */
  copies: number;
  path: string;
  /** When the skill was ADDED: git first-commit date where available,
   *  otherwise the oldest file mtime across copies (checkout mtimes cluster,
   *  so git dates are strongly preferred for "newest" sorting). */
  added: number;
  /** Runs recorded in the events DB (bounded by retention). */
  calls: number;
  last_used: number | null;
  /** Cost attributed to this skill's runs (bounded by retention). */
  cost_usd: number;
  /** Derived grouping for discovery (e.g. "testing & QA", "PRs & review"). */
  category: string;
  /** The "Use when…" sentence extracted from the description, if present. */
  when_to_use: string | null;
}

export interface StatsSummary {
  totals: {
    events: number;
    sessions: number;
    tool_calls: number;
    errors: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
  };
  by_model: CostByModel[];
  tool_latency: ToolLatencyStat[];
  timeline: TimeBucket[];
  top_skills: SkillUsage[];
  by_app: AppUsage[];
  by_type: TypeCount[];
  /** Event counts by day-of-week × hour (length 168 = 7*24), local time. */
  heatmap: number[];
  window_ms: number;
  /** Wall-clock ms when the server process started — what the header's
   *  uptime counts from. Absent in demo mode, where nothing is "up". */
  server_started_at?: number;
}

/** A tool call held at the gate, awaiting a remote approve/deny. */
export interface PendingGate {
  id: string;
  source_app: string;
  session_id: string;
  tool_name: string;
  summary: string;
  created: number;
}

/** A gate request that has been resolved. `resolution` is who resolved it:
 *  a human from the dashboard, the timeout, or a restart that found the window
 *  already closed. The last one is why this record exists — an outcome nobody
 *  chose is exactly the one that must not disappear. */
export interface GateRecord extends PendingGate {
  expires: number;
  decision: "allow" | "deny";
  reason: string | null;
  resolution: "human" | "timeout" | "restart" | null;
  decided_at: number | null;
}

export interface SearchHit {
  id: number;
  timestamp: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  tool_name: string | null;
  cost_usd: number;
  duration_ms: number | null;
  /** snippet with \x01…\x02 wrapping the matched terms */
  snippet: string;
}

export interface Insight {
  id: string;
  severity: "info" | "warn" | "bad";
  kind: "loop" | "spend" | "errors" | "burn";
  title: string;
  detail: string;
  session: string | null; // "source_app:session8"
  ts: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each begins with " ", "+" or "-"
}
/** One thing that happened in a session, in order — a message or a tool run.
 *
 *  The conversation used to be prompts and assistant replies only, which left
 *  out everything the agent actually *did*: the file it edited, the command it
 *  ran, the search it made. That is most of the work, and without it the panel
 *  can't replace the terminal you'd otherwise read it in. */
export interface TimelineEntry {
  kind: "message" | "tool";
  ts: number;
  /** kind === "message" */
  role?: "user" | "assistant";
  text?: string;
  /** kind === "tool" */
  tool?: string;
  /** What it acted on: a file path, a command, a URL, a query. */
  target?: string | null;
  /** A Bash tool's own description of its intent, when it gave one. */
  note?: string | null;
  is_error?: boolean;
  duration_ms?: number | null;
  /** Links a tool run to its diff in `changes`, so an edit can show what it
   *  changed rather than only that it happened. */
  tool_use_id?: string | null;
  /** Which subagent produced this, when it wasn't the main thread.
   *
   *  Subagent turns report the *parent's* session id, so everything a fleet of
   *  them does lands on one timeline. Without this tag those runs are
   *  indistinguishable from the main thread's, and four agents working in
   *  parallel read as one very busy one. */
  agent_id?: string | null;
  agent_type?: string | null;
  /** What the tool answered, trimmed. Seeing only what an agent *ran* and never
   *  what came back is what still sends you to the terminal — a failing test and
   *  a passing one look identical without it. */
  output?: string | null;
  /** True when `output` is only the head of a longer result, so the UI can say
   *  so instead of implying the command was that quiet. */
  output_clipped?: boolean;
}

export interface SessionDetail {
  session_id: string;
  source_app: string;
  model_name: string | null;
  /** Where it ran — a resume has to start in the same directory. */
  project_path?: string | null;
  /** The linked worktree / subdir it actually ran in, if not the repo root. */
  cwd_path?: string | null;
  /** See SessionRollup — same fields, same precedence. */
  custom_title?: string | null;
  ai_title?: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen: number;
  events: number;
  tools: number;
  errors: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  summary: string | null;
  tool_mix: { tool: string; n: number }[];
  subagents: { agent_id: string; agent_type: string; events: number }[];
  conversation: { role: "user" | "assistant"; text: string; ts: number }[];
  /** Messages and tool runs interleaved in time — what actually happened. */
  timeline: TimelineEntry[];
  changes: FileChange[];
}

export interface FileChange {
  id: number;
  timestamp: number;
  source_app: string;
  session_id: string;
  tool: string;
  file_path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** git ignores this path. The list hides these by default — an agent's edit
   *  to build output is recorded like any other, and on a busy session that
   *  buries the edits worth reviewing. Absent means "not asked" / "unknown",
   *  which is never hidden. */
  ignored?: boolean;
}

/** A tool call the server sees as still running: a PreToolUse with no matching
 *  Post yet, in a session that hasn't stopped. This is the authoritative "what's
 *  open right now" — independent of whether the Pre still lives in the client's
 *  bounded event buffer, which it may not on a busy fleet or after a reload. */
export interface OpenToolCall {
  session_id: string;
  source_app: string;
  tool_name: string;
  since: number; // ms — the PreToolUse timestamp
}

/** WebSocket frames. */
export type WsFrame =
  | { type: "initial"; data: WatchEvent[]; openTools?: OpenToolCall[] }
  | { type: "event"; data: WatchEvent }
  | { type: "session"; data: SessionRollup }
  /** Something mutated a repository. Carries no payload on purpose: the panels
   *  each need a different slice of git state, so they re-read what they show
   *  rather than the server guessing which of them cares about what. */
  | { type: "git" };

// --- commit composer (live git working-tree) ---------------------------------
export interface GitFileStatus {
  path: string; // repo-relative
  code: string; // raw porcelain XY
  staged: boolean;
  unstaged: boolean;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged" | "type-changed";
}
export interface RepoStatus {
  root: string; // absolute repo top-level
  branch: string;
  files: GitFileStatus[];
  suggested: string[]; // repo-relative paths from the request that are currently dirty
}
export interface GitStatusResponse {
  repos: RepoStatus[];
  commitEnabled: boolean;
}
export interface CommitResult {
  ok: boolean;
  sha?: string;
  shortSha?: string;
  summary?: string; // e.g. "3 files, +40 −5"
  error?: string;
}

// --- live git panel (working tree, replacing lazygit) ------------------------
/** A working-tree diff, shaped as a FileChange so the diff renderer is reused. */
export interface GitFileChange extends FileChange {
  status: GitFileStatus["status"];
  staged: boolean;
  binary: boolean;
  oldPath?: string; // absolute, set for renames
}
/** What git is in the middle of. Half the commit operations are unavailable
 *  during any of these, and the useful action becomes continue/abort/skip. */
export type GitTreeState = "clean" | "rebasing" | "merging" | "cherry-picking" | "reverting" | "bisecting";

export interface GitBranchInfo {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  /** Absent on older payloads; treat as "clean". */
  state?: GitTreeState;
  /** The branch this one was cut from — what a PR calls its base. Null on the
   *  trunk itself. Merging it in is "update from base". */
  base?: string | null;
  /** Commits the base has that this branch does not. */
  behindBase?: number;
  /** The tip is an unpushed merge on a clean tree — so it can be undone
   *  exactly, by resetting to its first parent. */
  canUndoMerge?: boolean;
}
export interface WorkingTree {
  root: string;
  branch: GitBranchInfo;
  staged: GitFileChange[];
  unstaged: GitFileChange[]; // modified + untracked (untracked rendered as all-added)
  clean: boolean;
  writeEnabled: boolean;
  error?: string;
}
/** A repo agentglass knows about (from telemetry paths + the server's own cwd). */
export interface GitRepoRef {
  root: string;
  name: string;
  branch: string;
  dirty: number; // count of changed files
  ahead: number;
  behind: number;
  /** Absolute path of the main repo, when this checkout is a *linked worktree*
   *  rather than a project of its own. Set on the per-project lists (where the
   *  worktrees belong and are selectable); the machine-wide picker folds them
   *  into their project instead of listing them. */
  worktreeOf?: string;
  /** How many linked worktrees were folded into this project — what the picker
   *  shows so a dozen hidden checkouts aren't invisible. */
  worktrees?: number;
}
/** One candidate directory from the project picker's path completion. Names and
 *  a `.git` flag only — the completion endpoint never reports files. */
export interface FsEntry {
  name: string;
  path: string;
  repo: boolean;
}
export interface FsCompletion {
  /** Absolute, normalised directory the entries live in. */
  base: string;
  entries: FsEntry[];
  /** More matches existed than were returned — the UI says "keep typing". */
  truncated: boolean;
}
export interface GitActionResult {
  ok: boolean;
  error?: string;
  output?: string;
}
export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  track: string; // raw "[ahead 4, behind 53]" / "[gone]" / ""
  date: string;  // committerdate, relative
  subject: string;
  /** Contained in the repo's trunk (origin/HEAD, or main/master). Absent when
   *  there's no trunk to compare against — which is not the same as false.
   *
   *  This, not `git branch -d`, is the real "was it merged?": `-d` compares
   *  against whatever is checked out, so from a worktree on a ticket branch
   *  every merged PR looks unmerged. */
  mergedIntoTrunk?: boolean;
}
export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string; // relative, e.g. "3 hours ago"
  refs: string; // decorations
}
/** One rendered row of `git log --graph`: the graph glyphs, plus commit fields
 *  when the row is a commit (graph-only connector rows have no hash). */
export interface GitGraphLine {
  graph: string;
  hash?: string;
  author?: string;
  date?: string;
  subject?: string;
  refs?: string;
}
export interface GitStash {
  index: number;
  ref: string; // stash@{N}
  message: string;
}
/** One git command the server ran — the command log panel's row. */
export interface GitLogEntry {
  id: number;
  at: number;
  cwd: string;
  args: string[];
  exitCode: number;
  ms: number;
  /** Can it change the repository? The panel shows only these by default. */
  write: boolean;
  error?: string;
}
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** Branches on this remote, as short names ("main"), without the remote prefix. */
  branches: number;
}
export interface GitTag {
  name: string;
  /** Annotated tags carry their own message; lightweight ones borrow the commit's. */
  subject: string;
  date: string;
  hash: string;
  annotated: boolean;
}
/** A reflog entry. Unlike a commit these are *local history* — where HEAD has
 *  been — which is what makes them the undo trail after a bad reset or rebase. */
export interface GitReflogEntry {
  ref: string;      // HEAD@{3}
  shortHash: string;
  action: string;   // "commit", "rebase (finish)", "reset"
  subject: string;
  date: string;
}
export interface GitWorktree {
  path: string;    // absolute
  branch: string;  // branch short name, or "(detached)"
  head: string;    // short sha
  current: boolean;
  bare: boolean;
  locked: boolean;
  /** The branch this one was cut from — trunk unless overridden per branch.
   *  Null on the trunk checkout itself, which has no base. */
  base?: string | null;
  /** Commits the base has that this checkout does not. */
  behindBase?: number;
}

// --- live docker panel (lazydocker replacement) ------------------------------
export interface DockerContainer {
  id: string;        // short id
  name: string;
  image: string;
  state: string;     // running | exited | paused | created | restarting | dead
  status: string;    // "Up 4 hours" / "Exited (0) 2 hours ago"
  ports: string;
  project: string | null; // compose project
  service: string | null; // compose service
  runningFor: string;
  size: string;
}
export interface DockerStat {
  id: string;
  cpu: number;       // percent
  mem: number;       // percent
  memUsage: string;
  netIO: string;
  blockIO: string;
  pids: number;
}
export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;   // "5 hours ago"
  containers: string;
  dangling: boolean;
}
export interface DockerVolume { name: string; driver: string; }
export interface DockerNetwork { id: string; name: string; driver: string; scope: string; }
/** Present only when the cockpit is open for one project, so the panel can say
 *  which slice of the host it is showing — and admit when the filter found
 *  nothing and fell back to the whole machine. */
export interface DockerScope {
  workspace: string;   // the open project's directory
  project: string;     // compose project name derived from it
  matched: number;     // containers that belong to it
  showingAll: boolean; // nothing matched, so every container is listed instead
}
export interface DockerOverview {
  available: boolean;
  writeEnabled: boolean;
  version: string | null;
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  scope?: DockerScope;
  error?: string;
}
export interface DockerActionResult { ok: boolean; error?: string; output?: string; }

// --- LLM walkthrough (AI-authored review itinerary) --------------------------
export interface WalkthroughInputFile {
  path: string;
  tool?: string;
  additions?: number;
  deletions?: number;
  patch?: string; // unified diff text (source of truth stays the telemetry/git diff)
}
export interface WalkthroughFile {
  path: string;
  description: string; // one-line, LLM-authored
  tag: string; // feature | fix | refactor | test | docs | config | style | chore
}
export interface WalkthroughResult {
  available: boolean;
  reviewFocus: string;
  files: WalkthroughFile[];
  error?: string;
}

// --- chat attachments (images pasted into the composer) ----------------------
/** An image attached to a chat turn, carried inline as base64.
 *
 *  The browser has no path the server could read, so the bytes travel in the
 *  JSON body rather than as a file reference. `data` is unpadded-or-padded
 *  standard base64 with no `data:` URI prefix — the server strips the prefix on
 *  the way in so the field holds only what a Claude image block wants. */
export interface ChatImage {
  mediaType: ChatImageMediaType;
  data: string; // base64, no `data:image/png;base64,` prefix
}
/** The media types a chat attachment may declare. This mirrors the set the
 *  `claude` CLI itself accepts for image blocks, so anything outside it would be
 *  rejected downstream anyway. */
export type ChatImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

// --- in-browser terminal (real PTY shell per repo/worktree) ------------------
/** A ready-to-run project command surfaced in the terminal panel. */
export interface ProjectCommand {
  name: string; // target/script name
  cmd: string;  // exact command to run, e.g. "make test" / "bun run dev"
  desc: string; // what it does — from `## comment`, `# comment` above, or the script body
  dir: string;  // repo-relative folder the Makefile/package.json lives in ("" = repo root)
}
export interface TerminalCommands {
  enabled: boolean; // AGENTGLASS_TERMINAL_DISABLED gate
  make: ProjectCommand[];    // Makefile targets, with descriptions
  scripts: ProjectCommand[]; // package.json scripts, runner-aware
}

/** One `<<<<<<< / ======= / >>>>>>>` region of a conflicted file. */
export type ConflictBlock = {
  index: number;
  /** 1-based line the `<<<<<<<` sits on. */
  line: number;
  ours: string[];
  theirs: string[];
  /** Only with merge.conflictStyle=diff3/zdiff3. */
  base?: string[];
  ourLabel: string;
  theirLabel: string;
};

/** What to write for one block. `both` keeps ours then theirs. */
export type BlockChoice = "ours" | "theirs" | "both" | "theirs-first";

/** What the installed app was built from, and what is waiting upstream. */
export type UpdateStatus = {
  ok: boolean;
  available: boolean;
  info: {
    version: string;
    commit: string;
    builtAt: string;
    source: string;
    /** Remote the updater clones from. */
    origin: string;
    /** Nearest release this build descends from, and how far past it — this,
     *  not `version`, is what decides whether a published tag is newer. */
    baseTag: string;
    distance: number;
  };
  branch: string;
  behind: number;
  ahead: number;
  incoming: { sha: string; subject: string }[];
  blocked?: string;
  last?: { at: string; ok: boolean; tail: string };
};
