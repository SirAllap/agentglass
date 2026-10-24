import { api } from "./api.ts";
import { ACCENTS } from "../../../shared/palettes.ts";
import type { AccountOut, AccountsOut } from "../../../shared/pluginAccounts.ts";
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";

/**
 * The accounts a plugin says each provider has, for the usage popover.
 *
 * A module store like usageStore, and it has no timer of its own: it is read
 * when the popover opens and whenever the providers poll lands (usageStore's
 * onSnapshot), so a machine with no accounts plugin costs one empty request per
 * five minutes on top of a poll that already runs.
 */

let snapshot: AccountsOut[] = [];
const listeners = new Set<() => void>();
const activeWatchers = new Set<() => void>();

export const accountLists = (): AccountsOut[] => snapshot;
export const accountsOf = (provider: string): AccountsOut | null => snapshot.find((l) => l.provider === provider) ?? null;

export function subscribeAccounts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Called when the active account of any provider changed, so the plan readings can be asked again. */
export function onActiveChanged(fn: () => void): void { activeWatchers.add(fn); }

const activeIds = (lists: AccountsOut[]): string => lists.map((l) => `${l.provider}:${l.accounts.find((a) => a.active)?.id ?? ""}`).sort().join("|");

/** Read the lists again. A failed read leaves the last answer standing, like the plan poll. */
export async function refreshAccounts(): Promise<void> {
  let next: AccountsOut[];
  try { next = (await api.usageAccounts()).providers ?? []; } catch { return; }
  const changed = activeIds(next) !== activeIds(snapshot);
  const was = snapshot.length > 0;
  snapshot = next;
  for (const l of listeners) l();
  // The first read is not a switch: only a list that had an active account and now has another one is.
  if (changed && was) for (const w of activeWatchers) w();
}

/** Delays of the two reads after a press: the plugin answers by posting its new list, and nothing pushes that to the window. */
export const FOLLOW_UP_MS = [1_500, 5_000] as const;

/**
 * The person's press of a chip or of "manage". Resolves to the server's
 * sentence on refusal. Only the popover calls this, from a click or a key the
 * person pressed; the agents' stage door never does (web/test/account-stage.test.ts).
 */
export async function pressAccount(kind: "switch" | "manage", provider: string, id?: string): Promise<{ ok: boolean; error?: string; plugin?: string }> {
  try {
    const r = kind === "switch" ? await api.accountSwitch(provider, id ?? "") : await api.accountManage(provider);
    if (!r.ok) return { ok: false, error: r.error || "the app refused" };
    if (kind === "switch") for (const ms of FOLLOW_UP_MS) setTimeout(() => { void refreshAccounts(); }, ms);
    return { ok: true, plugin: r.plugin };
  } catch {
    return { ok: false, error: "could not reach the app" };
  }
}

/** The row the plan strip and the pace history read: the core's own, not an inactive account's. */
export const isCoreRow = (u: ProviderUsage): boolean => !u.account || u.account.active;

/** What a screen that lists or headlines providers draws: one row each, the login in use. Applied in render, never in a store snapshot. */
export const coreRows = (rows: ProviderUsage[] | null): ProviderUsage[] | null => rows?.filter(isCoreRow) ?? null;

/**
 * The usage row for one chip. The active chip reads the core's row; any other
 * reads the row the plugin's reading became, matched by the label the row
 * carries (a row has no id). The validator refuses two accounts of a provider
 * with the same label, so a label picks one row.
 */
export function readingFor(rows: ProviderUsage[] | null, provider: string, a: Pick<AccountOut, "label" | "active">): ProviderUsage | null {
  const mine = (rows ?? []).filter((r) => r.provider === provider);
  if (a.active) return mine.find(isCoreRow) ?? null;
  return mine.find((r) => r.account && !r.account.active && r.account.label === a.label) ?? null;
}

/** The busiest window's percentage, or null when there is nothing to say. */
export function peakOf(row: { available: boolean; windows: QuotaWindow[] } | null): number | null {
  if (!row || !row.available || !row.windows.length) return null;
  return Math.max(...row.windows.map((w) => w.usedPercent));
}

/** The dot of a chip: an accent word becomes that accent's colour, neutral the page's ink. */
export function colourOf(id: string): string {
  if (id === "neutral") return "var(--text2)";
  return ACCENTS.find((a) => a.id === id)?.primary ?? "var(--text3)";
}

/** Plain names for the closed set of managers a plugin may declare. */
export const MANAGER_NAME: Record<string, string> = { swapkin: "Swapkin" };
