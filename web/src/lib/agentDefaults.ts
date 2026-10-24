/*
 * The Agents page's five server settings, as the window holds them.
 *
 * The server owns them (shared/agentDefaults.ts, the settings door). Two of
 * them are acted on HERE: where a new chat opens and the permission mode it
 * starts in, because a chat is made by this window. A new chat cannot wait for
 * a request, so the last answer is kept in memory and mirrored to localStorage;
 * the Settings page and the chat panel both refresh it, and a window that has
 * never heard from the server opens chats exactly as it always did.
 */
import { api } from "./api.ts";
import {
  CHAT_MODES, CHAT_START_IN, GATE_ANSWERERS, GATE_ON_TIMEOUT, isOneOf,
  type ChatMode, type ChatStartIn, type GateAnswerer, type GateOnTimeout,
} from "../../../shared/agentDefaults.ts";

export interface AgentDefaults {
  gateAnswerer: GateAnswerer;
  gateOnTimeout: GateOnTimeout;
  chatStartIn: ChatStartIn;
  chatMode: ChatMode;
  chatDeny: string[];
}

export const AGENT_DEFAULTS: AgentDefaults = { gateAnswerer: "me", gateOnTimeout: "drop", chatStartIn: "last", chatMode: "inherit", chatDeny: [] };

/** The door's ids, one per field. */
export const DOOR_ID: Record<keyof AgentDefaults, string> = {
  gateAnswerer: "gate.answerer", gateOnTimeout: "gate.onTimeout", chatStartIn: "chats.startIn", chatMode: "chats.mode", chatDeny: "chats.deny",
};

/** The five, from the door's list: anything missing or unusable reads as the default. */
export function readDefaults(settings: readonly { id: string; value?: unknown }[]): AgentDefaults {
  const v = (field: keyof AgentDefaults) => settings.find((s) => s.id === DOOR_ID[field])?.value;
  const d = AGENT_DEFAULTS;
  const deny = v("chatDeny");
  return {
    gateAnswerer: isOneOf(GATE_ANSWERERS, v("gateAnswerer")) ? (v("gateAnswerer") as GateAnswerer) : d.gateAnswerer,
    gateOnTimeout: isOneOf(GATE_ON_TIMEOUT, v("gateOnTimeout")) ? (v("gateOnTimeout") as GateOnTimeout) : d.gateOnTimeout,
    chatStartIn: isOneOf(CHAT_START_IN, v("chatStartIn")) ? (v("chatStartIn") as ChatStartIn) : d.chatStartIn,
    chatMode: isOneOf(CHAT_MODES, v("chatMode")) ? (v("chatMode") as ChatMode) : d.chatMode,
    chatDeny: Array.isArray(deny) ? deny.filter((x): x is string => typeof x === "string") : d.chatDeny,
  };
}

const KEY = "agentglass.chat.defaults";
let held: AgentDefaults | null = null;

/** What a new chat starts with right now. */
export function chatDefaults(): Pick<AgentDefaults, "chatStartIn" | "chatMode"> {
  if (!held) {
    try { held = readDefaults(Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>).map(([id, value]) => ({ id, value }))); } catch { held = AGENT_DEFAULTS; }
  }
  return held;
}

/** Keep what the server said. */
export function rememberDefaults(d: AgentDefaults): void {
  held = d;
  try { localStorage.setItem(KEY, JSON.stringify({ [DOOR_ID.chatStartIn]: d.chatStartIn, [DOOR_ID.chatMode]: d.chatMode })); } catch { /* private mode: the memory copy still serves this window */ }
}

/** Ask the server, keep the answer, and hand it back; null when it cannot be reached. */
export async function loadDefaults(): Promise<AgentDefaults | null> {
  try {
    const r = await api.settingsDoor();
    if (!r.ok) return null;
    const d = readDefaults(r.settings);
    rememberDefaults(d);
    return d;
  } catch { return null; }
}
