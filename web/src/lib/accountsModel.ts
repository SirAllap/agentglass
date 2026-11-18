/*
 * What the accounts section of a tracker page shows, decided here so a test can
 * read it. No tokens exist on this side: a row is who the account is.
 */

/** One stored account, as the server lists it. */
export interface AccountRow { accountKey: string; isDefault: boolean; account?: string; workspace?: string; site?: string; email?: string }
/** `repo` (lower case owner/name) to `provider` to the account key it chose. */
export type RepoAccounts = Record<string, Partial<Record<string, string>>>;

/** The same pattern the server enforces (credentials.ts ACCOUNT_KEY). */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A name for a new account, or the sentence that says why not. `null` is fine. */
export function accountNameProblem(raw: string, stored: readonly AccountRow[]): string | null {
  const name = raw.trim();
  if (!name) return "Give the account a short name, like work.";
  if (name === "primary") return "“primary” is kept for the first account. Pick another name.";
  if (!NAME.test(name)) return "Use lower-case letters, digits, - or _, up to 32.";
  if (stored.some((a) => a.accountKey === name)) return `You already have an account called ${name}.`;
  return null;
}

/** The second line of a row: where it signs in and as whom. */
export const identityLine = (a: AccountRow): string => [a.site ?? a.workspace, a.email ?? a.account].filter(Boolean).join(" · ") || "Connected";

/** The page has more to say once there is a choice to make. */
export const hasChoice = (accounts: readonly AccountRow[]): boolean => accounts.length > 1;

export interface RepoRow {
  repo: string;
  /** The select's value: "" follows the default, otherwise an account key (a removed one stays, so the select shows it). */
  value: string;
  /** The account this repo named is not stored any more. */
  removed: boolean;
  /** The line under the repo, or null. */
  note: string | null;
}

/** One row per repo: those with a choice first, then the rest, each in name order. */
export function repoRows(repos: readonly string[], map: RepoAccounts, provider: string, accounts: readonly AccountRow[]): RepoRow[] {
  const dflt = accounts.find((a) => a.isDefault)?.accountKey;
  const all = [...new Set([...repos.map((r) => r.toLowerCase()), ...Object.keys(map).filter((r) => map[r]?.[provider])])];
  const rows = all.map((repo): RepoRow => {
    const value = map[repo]?.[provider] ?? "";
    const removed = value !== "" && !accounts.some((a) => a.accountKey === value);
    return { repo, value, removed, note: removed ? `Mapped to “${value}”, which no longer exists. ${dflt ? `Uses the default (${dflt})` : "Uses the default"} until you pick one.` : null };
  });
  return rows.sort((a, b) => Number(b.value !== "") - Number(a.value !== "") || a.repo.localeCompare(b.repo));
}

/** The options of a repo's select: Default first, then every account, and the removed one when the repo still names it. */
export function repoOptions(row: RepoRow, accounts: readonly AccountRow[]): { value: string; label: string }[] {
  const dflt = accounts.find((a) => a.isDefault)?.accountKey;
  return [
    { value: "", label: dflt ? `Default (${dflt})` : "Default" },
    ...accounts.map((a) => ({ value: a.accountKey, label: a.accountKey })),
    ...(row.removed ? [{ value: row.value, label: `${row.value} (removed)` }] : []),
  ];
}
