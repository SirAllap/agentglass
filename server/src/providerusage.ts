// Every provider's plan quota, in one shape.
//
// Three genuinely different sources — a live OAuth endpoint, a file the Codex
// CLI writes, and nothing at all — normalised so that the surfaces render a
// list instead of three bespoke blocks. The order is fixed rather than sorted:
// a row that moves because a number changed is a row nobody can find twice.
import type { ProviderUsage, AgentProbe } from "../../shared/types.ts";
import type { UsagePayload } from "./usage.ts";
import { getUsage } from "./usage.ts";
import { windowLabel } from "../../shared/quota.ts";
import { codexUsage } from "./codexusage.ts";
import { probeAgents } from "./agentprobe.ts";
import { holderOf } from "./accounts.ts";
import type { AccountsInput } from "../../shared/pluginAccounts.ts";

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
  "Quota not reported.";

/** Strip a generic "SomeError: " prefix so a caught exception reads as a
 *  clause, not a stack trace, when it lands in front of a person. */
function summarizeError(error: string): string {
  return error.replace(/^[A-Za-z.]*Error:\s*/, "").trim() || "an unknown error";
}

/** Turn usage.ts's `error` into a sentence a person can act on.
 *
 *  usage.ts already tells the three failures apart — "no credentials", an
 *  HTTP 429, or a stringified network/timeout throw — and collapsing them
 *  into one "sign in" note misdiagnoses the other two: a rate-limited or
 *  offline machine is not a signed-out one, and telling a signed-in user to
 *  sign in again teaches them to ignore the note the next time it matters. */
function anthropicFailureNote(error?: string): string {
  if (!error || error === "no credentials") {
    return "Could not read Anthropic plan usage — sign in to Claude Code on this machine.";
  }
  if (/\b429\b/.test(error)) {
    return "Anthropic is rate-limiting its usage endpoint right now — agentglass will keep retrying.";
  }
  return `Could not reach Anthropic's usage endpoint (${summarizeError(error)}) — agentglass will keep retrying.`;
}

/** Convert a UsagePayload into the shared ProviderUsage shape.
 *  The percentages are already 0..100 and already rounded by usage.ts.
 *  If available is true but no windows parsed, returns unavailable with an explanation. */
export function anthropicUsage(u: UsagePayload): ProviderUsage {
  if (!u.available) {
    return {
      provider: "anthropic", label: "Claude", available: false, windows: [],
      note: anthropicFailureNote(u.error),
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
  // Per-model weekly windows, named by whatever the API called them. They ride
  // in the same list rather than a field of their own: every surface here draws
  // "the windows this provider reports", and a plan that grows a new bucket
  // next week should appear without a release. Labelled by the model, not by
  // length, because two weekly buckets that both said "weekly" would be a row
  // you cannot tell from the one above it.
  for (const s of u.scoped ?? []) {
    windows.push({
      label: s.name, minutes: 10080,
      usedPercent: s.utilization,
      resetsAt: s.resets_at,
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

/**
 * Which roster entry decides whether a provider is shown at all.
 *
 * Only three of the four agents have quota to report — the Gemini CLI has no
 * plan window this app can read, so it maps to nothing here rather than to an
 * empty row.
 */
const AGENT_FOR: Record<ProviderUsage["provider"], string> = {
  anthropic: "claude-code",
  codex: "codex",
  antigravity: "antigravity",
};

/**
 * The providers whose agent is installed on this machine, and so worth a row.
 *
 * Keyed on `found` — the binary is on the PATH — rather than on `connected`.
 * The two answer different questions, and quota is only downstream of the
 * first. Connecting an agent wires its events to this server: hooks for Claude,
 * OTel for Codex. Quota comes from neither. Codex's lives in the session files
 * its CLI writes whatever it is pointed at, and Claude's behind the OAuth
 * credentials on disk. So an agent you have deliberately disconnected still has
 * a plan that runs out, and hiding that number would be withholding something
 * true about a tool you are still using.
 *
 * What the filter does remove is a row about a CLI that is not here at all —
 * where the note would otherwise invite you to "run a Codex turn" with no
 * codex binary to run it with.
 */
export function installedProviders(probes: AgentProbe[]): Set<ProviderUsage["provider"]> {
  const here = new Set(probes.filter((p) => p.found).map((p) => p.id));
  const out = new Set<ProviderUsage["provider"]>();
  for (const [provider, id] of Object.entries(AGENT_FOR)) {
    if (here.has(id)) out.add(provider as ProviderUsage["provider"]);
  }
  return out;
}

/**
 * The rows of one provider once a plugin lists its logins.
 *
 * The active login's row is the app's own reading, never the plugin's: the
 * plugin can know the other logins' numbers, but the one signed in is measured
 * here, and a plugin that also sends a reading for it is ignored. Each other
 * login with a reading gets a row of its own, right after, the windows copied
 * field by field so the pace maths downstream sees what it always saw. A login
 * with no reading has no row. Without an active login in the list there is no
 * way to say which one `row` reads, so it goes through unmarked.
 *
 * `account` is built here from three fields and nothing else: this answer is
 * served to a paired phone, and the list also carries ids, colours and where
 * each login is stored.
 */
export function withAccounts(row: ProviderUsage, list: AccountsInput | null | undefined): ProviderUsage[] {
  const active = list?.accounts.find((a) => a.active);
  if (!list || !active) return [row];
  const out: ProviderUsage[] = [{ ...row, account: { label: active.label, plan: active.plan, active: true } }];
  for (const a of list.accounts) {
    if (a.active || !a.reading?.windows.length) continue;
    out.push({
      provider: row.provider, label: row.label, available: true, plan: a.plan,
      windows: a.reading.windows.map((w) => ({ label: w.label, minutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
      account: { label: a.label, plan: a.plan, active: false },
    });
  }
  return out;
}

/**
 * `seen` is stubbed out: `found` is decided by `Bun.which` alone, so the four
 * `MAX(timestamp)` queries `probeAgents` would otherwise run are work this
 * endpoint has no use for, on a route the dashboard polls every five minutes.
 */
export async function allProviderUsage(
  probes: AgentProbe[] = probeAgents(undefined, () => null),
  accountsOf: (provider: string) => AccountsInput | undefined = (p) => holderOf(p)?.list,
): Promise<ProviderUsage[]> {
  const show = installedProviders(probes);
  const rows: ProviderUsage[] = [];
  if (show.has("anthropic")) rows.push(await anthropic());
  if (show.has("codex")) rows.push(codexUsage());
  if (show.has("antigravity")) {
    rows.push({
      provider: "antigravity", label: "Antigravity", available: false,
      windows: [], note: ANTIGRAVITY_NOTE,
    });
  }
  return rows.flatMap((r) => withAccounts(r, accountsOf(r.provider)));
}
