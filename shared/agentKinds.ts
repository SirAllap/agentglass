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

/**
 * In the order the menu draws them.
 *
 * Claude is first because it is the one this app is built around — the review
 * prompts, the gates and the hook wiring are all its. The rest are alphabetical
 * rather than ranked: preferring one of somebody else's CLIs over another is
 * not this app's opinion to have.
 */
export const AGENT_KINDS: AgentKind[] = [
  {
    id: "claude",
    title: "Claude Code",
    what: "The one the gates, the review prompts and the hooks are built around.",
    bin: "claude",
    mode: "argv",
    yoloFlag: "--dangerously-skip-permissions",
    nameFlag: "--name",
  },
  {
    id: "codex",
    title: "Codex",
    what: "OpenAI's CLI, in a pane of its own.",
    bin: "codex",
    mode: "argv",
  },
  {
    id: "gemini",
    title: "Gemini",
    what: "Google's CLI. Opens with the prompt seeded rather than answered.",
    bin: "gemini",
    mode: "flag-interactive",
  },
  {
    id: "opencode",
    title: "OpenCode",
    what: "Takes the prompt on a flag and picks its own model.",
    bin: "opencode",
    mode: "flag",
  },
];

export const agentKind = (id: string): AgentKind | undefined =>
  AGENT_KINDS.find((a) => a.id === id);
