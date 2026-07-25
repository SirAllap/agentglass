import type { ControlCmd } from "../../../shared/types.ts";

/**
 * A control command for the chat view, held until the chat view exists to run it.
 *
 * Every other `ControlCmd` lands on App, which owns the state it changes, so
 * `controlBus` can hand it over and forget it. A chat command can't work that
 * way: the panel is mounted only while the workspace is open, and the natural
 * command — "start a new chat" — is exactly the one you send when it *isn't*.
 * Subscribing from the panel would drop those, because App opens the workspace
 * and the panel's subscription only exists a render later.
 *
 * So this is a one-slot mailbox instead of a bus. App latches the command and
 * opens the view; the panel drains it on mount and on every bump after that,
 * which covers both orderings with no timing assumption. One slot, not a queue:
 * these are "do this now" verbs from a physical button, and a backlog of them
 * replayed on mount is worse than the newest one winning.
 */
export type ChatIntent = Extract<ControlCmd, { cmd: "chat" }>["do"];

/**
 * How long a latched command stays worth running.
 *
 * /control broadcasts to every client, so a press also lands on tabs with the
 * workspace shut, where nothing drains it and no unmount clears it. Without a
 * limit that command waits indefinitely and fires the next time the chat view
 * mounts for some unrelated reason. A button pressed half an hour ago is not a
 * request for a chat now, so let it lapse rather than surprise someone.
 *
 * Long enough to cover the panel opening and waiting on its repo list, which is
 * the whole reason the mailbox exists.
 */
const TTL_MS = 30_000;

let pending: { intent: ChatIntent; at: number } | null = null;
const subs = new Set<() => void>();

export function latchChatIntent(intent: ChatIntent): void {
  pending = { intent, at: Date.now() };
  for (const fn of subs) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

function fresh(): ChatIntent | null {
  if (!pending) return null;
  if (Date.now() - pending.at > TTL_MS) { pending = null; return null; }
  return pending.intent;
}

/** Read and clear. Returns null when there is nothing waiting. */
export function takeChatIntent(): ChatIntent | null {
  const p = fresh();
  pending = null;
  return p;
}

/**
 * Read without clearing, so a caller can stand aside for a command it isn't the
 * one to run. Shares `fresh` with `takeChatIntent` deliberately: a peek that
 * outlived a take would have callers deferring to a command that never runs.
 */
export function peekChatIntent(): ChatIntent | null {
  return fresh();
}

export function subscribeChatIntent(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
