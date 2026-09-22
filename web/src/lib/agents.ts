// Which CLIs the chat panel can drive, and everything that differs between
// them.
//
// Its own module rather than a corner of chatStore.ts because chatPersist.ts
// needs it too, and importing it from the store would put a cycle between the
// two — one that happens to work today only because of the order two lines
// appear in. This is the thing both of them depend on, so it sits below both.

import { provider } from "../../../shared/agentKinds.ts";

/**
 * Which CLI is behind a conversation.
 *
 * A chat is bound to one for life. All three are driven the same way — spawn
 * the binary non-interactively, stream its JSONL back — and all three land in
 * the same `ChatMsg` / `ChatTool` shapes, which is what lets the panel render
 * any of them without knowing. What it changes is the endpoint, the model list,
 * and what the mode dropdown even means, so it is settled when the chat is
 * opened rather than switchable mid-thread: a resume id belongs to the CLI that
 * minted it, and there is no such thing as handing a thread from one to
 * another.
 */
export type AgentKind = "claude" | "codex" | "antigravity";

/**
 * Everything that differs between the CLIs, in one table.
 *
 * This was a run of `agent === "codex" ? … : …` ternaries scattered across the
 * store and the panel, which worked while there were two agents and multiplies
 * badly at three: each new CLI meant finding every branch again, and a missed
 * one is silent — a Claude default quietly applied to something that is not
 * Claude. A lookup makes the next agent an entry rather than a search.
 */
export type AgentSpec = {
  /** What to call it in the UI. */
  label: string;
  /** The binary, as it appears in "no local `x` CLI" and the footer line. */
  cli: string;
  defaultModel: string;
  defaultMode: string;
  /** The unattended mode — the one the server refuses to honour unless the
   *  operator opted in. One name for three spellings, so the mode dropdown and
   *  the warnings do not each need the branch. */
  bypassMode: string;
  /** Whether this CLI takes pasted or dropped images. Only Claude does: the
   *  other two take images as file paths, so there is nowhere for pasted bytes
   *  to go without staging them on disk first. */
  canAttach: boolean;
  /** Whether a resumed chat can have its history replayed from disk. Claude's
   *  is in this app's own store and Codex keeps a JSONL rollout; Antigravity
   *  keeps protobuf blobs inside SQLite, which is not something to guess at. */
  hasTranscript: boolean;
  /** Whether the effort dial does anything. `--effort` is Claude's flag. Codex
   *  has a `reasoning.effort` of its own and Antigravity has nothing like it,
   *  so this is "the dial as it exists today applies", not "this CLI cannot
   *  think harder" — mapping the dial per agent is its own piece of work. */
  hasEffort: boolean;
  /** Whether this CLI can run in a tmux pane. Only Claude: the pane engine
   *  attaches to `claude` interactively, and the other two are always the
   *  streamed subprocess. Without this the engine preference leaks across —
   *  a Codex chat would offer to copy an attach command for a pane that is
   *  never opened. */
  canPane: boolean;
};

/**
 * The rows themselves are the `chat` facet of shared/agentKinds.ts — one table
 * for every place that asks "which CLI", so the chat panel's roster cannot
 * drift from the tab menu's or the requirements panel's again. What this file
 * adds is the closed type the store narrows to, and the binary under `cli`.
 *
 * A row that loses its `chat` facet fails here, at load, rather than as a
 * chat that silently gets Claude's defaults; a test pins that every one of
 * the three is there.
 */
function chatSpec(id: AgentKind): AgentSpec {
  const row = provider(id);
  if (!row?.chat) throw new Error(`shared/agentKinds.ts has no chat facet for ${id}`);
  return { ...row.chat, cli: row.bin };
}

export const AGENTS: Record<AgentKind, AgentSpec> = {
  claude: chatSpec("claude"),
  codex: chatSpec("codex"),
  antigravity: chatSpec("antigravity"),
};

export const DEFAULT_MODEL = AGENTS.claude.defaultModel;
export const DEFAULT_MODE = AGENTS.claude.defaultMode;
/** Codex's counterparts. The mode is its sandbox rather than a permission
 *  policy, so the two vocabularies stay apart. */
export const DEFAULT_CODEX_MODEL = AGENTS.codex.defaultModel;
export const DEFAULT_CODEX_MODE = AGENTS.codex.defaultMode;
/** Antigravity's. */
export const DEFAULT_ANTIGRAVITY_MODEL = AGENTS.antigravity.defaultModel;
export const DEFAULT_ANTIGRAVITY_MODE = AGENTS.antigravity.defaultMode;

/** Narrow an untrusted string to an agent. Anything unrecognised is Claude:
 *  everything written down before chats had a second agent was a Claude chat,
 *  so a missing field is an older payload saying what it knew rather than
 *  corruption — and it is the recoverable direction either way. */
export const asAgent = (v: unknown): AgentKind =>
  v === "codex" || v === "antigravity" ? v : "claude";
