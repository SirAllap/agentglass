// Persistence for the notification diet — see shared/notifyPrefs.ts for the
// shape and the reasoning. One JSON file, same directory `plugins.ts` keeps
// `plugins.json` in: there is already exactly one place on disk this server
// puts its own config, and a second directory for one more file would just be
// that convention, forked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { coerceNotifyPrefs, DEFAULT_NOTIFY_PREFS, type NotifyPrefs } from "../../shared/notifyPrefs.ts";

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}
export function notifyPrefsPath(): string {
  return join(configDir(), "notify-prefs.json");
}

/** Same rule every other store in this server follows under test: only the
 *  scratch directory is readable or writable, so a suite run never reads or
 *  clobbers a developer's own prefs. */
const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

let cache: NotifyPrefs | null = null;

export function readNotifyPrefs(): NotifyPrefs {
  if (cache) return cache;
  const p = notifyPrefsPath();
  if (offLimits(p) || !existsSync(p)) return (cache = { ...DEFAULT_NOTIFY_PREFS });
  try {
    cache = coerceNotifyPrefs(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    // A corrupt file must not take the server down on boot — same rule
    // plugins.ts follows for plugins.json. The cost is the prefs reset to
    // default, which a person notices and can set again in Settings.
    cache = { ...DEFAULT_NOTIFY_PREFS };
  }
  return cache;
}

export function writeNotifyPrefs(raw: unknown): NotifyPrefs {
  const prefs = coerceNotifyPrefs(raw);
  cache = prefs;
  const p = notifyPrefsPath();
  if (offLimits(p)) return prefs;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(prefs, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* best effort, as plugins.ts's write() is */
  }
  return prefs;
}

/** For tests only: drop the cached read so a changed XDG_CONFIG_HOME or a
 *  file written by hand is seen on the next read. */
export function __resetNotifyPrefsCache(): void {
  cache = null;
}
