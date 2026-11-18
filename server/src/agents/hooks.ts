// Which engines run the person's hooks, and what that decides.
//
// A worker has its seat's powers because the seat's safety hooks (the user's
// ~/.claude/settings.json and the project's .claude/settings.json PreToolUse
// guards) run before its tool calls. Claude Code runs both. OpenCode and Codex
// run neither, so on them the old floor stays and a project with hooks of its
// own is refused outright. The ceiling: an OpenCode plugin with
// `tool.execute.before` that calls the same gate would lift this per engine.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProvider } from "../../../shared/agentKinds.ts";

/** Only Claude Code runs the person's and the project's PreToolUse hooks. */
export const runsPersonHooks = (engine: string): boolean => engine === "claude";

const SETTINGS = [".claude/settings.json", ".claude/settings.local.json"] as const;

/** The first project settings file under these roots that declares a PreToolUse hook, or null. */
export function projectHookFile(roots: readonly (string | undefined | null)[]): string | null {
  for (const root of new Set(roots.filter((r): r is string => !!r))) {
    for (const rel of SETTINGS) {
      const file = join(root, rel);
      try {
        if (!existsSync(file)) continue;
        const hooks = (JSON.parse(readFileSync(file, "utf8")) as { hooks?: { PreToolUse?: unknown } }).hooks?.PreToolUse;
        if (Array.isArray(hooks) && hooks.length > 0) return file;
      } catch { /* a settings file that does not parse declares nothing here */ }
    }
  }
  return null;
}

const title = (engine: string): string => agentProvider(engine)?.title ?? engine;

/** Why this engine cannot start in a project whose own hooks it would skip; null when it may. */
export function hookRefusal(engine: string, roots: readonly (string | undefined | null)[]): string | null {
  if (runsPersonHooks(engine)) return null;
  const file = projectHookFile(roots);
  return file ? `${title(engine)} does not run this project's PreToolUse hooks (${file}), and a worker must not start without them. Use a Claude Code worker here, or remove the hooks.` : null;
}

/** Said in the start answer and by `can`: the old floor stays on an engine that skips the person's hooks. */
export function oldFloorNote(engine: string): string | null {
  return runsPersonHooks(engine)
    ? null
    : `${title(engine)} does not run your hooks (${join(homedir(), ".claude/settings.json")}), so this worker keeps the old floor`;
}

