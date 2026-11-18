/*
 * The extra usage accounts a person added, on disk.
 *
 * Holds {provider, id, label, source} and nothing else: `source` is the NAME of
 * a credential source ("claude-login", "env"), never a credential, a path or a
 * token. Same file rules as usagekey.ts: written 0600 through a rename. The
 * default account is not stored; an absent id means default.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addAccount, parseAccounts, removeAccount, type UsageAccount } from "../../shared/usageAccounts.ts";
import type { UsageProviderId } from "../../shared/orchestration.ts";

/** The source names an account may read from, per provider. Names only. */
export const ACCOUNT_SOURCES: Partial<Record<UsageProviderId, readonly { id: string; label: string }[]>> = {
  anthropic: [{ id: "claude-login", label: "Claude Code login" }, { id: "env", label: "Environment variable" }],
  codex: [{ id: "codex-login", label: "Codex login" }, { id: "env", label: "Environment variable" }],
};
const sourceIds = (p: UsageProviderId): string[] => (ACCOUNT_SOURCES[p] ?? []).map((s) => s.id);
const allSourceIds = (): string[] => [...new Set(Object.values(ACCOUNT_SOURCES).flatMap((l) => (l ?? []).map((s) => s.id)))];

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "usage-accounts.json");
let overridePath: string | null = null;
/** Test seam: point the store somewhere disposable. */
export function __setUsageAccountsPath(p: string | null): void { overridePath = p; }
const path = (): string => overridePath ?? FILE;

export function usageAccounts(): UsageAccount[] {
  try { return parseAccounts(JSON.parse(readFileSync(path(), "utf8")), allSourceIds()); } catch { return []; }
}

function save(list: UsageAccount[]): void {
  const p = path();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

type Out = { ok: true; accounts: UsageAccount[] } | { ok: false; error: string };

/** The source has to be one this provider offers; the shared check only knows the union. */
export function addUsageAccount(input: { provider: UsageProviderId; label: string; source?: string }): Out {
  if (input.source !== undefined && !sourceIds(input.provider).includes(input.source)) return { ok: false, error: "That source is not offered for this provider." };
  const r = addAccount(usageAccounts(), input, allSourceIds());
  if (!r.ok) return r;
  save(r.value);
  return { ok: true, accounts: r.value };
}

export function removeUsageAccount(provider: UsageProviderId, id: string): Out {
  const r = removeAccount(usageAccounts(), provider, id);
  if (!r.ok) return r;
  save(r.value);
  return { ok: true, accounts: r.value };
}
