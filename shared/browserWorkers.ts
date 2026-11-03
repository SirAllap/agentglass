/*
 * Who may drive the built-in browser: which engines and which worker roles.
 *
 * The floor is the credential's, not this setting's (server/src/auth.ts,
 * server/src/browserdrive.ts): a worker's credential reaches its own container
 * (`agent:<name>`) and the relay refuses the person's. This setting decides
 * only whether a worker gets that credential at all, and it is all-on until the
 * person turns something off — a local worker drives the browser as it did
 * before this row existed.
 *
 * One list per dimension and no wildcard: a new engine or role is off until it
 * is added here, and a value that names one this app does not know is refused
 * by the door rather than stored (and, if one is already in the file, dropped
 * on read rather than read as all on).
 */
import { ENGINE_IDS, agentProvider } from "./agentKinds.ts";
import { WORKER_ROLES } from "./workerRoles.ts";

export interface BrowserWorkers {
  engines: string[];
  roles: string[];
}

/** The engines that can run a worker turn at all: one with no headless form
 *  (`headlessRefusal` in server/src/agents/headless.ts) is not a worker CLI, and
 *  offering its toggle would be a switch that changes nothing. */
export const BROWSER_ENGINES: readonly { id: string; title: string }[] =
  ENGINE_IDS.filter((id) => !!agentProvider(id)?.headless).map((id) => ({ id, title: agentProvider(id)?.title ?? id }));

/** The roles the orchestration policy knows. */
export const BROWSER_ROLES: readonly { id: string; title: string }[] =
  WORKER_ROLES.map((r) => ({ id: r.id, title: r.title }));

const ENGINE_IDS_KNOWN = BROWSER_ENGINES.map((e) => e.id);
const ROLE_IDS_KNOWN = BROWSER_ROLES.map((r) => r.id);

/** Everything on, which is what no stored value means. */
export function defaultBrowserWorkers(): BrowserWorkers {
  return { engines: [...ENGINE_IDS_KNOWN], roles: [...ROLE_IDS_KNOWN] };
}

const engineTitle = (id: string): string => agentProvider(id)?.title ?? id;
const roleTitle = (id: string): string => BROWSER_ROLES.find((r) => r.id === id)?.title ?? id;

function knownList(raw: unknown, known: readonly string[], what: string): { value: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `expected a list of ${what}` };
  const picked = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string" || !known.includes(x)) {
      return { error: `unknown ${what.replace(/s$/, "")} ${JSON.stringify(x)}: one of ${known.join(", ")}` };
    }
    picked.add(x);
  }
  // Canonical order, so the same set in another order is the same value: the
  // door's diff and its "unchanged" answer read the value, not the spelling.
  return { value: known.filter((k) => picked.has(k)) };
}

/** A stored value as the setting holds it, or why it is refused. */
export function cleanBrowserWorkers(raw: unknown): { value: BrowserWorkers } | { error: string } {
  const obj = raw as { engines?: unknown; roles?: unknown } | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: 'an object of {"engines": [...], "roles": [...]}' };
  const engines = knownList(obj.engines, ENGINE_IDS_KNOWN, "engines");
  if ("error" in engines) return engines;
  const roles = knownList(obj.roles, ROLE_IDS_KNOWN, "roles");
  if ("error" in roles) return roles;
  return { value: { engines: engines.value, roles: roles.value } };
}

/** Whether this worker's engine and role are on. */
export function browserWorkerAllowed(set: BrowserWorkers, engine: string, role: string): boolean {
  return set.engines.includes(engine) && set.roles.includes(role);
}

/**
 * A stored value as the launch path reads it: the members it names that this
 * app knows, and nothing else. An unknown name is dropped rather than read as
 * "all on", and a list with nothing known left is empty, so a typo, a newer
 * build's value or a half hand-edit can only narrow. Absent entirely is what
 * no stored value means, and that is all-on. A key present but not a list — a
 * hand-edit with only `engines` — is nothing on, not all on: removing the whole
 * value is what turns everything back on.
 */
export function readBrowserWorkers(raw: unknown): BrowserWorkers {
  const obj = raw as { engines?: unknown; roles?: unknown } | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return defaultBrowserWorkers();
  return { engines: keptMembers(obj.engines, ENGINE_IDS_KNOWN), roles: keptMembers(obj.roles, ROLE_IDS_KNOWN) };
}

function keptMembers(raw: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const picked = new Set(raw.filter((x): x is string => typeof x === "string" && known.includes(x)));
  return known.filter((k) => picked.has(k));
}

/**
 * The new value only takes members away from both lists. Turning an engine or
 * a role off is the safe direction; adding one back is the one that waits.
 */
export function browserWorkersNarrow(prev: unknown, next: unknown): boolean {
  const a = prev as BrowserWorkers | null, b = next as BrowserWorkers | null;
  if (!a || !b || !Array.isArray(a.engines) || !Array.isArray(a.roles) || !Array.isArray(b.engines) || !Array.isArray(b.roles)) return false;
  return b.engines.every((x) => a.engines.includes(x)) && b.roles.every((x) => a.roles.includes(x));
}

/**
 * What the worker's brief says when it has no credential. Null when it has one,
 * so a caller cannot add the line to a worker that is allowed.
 */
export function browserOffLine(set: BrowserWorkers, engine: string, role: string): string | null {
  if (browserWorkerAllowed(set, engine, role)) return null;
  const engineOff = !set.engines.includes(engine);
  const roleOff = !set.roles.includes(role);
  const what = engineOff && roleOff
    ? `${engineTitle(engine)} workers in the ${roleTitle(role)} role are`
    : engineOff
      ? `${engineTitle(engine)} workers are`
      : `the ${roleTitle(role)} role is`;
  return `Browser access: ${what} off in Settings ▸ Browser, so this worker has no credential for the built-in browser and cannot drive it. The rest of this brief is unchanged.`;
}
