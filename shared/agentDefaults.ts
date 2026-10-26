/**
 * The choices of the Agents page that the server holds: who is told when the
 * gate holds something, and what happens when nobody answers. One list here,
 * because the server validates against it, the window draws from it and the
 * settings door names it.
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

export const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
