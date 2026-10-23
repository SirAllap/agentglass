/**
 * The choices of the Agents page that the server holds: who is told when the
 * gate holds something, what happens when nobody answers, and what a new chat
 * starts with. One list here, because the server validates against it, the
 * window draws from it and the settings door names it.
 */

/** Who is told first when an outward action is held. Either way only the
 *  person releases it: the orchestrator is an agent, and the party that can be
 *  held may not release a hold (mayReleaseAHold in server/src/index.ts). */
export const GATE_ANSWERERS = ["me", "orchestrator"] as const;
export type GateAnswerer = (typeof GATE_ANSWERERS)[number];
export const GATE_ANSWERER_LABEL: Record<GateAnswerer, string> = {
  me: "Me, in the Lantern",
  orchestrator: "Me, and tell the orchestrator",
};

/** What a held outward action does when its wait runs out. Dropped is what it
 *  always did; asking again repeats the notification twice inside the same wait
 *  and then drops it, because the hook that holds the agent stops waiting when
 *  its own window ends and a hold that outlived it would be released unseen. */
export const GATE_ON_TIMEOUT = ["drop", "ask"] as const;
export type GateOnTimeout = (typeof GATE_ON_TIMEOUT)[number];
export const GATE_ON_TIMEOUT_LABEL: Record<GateOnTimeout, string> = { drop: "Drop it", ask: "Ask again" };

/** The folder a new chat opens at: the one the last chat used, or the project
 *  that is open in the window now. */
export const CHAT_START_IN = ["last", "open"] as const;
export type ChatStartIn = (typeof CHAT_START_IN)[number];
export const CHAT_START_IN_LABEL: Record<ChatStartIn, string> = { last: "Last project", open: "Open project" };

/** The permission mode a new Claude chat starts in. `inherit` keeps what it
 *  always did (the mode of the chat you had open); bypass is not offered here,
 *  it stays an opt-in of the server. */
export const CHAT_MODES = ["inherit", "default", "acceptEdits", "plan"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
export const CHAT_MODE_LABEL: Record<ChatMode, string> = {
  inherit: "Like the open chat",
  default: "Ask each time",
  acceptEdits: "Accept edits",
  plan: "Plan first",
};

export const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
