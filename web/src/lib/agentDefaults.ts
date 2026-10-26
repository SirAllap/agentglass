/*
 * The Agents page's two server settings, as the window holds them.
 *
 * The server owns them (shared/agentDefaults.ts, the settings door); this
 * window only reads them to draw the gate card.
 */
import { api } from "./api.ts";
import {
  GATE_ANSWERERS, GATE_ON_TIMEOUT, isOneOf,
  type GateAnswerer, type GateOnTimeout,
} from "../../../shared/agentDefaults.ts";

export interface AgentDefaults {
  gateAnswerer: GateAnswerer;
  gateOnTimeout: GateOnTimeout;
}

export const AGENT_DEFAULTS: AgentDefaults = { gateAnswerer: "me", gateOnTimeout: "drop" };

/** The door's ids, one per field. */
export const DOOR_ID: Record<keyof AgentDefaults, string> = {
  gateAnswerer: "gate.answerer", gateOnTimeout: "gate.onTimeout",
};

/** The two, from the door's list: anything missing or unusable reads as the default. */
export function readDefaults(settings: readonly { id: string; value?: unknown }[]): AgentDefaults {
  const v = (field: keyof AgentDefaults) => settings.find((s) => s.id === DOOR_ID[field])?.value;
  const d = AGENT_DEFAULTS;
  return {
    gateAnswerer: isOneOf(GATE_ANSWERERS, v("gateAnswerer")) ? (v("gateAnswerer") as GateAnswerer) : d.gateAnswerer,
    gateOnTimeout: isOneOf(GATE_ON_TIMEOUT, v("gateOnTimeout")) ? (v("gateOnTimeout") as GateOnTimeout) : d.gateOnTimeout,
  };
}

/** Ask the server and hand the answer back; null when it cannot be reached. */
export async function loadDefaults(): Promise<AgentDefaults | null> {
  try {
    const r = await api.settingsDoor();
    if (!r.ok) return null;
    return readDefaults(r.settings);
  } catch { return null; }
}
