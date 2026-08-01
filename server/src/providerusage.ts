// Every provider's plan quota, in one shape.
//
// Three genuinely different sources — a live OAuth endpoint, a file the Codex
// CLI writes, and nothing at all — normalised so that the surfaces render a
// list instead of three bespoke blocks. The order is fixed rather than sorted:
// a row that moves because a number changed is a row nobody can find twice.
import type { ProviderUsage } from "../../shared/types.ts";
import type { UsagePayload } from "./usage.ts";
import { getUsage } from "./usage.ts";
import { windowLabel } from "../../shared/quota.ts";
import { codexUsage } from "./codexusage.ts";

/**
 * Why Antigravity has no gauge.
 *
 * Checked 2026-07-31: `agy` has no usage or quota subcommand, nothing under
 * ~/.gemini/antigravity-cli holds a quota figure, its conversation DBs carry no
 * usage fields, and its own log shows a quota_manager that refreshes into
 * process memory and never writes it down. The only route left would be
 * replaying its authenticated backend call, which is out of scope.
 *
 * Shown rather than hidden, because a provider that is simply missing from the
 * list reads as a bug in agentglass, while one that says why reads as the
 * upstream limitation it is.
 */
export const ANTIGRAVITY_NOTE =
  "Antigravity's CLI does not report quota anywhere agentglass can read.";

/** Convert a UsagePayload into the shared ProviderUsage shape.
 *  The percentages are already 0..100 and already rounded by usage.ts.
 *  If available is true but no windows parsed, returns unavailable with an explanation. */
export function anthropicUsage(u: UsagePayload): ProviderUsage {
  if (!u.available) {
    return {
      provider: "anthropic", label: "Claude", available: false, windows: [],
      note: "Could not read Anthropic plan usage — sign in to Claude Code on this machine.",
    };
  }
  const windows = [];
  if (u.five_hour) {
    windows.push({
      label: windowLabel(300), minutes: 300,
      usedPercent: u.five_hour.utilization,
      resetsAt: u.five_hour.resets_at,
    });
  }
  if (u.seven_day) {
    windows.push({
      label: windowLabel(10080), minutes: 10080,
      usedPercent: u.seven_day.utilization,
      resetsAt: u.seven_day.resets_at,
    });
  }
  // If available but no windows parsed, return unavailable with explanation
  if (windows.length === 0) {
    return {
      provider: "anthropic", label: "Claude", available: false, windows: [],
      note: "Anthropic answered without any plan windows — the usage endpoint may have changed shape.",
    };
  }
  return {
    provider: "anthropic", label: "Claude", available: true,
    windows, observedAt: u.fetched_at,
  };
}

/** Anthropic's live reading via the shared shape. */
async function anthropic(): Promise<ProviderUsage> {
  return anthropicUsage(await getUsage());
}

export async function allProviderUsage(): Promise<ProviderUsage[]> {
  return [
    await anthropic(),
    codexUsage(),
    {
      provider: "antigravity", label: "Antigravity", available: false,
      windows: [], note: ANTIGRAVITY_NOTE,
    },
  ];
}
