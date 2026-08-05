import type { AgentKind } from "./agents.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

type Provider = ProviderUsage["provider"];

/** The CLI you are driving names its own quota exactly. */
const BY_AGENT: Record<AgentKind, Provider> = {
  claude: "anthropic",
  codex: "codex",
  antigravity: "antigravity",
};

/**
 * A provider filter names a *model vendor*, which is a near-miss for a CLI
 * rather than the same thing — Google models can run under Antigravity or under
 * the Gemini CLI, and only one of those has a gauge. Close enough to pick a
 * meter from, and the map is explicit so an unmapped vendor yields nothing
 * instead of quietly borrowing somebody else's numbers.
 */
const BY_FILTER: Record<string, Provider> = {
  Anthropic: "anthropic",
  OpenAI: "codex",
  Google: "antigravity",
};

export function providerInContext(focused: AgentKind | null, filterProvider: string): Provider | null {
  if (focused) return BY_AGENT[focused];
  return BY_FILTER[filterProvider] ?? null;
}
