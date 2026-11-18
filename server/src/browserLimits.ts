/*
 * The three browser limits as the relay reads them on every call: the origin
 * and profile allow lists and the verb groups a worker's credential may run.
 *
 * `AGENTGLASS_BROWSER_ORIGINS` and `AGENTGLASS_BROWSER_PROFILES` are the
 * operator's hardening of a server that may be exposed, so when one is set it
 * wins over the setting and the page says so (`limitEnv`). Nothing is cached:
 * a change takes effect on the next call.
 */
import { cleanAllowList, readVerbGroups } from "../../shared/browserLimits.ts";
import { storedBrowserLimits, writeBrowserLimit } from "./config.ts";

export const ORIGINS_ENV = "AGENTGLASS_BROWSER_ORIGINS";
export const PROFILES_ENV = "AGENTGLASS_BROWSER_PROFILES";

const fromEnv = (name: string): string[] | null => {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
};

/** The stored allow list, `*` when nothing valid is stored. */
function storedList(key: "origins" | "profiles"): string[] {
  const v = cleanAllowList(storedBrowserLimits()[key] ?? [], key);
  return "value" in v ? v.value : ["*"];
}

export const originsAllow = (): string[] => fromEnv(ORIGINS_ENV) ?? storedList("origins");
export const profilesAllow = (): string[] => fromEnv(PROFILES_ENV) ?? storedList("profiles");
/** The verb groups a worker's credential may run: the stored list, else read and act. */
export const workerVerbGroups = (): string[] => readVerbGroups(storedBrowserLimits().verbs);

/** What the page shows when the environment holds a list: the variable and its value, or null. */
export function limitEnv(key: "origins" | "profiles"): { name: string; value: string } | null {
  const name = key === "origins" ? ORIGINS_ENV : PROFILES_ENV;
  const v = fromEnv(name);
  return v ? { name, value: v.join(",") } : null;
}

export { storedList as storedAllowList, writeBrowserLimit };
