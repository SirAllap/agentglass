/*
 * Read-only's deny patterns for a known MCP server (`workers.mcpServers`):
 * the tool name globs this app has checked hold that server to reading, in
 * the turn's `--settings` deny list (server/src/agents/envelope.ts
 * `mcpDenyFor`). A generic rule would be "deny every tool not on a read
 * allow-list", but keeping one per known server, spelled as the write verbs
 * its own tools are named with, is what was measured to hold (atlassian,
 * 2026-11-05, under `bypassPermissions`).
 *
 * A server not here is never offered Read-only (server/src/serverSettings.ts
 * validate, and the Settings page below): only Off or All.
 */
export const MCP_READONLY_DENY: Readonly<Record<string, readonly string[]>> = {
  atlassian: [
    "mcp__atlassian__create*", "mcp__atlassian__edit*", "mcp__atlassian__update*", "mcp__atlassian__add*",
    "mcp__atlassian__transition*", "mcp__atlassian__addOrEdit*", "mcp__atlassian__executeWrite", "mcp__atlassian__executeDestructive",
  ],
};

/** The MCP server names Read-only is offered for: the ones with a deny list above. */
export const MCP_READONLY_KNOWN: readonly string[] = Object.keys(MCP_READONLY_DENY);

/** `workers.mcpServers` per server: Off (absent), Read-only or All. */
export type McpMode = "readOnly" | "all";

/**
 * A stored `workers.mcpServers` value, normalized to a name-to-mode map.
 *
 * Before per-server modes existed, it was a plain list of chosen names — each
 * one given every tool, since Off/All was the only choice. A project that
 * already has `["atlassian"]` approved is read as `{ atlassian: "all" }`:
 * exactly what it had, never silently dropped and never silently narrowed to
 * Read-only on its own.
 */
export function mcpModesOf(v: unknown): Record<string, McpMode> {
  if (Array.isArray(v)) {
    const out: Record<string, McpMode> = {};
    for (const name of v) if (typeof name === "string") out[name] = "all";
    return out;
  }
  if (!v || typeof v !== "object") return {};
  const out: Record<string, McpMode> = {};
  for (const [name, mode] of Object.entries(v as Record<string, unknown>)) {
    if (mode === "readOnly" || mode === "all") out[name] = mode;
  }
  return out;
}
