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

export interface Provider extends AgentKind {
  /** On the new-tab menu, and accepted wherever a route validates a kind. */
  tab: boolean;
  /** The flag that picks a model, where a worker role may set one. */
  modelFlag?: string;
  lock?: LockSpelling;
  probe?: ProbeFacet;
  run?: RunSpelling;
  chat?: ChatFacet;
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
    lock: { via: "file", env: "QWEN_CODE_SYSTEM_SETTINGS_PATH" },
  },
];

export const agentProvider = (id: string): Provider | undefined =>
  AGENT_PROVIDERS.find((p) => p.id === id);

/** The new-tab menu: the rows a phone may start, in the order it draws them. */
export const AGENT_KINDS: AgentKind[] = AGENT_PROVIDERS.filter((p) => p.tab);

export const agentKind = (id: string): AgentKind | undefined =>
  AGENT_KINDS.find((a) => a.id === id);
