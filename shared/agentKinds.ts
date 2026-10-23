/*
 * The agent CLIs this app can start, and how each one takes a prompt.
 *
 * ── why a table ──────────────────────────────────────────────────────────
 * Because the phone's "new tab" menu offers a choice, and a menu that offers
 * four things and can only start one is worse than a menu with one thing on
 * it: the other three fail after the window has already opened, which is a
 * blank pane on somebody's machine rather than an error on their screen.
 *
 * Everything here is data. `server/src/agentticket.ts` turns a row into an
 * argv, the phone reads the same rows to draw the list, and the two cannot
 * disagree because there is one table.
 *
 * ── one table for every place that says "which agent" ────────────────────
 * It used to be four: this menu, the chat panel's roster in
 * web/src/lib/agents.ts, the requirements panel's ROSTER in
 * server/src/agentprobe.ts, and a run leg's SPELLINGS in
 * server/src/agents/launch.ts. They disagreed — the menu had OpenCode and not
 * Antigravity, the roster the other way round, the chat panel neither Gemini
 * nor OpenCode — and adding a CLI meant finding all four. Now a provider is one
 * row, and each of those places is a facet of it: `tab` for this menu,
 * `probe` for the roster, `run` for a run's legs, `chat` for the chat panel.
 * A row without a facet is simply not offered there, which is the same
 * membership each list had before.
 *
 * ── where the flags come from ────────────────────────────────────────────
 * Read off Orca's own launcher (stablyai/orca, MIT — src/shared/
 * tui-agent-config.ts and tui-agent-startup.ts), which drives the same four
 * CLIs and has the flags for each written down and tested. Guessing them was
 * the alternative, and a guessed flag does not fail loudly: the CLI starts,
 * ignores it, and sits at an empty prompt with the work nobody asked it to do
 * still in the phone's hand.
 *
 * ── and why `detect` is separate from `bin` ──────────────────────────────
 * They differ. Antigravity's binary is `agy` while everything a person reads
 * calls it Antigravity, and `server/src/paneloc.ts` already recognises a
 * running one by its process name.
 */

/** How a prompt reaches the CLI on its command line. */
export type PromptMode =
  /** Last positional argument: `claude "do the thing"`. */
  | "argv"
  /** `--prompt "do the thing"`. */
  | "flag"
  /** `--prompt-interactive "do the thing"` — starts the TUI with it seeded
   *  rather than answering once and exiting. */
  | "flag-interactive";

export interface AgentKind {
  /** What the wire carries, and what a phone sends. */
  id: string;
  /** On the menu. */
  title: string;
  /** One line under it: what picking this actually means. */
  what: string;
  /** The executable. */
  bin: string;
  mode: PromptMode;
  /** The flag that skips permission prompts, where the CLI has one. Absent
   *  means it has none, and a phone must not offer the choice for it. */
  yoloFlag?: string;
  /** The flag that names a session before its first turn, where supported. */
  nameFlag?: string;
}

/** How a run leg spells a CLI's words when a window opens running it —
 *  see server/src/agents/launch.ts. */
export interface RunSpelling {
  /**
   * The single flag that turns permission prompts off.
   *
   * One flag, and it is the server's word rather than the client's — the same
   * rule agentticket.ts states: a socket reachable from the UI sends a boolean
   * and never an argument.
   */
  bypass: string;
  /**
   * The flag that carries the prompt when a bare positional argument would run
   * the CLI headlessly instead of opening it.
   *
   * Empty means positional, which is Claude Code's form, Codex's, and what
   * every path in this server did before this file existed. It is also the
   * FALLBACK when the flag below cannot be confirmed on this machine, and that
   * is deliberate: a flag we can prove is an improvement on the shipped
   * behaviour, and a flag we cannot prove must degrade back to it rather than
   * to some third thing nobody has run.
   */
  promptFlag: string;
}

/** How the requirements panel finds and connects a CLI — see
 *  server/src/agentprobe.ts. `KnownAgent` in shared/types.ts is what it
 *  becomes on the wire. */
export interface ProbeFacet {
  /** The roster's own id, where it predates this table and differs from the
   *  row's: runs and the connect route carry it, so it cannot be renamed. */
  id?: string;
  label: string;
  via: "hooks" | "otel" | "chat";
  /** The file connecting it writes, relative to the agent's home. Empty for a
   *  CLI with nothing to connect; unused for `hooks`, which the hook installer
   *  resolves because it honours CLAUDE_CONFIG_DIR. */
  configPath: string;
  /** A fragment of the `source_app` its events arrive under. */
  match: string;
  install: string;
  connects: string;
}

/** Everything that differs between the CLIs the chat panel drives — the
 *  comments on each field are on `AgentSpec` in web/src/lib/agents.ts. */
export interface ChatFacet {
  label: string;
  defaultModel: string;
  defaultMode: string;
  bypassMode: string;
  canAttach: boolean;
  hasTranscript: boolean;
  hasEffort: boolean;
  canPane: boolean;
}

/**
 * How a CLI is told, from outside, which commands it may not run — the
 * provider-side half of a worker role's lock (shared/workerRoles.ts renders
 * the rules). Each is a layer ABOVE the person's own config, measured or
 * documented as such, because a lock the project's own file can loosen is not
 * one:
 *
 *   flag  a command-line flag carrying the settings as JSON. Claude Code's
 *         `--settings`; its deny rules are unioned across every scope and win
 *         over any allow.
 *   env   an environment variable carrying a config as JSON. OpenCode's
 *         `OPENCODE_CONFIG_CONTENT`, merged over the global and project files.
 *         OpenCode decides by the LAST rule that matches, and an agent's own
 *         rules come after the top-level ones — so a project that allowed
 *         `git push *` on its `build` agent, or made a permissive agent its
 *         `default_agent`, undid a top-level-only lock (measured on 1.18.31,
 *         `opencode debug agent build`). The rules therefore go on the `build`
 *         agent too, `default_agent` is pinned to it, and `task` is denied so
 *         no other agent is reached as a subagent; a role refuses `--agent`.
 *         That is still a merge, not a layer on top: a project key the lock
 *         reuses keeps the project's place, so a broader allow the project
 *         wrote after it wins. A role start therefore asks OpenCode for the
 *         merged rules in that directory and refuses when the lock no longer
 *         wins (`openCodeLockLoosened` in server/src/agentops.ts).
 *   file  an environment variable naming a settings file. Qwen Code's
 *         `QWEN_CODE_SYSTEM_SETTINGS_PATH`: the system scope, which its own
 *         docs say users cannot shrink, and whose `permissions.deny` has the
 *         highest priority.
 *
 * Absent means no way is known, and a role refuses to run on that CLI rather
 * than run it unlocked. Codex has no per-command deny, only a sandbox; the
 * Gemini CLI has one but it has not been run here.
 */
export type LockSpelling =
  | { via: "flag"; flag: string }
  | { via: "env"; env: string }
  | { via: "file"; env: string };

/*
 * What an orchestrator needs to know about an engine before it hands it work.
 * Four facets, each one a fact read off the CLI itself (research notes, laptop
 * and desktop, 2026-10-10) and nothing inferred:
 *
 *   version   how to ask for it, how to pick it out of the banner, and the
 *             oldest one agentglass can drive
 *   account   the CLI's own read-only status command, and what it prints when
 *             someone is signed in. Names only: agentglass never opens a
 *             credential file, it asks the CLI
 *   headless  which argv builder runs one turn without a terminal, and how a
 *             follow-up turn names its session
 *   envelope  how a worker's permissions are fixed BEFORE its turn
 *   screen    what a TUI chair's pane says when it is waiting on a person
 *
 * A facet that is absent means nobody has seen that CLI do it. That is the
 * point of leaving it out rather than filling it from memory: Gemini and
 * Antigravity are not installed on the machines this was measured on, so they
 * carry what the repo's own code says and no more, and Qwen carries nothing
 * beyond its `--version`.
 */

/** Ask a CLI for its version, and read it out of what it prints. */
export interface VersionFacet {
  args: string[];
  /** A regex source whose FIRST capture group is the dotted version. */
  pattern: string;
  /** The oldest version agentglass can drive, and what the newer one has. */
  min?: string;
  minWhy?: string;
}

/** The CLI's read-only "who am I" command. */
export interface AccountFacet {
  args: string[];
  /** A regex source that matches the output when someone is signed in. */
  signedIn: string;
  /** The CLI works without an account (a free catalogue), so a miss is not a
   *  reason to refuse it. */
  optional?: boolean;
}

/** Which of the server's argv builders runs one turn of this engine. */
export interface HeadlessFacet {
  argv: "claude" | "codex" | "antigravity" | "hermes" | "opencode" | "gemini";
  /** What follows the binary on a one-shot turn, with placeholders in angle
   *  brackets: shown on the Agent engines page as "the command agentglass
   *  runs", so a person reads what a worker will be started with. */
  form: string;
  /** The words that name an earlier session on a follow-up turn, as they come
   *  before the id: "--resume" for a flag, "exec resume" for a subcommand. */
  resume: string;
  /** The flags that stop a turn by themselves, where the CLI has them. */
  ceilings?: { turns?: string; seconds?: string; usd?: string };
}

/** How a worker's permissions are decided before it starts.
 *
 *    settings-flag  a settings file passed on the command line (Claude Code)
 *    config-env     a config in an environment variable or a file one names
 *                   (OpenCode, Qwen Code)
 *    sandbox-flags  a sandbox and an approval policy, no per-command list
 *                   (Codex)
 *    own-config     the person's own config; agentglass only checks it
 *                   (Hermes) */
export interface EnvelopeFacet {
  via: "settings-flag" | "config-env" | "sandbox-flags" | "own-config";
  /** For `own-config`: the argv that says whether the deny list holds, and the
   *  exit code that means it does. */
  check?: { args: string[]; exit: number };
}

/** What a TUI's pane says when it is waiting for a person or working. Regex
 *  sources, matched against the captured screen. */
export interface ScreenFacet {
  needsYou: string;
  running: string;
}

export interface Provider extends AgentKind {
  /** On the new-tab menu, and accepted wherever a route validates a kind. */
  tab: boolean;
  /** The flag that picks a model, where a worker role may set one. */
  modelFlag?: string;
  lock?: LockSpelling;
  probe?: ProbeFacet;
  run?: RunSpelling;
  chat?: ChatFacet;
  version?: VersionFacet;
  account?: AccountFacet;
  headless?: HeadlessFacet;
  envelope?: EnvelopeFacet;
  screen?: ScreenFacet;
}

/**
 * Every CLI this app knows, in the order the menu draws them.
 *
 * Claude is first because it is the one this app is built around — the review
 * prompts, the gates and the hook wiring are all its. The rest are alphabetical
 * rather than ranked: preferring one of somebody else's CLIs over another is
 * not this app's opinion to have.
 *
 * `yoloFlag` and `run.bypass` are not the same fact and are deliberately not
 * merged. `yoloFlag` is what the phone may offer, and only Claude's has been
 * offered; `run.bypass` is what a run leg passes after `--help` confirms it.
 * Folding one into the other would quietly start honouring the phone's switch
 * for three CLIs that have never had it.
 */
export const AGENT_PROVIDERS: Provider[] = [
  {
    id: "claude",
    title: "Claude Code",
    what: "The one the gates, the review prompts and the hooks are built around.",
    bin: "claude",
    mode: "argv",
    yoloFlag: "--dangerously-skip-permissions",
    nameFlag: "--name",
    tab: true,
    modelFlag: "--model",
    lock: { via: "flag", flag: "--settings" },
    probe: {
      id: "claude-code",
      label: "Claude Code",
      via: "hooks",
      configPath: "",
      match: "claude",
      install: "npm i -g @anthropic-ai/claude-code",
      connects: "hooks that post each event to this server",
    },
    run: { bypass: "--dangerously-skip-permissions", promptFlag: "" },
    version: { args: ["--version"], pattern: "^(\\d+\\.\\d+\\.\\d+)" },
    account: { args: ["auth", "status"], signedIn: '"loggedIn":\\s*true' },
    headless: { argv: "claude", form: '-p "<prompt>" --output-format stream-json --model <model> --settings <lock>', resume: "--resume", ceilings: { usd: "--max-budget-usd" } },
    envelope: { via: "settings-flag" },
    // Keep in step with NEEDS_YOU_RE and RUNNING_RE in server/src/chatpane.ts;
    // a test holds the two to the same screens.
    screen: { needsYou: "Esc to cancel|Enter to confirm|to use this session only", running: "esc to interrupt" },
    chat: {
      label: "Claude",
      defaultModel: "claude-opus-5", defaultMode: "default",
      bypassMode: "bypassPermissions", canAttach: true, hasTranscript: true,
      hasEffort: true, canPane: true,
    },
  },
  {
    // Google's agentic CLI, and a separate product from the Gemini CLI below —
    // separate binary, separate state, and a model list that spans Anthropic
    // and open-weight models as well as Google's. Wiring one does nothing for
    // the other. Not on the tab menu: nothing has launched it in a pane yet.
    id: "antigravity",
    title: "Antigravity",
    what: "Google's agentic CLI, driven by the chat panel.",
    bin: "agy",
    mode: "argv",
    tab: false,
    probe: {
      label: "Google Antigravity",
      via: "chat",
      // It keeps state under ~/.gemini/antigravity-cli, but nothing there is a
      // connection this app writes or reads, so there is no path worth showing.
      configPath: "",
      match: "antigravity",
      install: "https://antigravity.google/docs/cli",
      connects: "the chat panel, which turns its own turns into events",
    },
    // antigravity.ts:antigravityArgs, same spelling as Claude's by that CLI's
    // own choice. Its `-p` is the print-and-exit form the chat panel drives and
    // is deliberately NOT the prompt flag: a run's leg through it would answer
    // once and close the window.
    run: { bypass: "--dangerously-skip-permissions", promptFlag: "" },
    // Repo facts only (antigravity.ts); the CLI is not installed where this was
    // measured, so there is no account command and no envelope to state.
    version: { args: ["--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    headless: { argv: "antigravity", form: '-p "<prompt>" --output-format stream-json --model <model>', resume: "--conversation" },
    chat: {
      // Its four modes happen to line up with Claude's, which is a property of
      // the CLI rather than a mapping imposed here. Keep in step with
      // DEFAULT_MODE in server/src/antigravity.ts.
      label: "Antigravity",
      defaultModel: "gemini-3.6-flash-medium", defaultMode: "request-review",
      bypassMode: "always-proceed", canAttach: false, hasTranscript: false,
      hasEffort: false, canPane: false,
    },
  },
  {
    // Nous Research's agent CLI. Stream-first chat panel only — no pane engine,
    // no phone tab, no ACP. Not on the tab menu: nothing has launched it in a
    // pane yet, and the thin path is deliberately Antigravity-shaped.
    id: "hermes",
    title: "Hermes",
    what: "Nous Research agent CLI, driven by the chat panel.",
    bin: "hermes",
    mode: "flag", // prompt via --query=<text>
    tab: false,
    probe: {
      label: "Hermes Agent",
      via: "chat",
      configPath: "", // do not write ~/.hermes/config.yaml from the browser
      match: "hermes",
      install: "https://hermes-agent.nousresearch.com/docs/",
      connects: "the chat panel, which turns its own turns into events",
    },
    // 0.21.4 is the first with `chat --format stream-json` (docs/CONFIG.md);
    // 0.21.0 exits on the unknown flag. The deny list is the person's own
    // `approvals.deny`: `hermes approvals test -- git push` exits 3 when it
    // holds (measured headless on 0.21.5, where the refusal reaches the model).
    version: {
      args: ["--version"], pattern: "Hermes Agent v(\\d+\\.\\d+\\.\\d+)",
      min: "0.21.4", minWhy: "it is the first with the output format agentglass reads",
    },
    account: { args: ["status"], signedIn: "✓ logged in" },
    headless: { argv: "hermes", form: "chat --query=<prompt> --format stream-json --no-restore-cwd --max-turns <n>", resume: "--resume", ceilings: { turns: "--max-turns", seconds: "--run-budget" } },
    envelope: { via: "own-config", check: { args: ["approvals", "test", "--", "git", "push", "origin", "main"], exit: 3 } },
    chat: {
      label: "Hermes",
      // Fallback when config.yaml is unread; /hermes/enabled prefers the
      // configured model.default. Keep in step with FALLBACK in hermes.ts.
      defaultModel: "anthropic/claude-sonnet-4",
      defaultMode: "default",       // Hermes vocabulary — no extra flag
      bypassMode: "yolo",           // maps to --yolo when chatBypassAllowed
      canAttach: false,
      hasTranscript: false,         // no /hermes/transcript until export is measured
      hasEffort: false,
      canPane: false,
    },
  },
  {
    id: "codex",
    title: "Codex",
    what: "OpenAI's CLI, in a pane of its own.",
    bin: "codex",
    mode: "argv",
    tab: true,
    probe: {
      label: "OpenAI Codex CLI",
      via: "otel",
      configPath: ".codex/config.toml",
      match: "codex",
      install: "npm i -g @openai/codex",
      connects: "OpenTelemetry logs → /v1/logs",
    },
    // codex.ts:codexArgs, where the same flag drives the `full-access` sandbox.
    // The interactive form takes the prompt as a positional; `codex exec --json`
    // is the streaming form the chat panel drives and would fill a tmux pane
    // with JSON instead of a TUI.
    run: { bypass: "--dangerously-bypass-approvals-and-sandbox", promptFlag: "" },
    version: { args: ["--version"], pattern: "codex-cli (\\d+\\.\\d+\\.\\d+)" },
    account: { args: ["login", "status"], signedIn: "^Logged in" },
    // `-a` is a flag of `codex` itself, before `exec`; `codex exec -a` is refused.
    headless: { argv: "codex", form: 'exec --json -s <sandbox> "<prompt>"', resume: "exec resume" },
    envelope: { via: "sandbox-flags" },
    chat: {
      // The mode is its sandbox rather than a permission policy, so the two
      // vocabularies stay apart. Keep in step with DEFAULT_SANDBOX in
      // server/src/codex.ts.
      label: "Codex",
      defaultModel: "gpt-5.6-sol", defaultMode: "read-only",
      bypassMode: "full-access", canAttach: false, hasTranscript: true,
      hasEffort: false, canPane: false,
    },
  },
  {
    id: "gemini",
    title: "Gemini",
    what: "Google's CLI. Opens with the prompt seeded rather than answered.",
    bin: "gemini",
    mode: "flag-interactive",
    tab: true,
    probe: {
      label: "Gemini CLI",
      via: "otel",
      configPath: ".gemini/settings.json",
      match: "gemini",
      install: "npm i -g @google/gemini-cli",
      connects: "OpenTelemetry traces → /v1/traces",
    },
    // A bare positional is answered non-interactively and the CLI exits, so the
    // prompt goes through the flag that keeps the TUI up. Both words are probed
    // before they are used — this is the entry with the least evidence behind
    // it, and the probe is what makes that safe rather than hopeful.
    version: { args: ["--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    run: { bypass: "--yolo", promptFlag: "-i" },
  },
  {
    id: "opencode",
    title: "OpenCode",
    what: "Takes the prompt on a flag and picks its own model.",
    bin: "opencode",
    mode: "flag",
    tab: true,
    modelFlag: "--model",
    version: { args: ["--version"], pattern: "^(\\d+\\.\\d+\\.\\d+)" },
    // Its free catalogue answers with no credential (measured on 1.18.32), so
    // an empty list of providers is not "signed out".
    account: { args: ["providers", "list"], signedIn: "[1-9]\\d* credentials?", optional: true },
    headless: { argv: "opencode", form: 'run --format json -m <provider/model> "<prompt>"', resume: "-s" },
    envelope: { via: "config-env" },
    lock: { via: "env", env: "OPENCODE_CONFIG_CONTENT" },
  },
  {
    // A fork of the Gemini CLI, and it kept that CLI's command line: a bare
    // positional answers once and exits, `--prompt-interactive` opens the TUI
    // with the prompt seeded. Tab menu only — it has no connection this app
    // has measured, so it is not on the requirements roster or a run's legs.
    id: "qwen",
    title: "Qwen Code",
    what: "Qwen's CLI. Opens with the prompt seeded rather than answered.",
    bin: "qwen",
    mode: "flag-interactive",
    tab: true,
    modelFlag: "--model",
    version: { args: ["--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    envelope: { via: "config-env" },
    lock: { via: "file", env: "QWEN_CODE_SYSTEM_SETTINGS_PATH" },
  },
];

export const agentProvider = (id: string): Provider | undefined =>
  AGENT_PROVIDERS.find((p) => p.id === id);

/** The new-tab menu: the rows a phone may start, in the order it draws them. */
export const AGENT_KINDS: AgentKind[] = AGENT_PROVIDERS.filter((p) => p.tab);

export const agentKind = (id: string): AgentKind | undefined =>
  AGENT_KINDS.find((a) => a.id === id);

/** The engines the Agent engines page and the orchestration policy know, in the
 *  order they are shown (Qwen Code is a worker lock target only). */
export const ENGINE_IDS = ["claude", "codex", "antigravity", "gemini", "hermes", "opencode"] as const;

export const engineProviders = (): Provider[] =>
  ENGINE_IDS.map((id) => AGENT_PROVIDERS.find((p) => p.id === id)).filter((p): p is Provider => !!p);
