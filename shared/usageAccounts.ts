/**
 * Usage accounts: more than one plan per provider (two Claude subscriptions).
 *
 * An account is {provider, id, label}. The one account a provider always had is
 * the account with id "default"; nothing is migrated, because an absent id
 * means default. A rule or gauge that names only a provider therefore keeps
 * meaning the default account unless an account is picked.
 *
 * `source` is which credential source the account reads ("keyring", "file",
 * "env", ...), by name only. No credential is read, held or shown here.
 *
 * Pure: the server validates what it stores and the page lists with the same
 * functions.
 */
import type { UsageProviderId } from "./orchestration.ts";

export const DEFAULT_ACCOUNT = "default";
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ACCOUNT_LABEL_MAX = 40;
/** Per provider, the default one included. */
export const ACCOUNTS_PER_PROVIDER_MAX = 6;

export interface UsageAccount { provider: UsageProviderId; id: string; label: string; source?: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Absent or blank id is the default account. */
export const accountId = (id: string | undefined | null): string => (id && id.trim() ? id.trim() : DEFAULT_ACCOUNT);

/** The key a gauge or rule uses: the bare provider for the default account, so old keys still match. */
export const accountKey = (provider: UsageProviderId, id?: string | null): string => {
  const a = accountId(id);
  return a === DEFAULT_ACCOUNT ? provider : `${provider}:${a}`;
};

/** The id from a slug: "Claude work" -> "claude-work". Empty when nothing usable is left. */
export const slugId = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");

/** Which account a rule means: the one it names if that account exists, else the default. */
export function resolveAccount(accounts: readonly UsageAccount[], provider: UsageProviderId, id?: string | null): string {
  const want = accountId(id);
  return want !== DEFAULT_ACCOUNT && accounts.some((a) => a.provider === provider && a.id === want) ? want : DEFAULT_ACCOUNT;
}

/** The accounts of one provider, the default first (listed even when never stored), then the rest in stored order. */
export function accountsOf(accounts: readonly UsageAccount[], provider: UsageProviderId, defaultLabel: string): UsageAccount[] {
  const own = accounts.filter((a) => a.provider === provider);
  const def = own.find((a) => a.id === DEFAULT_ACCOUNT) ?? { provider, id: DEFAULT_ACCOUNT, label: defaultLabel };
  return [def, ...own.filter((a) => a.id !== DEFAULT_ACCOUNT)];
}

/** Adds one account. The id comes from the label unless given. Refuses a clash, a blank label and a full list. */
export function addAccount(
  accounts: readonly UsageAccount[],
  input: { provider: UsageProviderId; label: string; source?: string; id?: string },
  sources: readonly string[],
): Result<UsageAccount[]> {
  const label = input.label.trim();
  if (!label) return { ok: false, error: "Give the account a label." };
  if (label.length > ACCOUNT_LABEL_MAX) return { ok: false, error: `A label is at most ${ACCOUNT_LABEL_MAX} characters.` };
  const id = input.id ?? slugId(label);
  if (!ACCOUNT_ID_RE.test(id)) return { ok: false, error: "That label gives no usable id; use letters or digits." };
  if (id === DEFAULT_ACCOUNT) return { ok: false, error: "The default account already exists." };
  if (input.source !== undefined && !sources.includes(input.source)) return { ok: false, error: "That source is not one of the offered ones." };
  const own = accounts.filter((a) => a.provider === input.provider);
  if (own.some((a) => a.id === id)) return { ok: false, error: "An account with that id already exists." };
  if (own.length + 1 >= ACCOUNTS_PER_PROVIDER_MAX) return { ok: false, error: `At most ${ACCOUNTS_PER_PROVIDER_MAX} accounts per provider.` };
  const next: UsageAccount = { provider: input.provider, id, label, ...(input.source !== undefined ? { source: input.source } : {}) };
  return { ok: true, value: [...accounts, next] };
}

/** Removes one account. The default one stays: it is the provider's own. */
export function removeAccount(accounts: readonly UsageAccount[], provider: UsageProviderId, id: string): Result<UsageAccount[]> {
  if (accountId(id) === DEFAULT_ACCOUNT) return { ok: false, error: "The default account cannot be removed." };
  return { ok: true, value: accounts.filter((a) => !(a.provider === provider && a.id === id)) };
}

/** Reads what a file or request holds. Keeps only the four known fields, so a stray token field is dropped, never copied. */
export function parseAccounts(raw: unknown, sources: readonly string[]): UsageAccount[] {
  if (!Array.isArray(raw)) return [];
  let out: UsageAccount[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.provider !== "string" || typeof o.label !== "string") continue;
    const step = addAccount(out, {
      provider: o.provider as UsageProviderId, label: o.label,
      id: typeof o.id === "string" ? o.id : undefined,
      source: typeof o.source === "string" && sources.includes(o.source) ? o.source : undefined,
    }, sources);
    if (step.ok) out = step.value;
  }
  return out;
}
