/*
 * The MCP servers the person has configured for themselves (Claude Code's own
 * `~/.claude.json`, top-level `mcpServers`), and which of those a worker turn
 * may load.
 *
 * Giving a worker one of these is an escalation (shared/settingClass.ts
 * "workers.mcpServers"): an MCP server acts with the person's own account, the
 * same way a Jira or ClickUp write does. Nothing here decides that on its own;
 * it only reads what is configured and what the person has switched on.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readRegularFileSync } from "./agents/headless.ts";

export interface ConfiguredMcpServer {
  name: string;
  /** The server's own entry (`command`/`args`/`env`, or `type: "http"` + `url`), exactly as Claude Code stores it. */
  config: Record<string, unknown>;
}

/** Claude Code's own config file. Resolved per call, never at import — the
 *  same reason `usage.ts`'s `claudeConfigPath` is. Under `bun test` only a
 *  scratch-directory path is ever read, so no suite opens the developer's own. */
function claudeConfigPath(): string | null {
  const injected = process.env.CLAUDE_CONFIG_JSON;
  if (process.env.NODE_ENV === "test") return injected && injected.startsWith(tmpdir()) ? injected : null;
  if (injected) return injected;
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

/** Every MCP server the person has configured for themselves, by name. Empty
 *  when the config is missing, unreadable, or holds no `mcpServers` object. */
export function configuredMcpServers(): ConfiguredMcpServer[] {
  const path = claudeConfigPath();
  if (!path) return [];
  const text = readRegularFileSync(path);
  if (text === null) return [];
  try {
    const raw = JSON.parse(text) as { mcpServers?: unknown };
    if (!raw.mcpServers || typeof raw.mcpServers !== "object" || Array.isArray(raw.mcpServers)) return [];
    return Object.entries(raw.mcpServers as Record<string, unknown>)
      .filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === "object")
      .map(([name, config]) => ({ name, config }));
  } catch {
    return [];
  }
}

/** Names only, for validating a stored setting against what is really configured. */
export function configuredMcpServerNames(): string[] {
  return configuredMcpServers().map((s) => s.name);
}

/** A server this app has resolved to run, with the mode it was switched to. */
export interface ChosenMcpServer extends ConfiguredMcpServer { mode: "readOnly" | "all" }

/** A stored map of server name to mode, cut to the ones that are both named
 *  and still configured — a server removed from `~/.claude.json` since is
 *  dropped, same as `browserWorkers.ts`'s `readBrowserWorkers`: absent is
 *  nothing on, never all on. */
export function chosenMcpServers(modes: Readonly<Record<string, "readOnly" | "all">>): ChosenMcpServer[] {
  const known = configuredMcpServers();
  return known.filter((s) => !!modes[s.name]).map((s) => ({ ...s, mode: modes[s.name]! }));
}
