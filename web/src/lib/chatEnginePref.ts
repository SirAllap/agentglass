// Which engine a NEW chat starts on.
//
// Only new ones: an existing chat keeps whatever it was created with, because
// the engine decides where the session lives. Flipping a running chat from a
// tmux pane to `claude -p` would leave a warm CLI behind with nothing pointing
// at it, and flipping the other way would strand the conversation that is
// already mid-flight. Per chat is where the switch belongs; this is only the
// default it inherits.
import type { ChatEngine } from "../../../shared/types.ts";

export const CHAT_ENGINE_KEY = "agentglass.chat.engine";

/** `null` means "whatever the server's default is" — the honest third state.
 *
 *  It exists so the setting can be left alone: the server decides via
 *  AGENTGLASS_CHAT_ENGINE, and an operator who set that should not have it
 *  quietly overridden by a browser that has never been told otherwise. */
export type ChatEnginePref = ChatEngine | null;

export function chatEnginePref(): ChatEnginePref {
  try {
    const v = localStorage.getItem(CHAT_ENGINE_KEY);
    return v === "tmux" || v === "process" ? v : null;
  } catch { return null; }
}

export function setChatEnginePref(p: ChatEnginePref): void {
  try {
    if (p === null) localStorage.removeItem(CHAT_ENGINE_KEY);
    else localStorage.setItem(CHAT_ENGINE_KEY, p);
  } catch { /* private mode — nothing we can do */ }
}
