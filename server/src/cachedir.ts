/*
 * The one answer to "where does agentglass keep disposable files?".
 *
 * AGENTGLASS_CACHE_DIR names the directory itself. Next comes XDG_CACHE_HOME
 * plus `agentglass`. Only with neither set does it fall back to the real
 * `~/.cache/agentglass`. Every reader goes through here, so an isolated run
 * that sets either variable never touches the person's own cache.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function agentglassCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTGLASS_CACHE_DIR) return env.AGENTGLASS_CACHE_DIR;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agentglass");
}
