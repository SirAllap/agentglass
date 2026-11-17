import type { ProviderUsage } from "../../../shared/types.ts";
import { accountsOf, DEFAULT_ACCOUNT, type UsageAccount } from "../../../shared/usageAccounts.ts";
import type { UsageProviderId } from "../../../shared/orchestration.ts";

export interface AccountLine { id: string; label: string; source?: string; gauge: string }

/** "5h 12% · weekly 40% used", or the row's own sentence when it has no reading. */
export function gaugeText(row: ProviderUsage | undefined): string {
  if (!row) return "No reading.";
  if (!row.available || !row.windows.length) return row.note ?? "No reading.";
  return row.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(" · ") + " used";
}

/** One line per account of a provider, the default first. The default's gauge is the provider's own row; an added account's is its own row. */
export function accountLines(rows: readonly ProviderUsage[], accounts: readonly UsageAccount[], provider: UsageProviderId, defaultLabel: string): AccountLine[] {
  return accountsOf(accounts, provider, defaultLabel).map((a) => {
    const row = rows.find((r) => r.provider === provider && (a.id === DEFAULT_ACCOUNT ? !r.ownAccount : r.ownAccount?.id === a.id));
    return { id: a.id, label: a.label, ...(a.source ? { source: a.source } : {}), gauge: gaugeText(row) };
  });
}

/** The picker's options for a rule: only shown when the provider has an account besides the default. */
export function pickerOptions(accounts: readonly UsageAccount[], provider: UsageProviderId, defaultLabel: string): { value: string; label: string }[] {
  const l = accountsOf(accounts, provider, defaultLabel);
  return l.length < 2 ? [] : l.map((a) => ({ value: a.id, label: a.label }));
}
