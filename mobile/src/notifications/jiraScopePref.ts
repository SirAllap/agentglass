/*
 * Whose cards the phone's Jira board draws: Mine (the default) or Everyone.
 *
 * Remembered on this phone, in the shape talkPref.ts uses: a module singleton
 * with a subscription, the keystore read once at startup. It never reaches the
 * server; "which cards do I want to see in my pocket" is a fact about the phone.
 */
import type { JiraScope } from "../model/jiraBoard.ts";

interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

/** Required lazily so `bun test`, which has no keystore, gets `null`, not a throw. */
function keystore(): KeystoreModule | null {
  try {
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null;
  }
}

const KEY = "agentglass.jira.scope";

let scope: JiraScope = "mine";
/** Set once somebody chooses in this run, so the stored value read at startup
 *  cannot land late and undo that choice. */
let chosen = false;
const listeners = new Set<() => void>();

export const jiraScope = (): JiraScope => scope;

export function onJiraScope(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setJiraScope(next: JiraScope): void {
  chosen = true;
  scope = next;
  for (const fn of [...listeners]) fn();
  void keystore()?.setItemAsync(KEY, next).catch(() => {
    // Stays live for this run.
  });
}

void (async () => {
  try {
    const raw = await keystore()?.getItemAsync(KEY);
    if (!chosen && (raw === "mine" || raw === "everyone")) {
      scope = raw;
      for (const fn of [...listeners]) fn();
    }
  } catch {
    // Left at Mine, the default.
  }
})();
