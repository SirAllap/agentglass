/*
 * The person's switch `agents.changeWithoutAsking`, held per project.
 *
 * It was one value for the machine, so turning it on for one project turned it
 * on for every project, a project where agents must stay on a short leash
 * included. The value now lives at the project's root, the way the orchestration
 * policy does (server/src/orchestration.ts, `--root`), and the old value stays
 * the GLOBAL one: a request for a setting that names no root reads it.
 *
 * A project with no row of its own is OFF, whatever the global says. Inheriting
 * the global here would be a migration surprise: the person who turned it on
 * once would find it on in every project the next morning.
 *
 * The class stays personOnly (shared/settingClass.ts): no agent turns it on for
 * any project, not even as a request. This file only reads and writes.
 */
import { agentsChangeWithoutAsking, writeAgentsChangeWithoutAsking } from "./config.ts";
import { getSetting, hasSetting, putSetting } from "./preflightStore.ts";

const KEY = "agents.changeWithoutAsking";

/** True when agents of THIS project change escalation settings without asking. No root: the global switch. */
export function agentsTrusted(root?: string): boolean {
  return root ? getSetting(root, KEY) === true : agentsChangeWithoutAsking();
}

/** Whether the project says it itself, so the page can tell "off" from "not set". */
export function agentsTrustSetAt(root: string): boolean {
  return hasSetting(root, KEY);
}

export function writeAgentsTrusted(on: boolean, root?: string): { ok: boolean; persisted: boolean; error?: string } {
  if (!root) return writeAgentsChangeWithoutAsking(on);
  putSetting(root, KEY, on === true);
  return { ok: true, persisted: true };
}
