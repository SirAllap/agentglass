/*
 * Which stored account a repository uses, per provider.
 *
 * `tracker-accounts.json` beside `tracker-projects.json`:
 * `{"acme/orbit": {"jira": "work", "clickup": "personal"}}`. A repository with
 * no entry uses the provider's default account (credentials.ts); that is the
 * absence of a choice, so it is not stored.
 *
 * Its own module and its own cache on purpose: it shares only the repo pattern
 * and the entry ceiling with trackerProjects.ts, so a read here never sees or
 * invalidates that file's state.
 *
 * Ceiling: clearing an account does not rewrite this map. An entry naming a
 * cleared account reads as `missing` (not connected, and named), never as the
 * default: a repository that asked for the work account must not quietly
 * use the personal one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "../../shared/providers.ts";
import { ACCOUNT_KEY, CREDENTIAL_PROVIDERS, accountsOf } from "./credentials.ts";
import { MAX_ENTRIES, REPO } from "./trackerProjects.ts";

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "tracker-accounts.json");
let override: string | null = null;
let cache: { stamp: string; map: AccountMap } | null = null;
/** Test seam, so a suite never reads or writes the developer's own choices. */
export function __setTrackerAccountsPath(p: string | null): void { override = p; cache = null; }
const path = (): string => {
  // Checked at call time: a suite that forgot the seam must fail, not touch ~/.config.
  if (override === null && process.env.NODE_ENV === "test") throw new Error("tracker-accounts: no test path set (__setTrackerAccountsPath)");
  return override ?? FILE;
};

type AccountMap = Record<string, Partial<Record<ProviderId, string>>>;

const stampOf = (p: string): string => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "none"; } };

/** Only well-formed entries survive a read; a broken file is an empty one. */
function read(): AccountMap {
  try {
    const p = path();
    const stamp = stampOf(p);
    if (cache && cache.stamp === stamp) return cache.map;
    const out: AccountMap = {};
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [repo, v] of Object.entries(raw as Record<string, unknown>)) {
          if (Object.keys(out).length >= MAX_ENTRIES) break;
          if (!REPO.test(repo) || !v || typeof v !== "object" || Array.isArray(v)) continue;
          const kept: Partial<Record<ProviderId, string>> = {};
          for (const [prov, key] of Object.entries(v)) {
            if ((CREDENTIAL_PROVIDERS as readonly string[]).includes(prov) && typeof key === "string" && ACCOUNT_KEY.test(key)) kept[prov as ProviderId] = key;
          }
          if (Object.keys(kept).length) out[repo.toLowerCase()] = kept;
        }
      }
    }
    cache = { stamp, map: out };
    return out;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("tracker-accounts:")) throw e;
    return {};
  }
}

/** The whole map, for a settings page. */
export const trackerAccounts = (): AccountMap => read();

/** The account `repo` names for `provider`: no entry → `{ key: null }` (the
 *  caller uses the default); named and stored → `{ key }`; named and not
 *  stored → `{ key, missing: true }`. Never falls back to the default. */
export function accountFor(repo: string, provider: ProviderId): { key: string | null; missing?: true } {
  const key = read()[repo.toLowerCase()]?.[provider];
  if (!key) return { key: null };
  return accountsOf(provider).some((a) => a.accountKey === key) ? { key } : { key, missing: true };
}

/** `null` removes the entry; a key (`primary` too) is stored; a key that is not a stored account is refused. */
export function setAccountFor(repo: unknown, provider: unknown, key: string | null): { ok: true; accounts: AccountMap } | { ok: false; error: string } {
  if (typeof repo !== "string" || !REPO.test(repo)) return { ok: false, error: "repo must be owner/name" };
  if (typeof provider !== "string" || !(CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) return { ok: false, error: "unknown provider" };
  const prov = provider as ProviderId;
  if (key !== null && (typeof key !== "string" || !ACCOUNT_KEY.test(key))) return { ok: false, error: "bad account name" };
  if (key !== null && !accountsOf(prov).some((a) => a.accountKey === key)) return { ok: false, error: `no account called ${key}` };
  const all = structuredClone(read());
  const r = repo.toLowerCase();
  if (key === null) {
    if (all[r]) { delete all[r]![prov]; if (!Object.keys(all[r]!).length) delete all[r]; }
  } else all[r] = { ...all[r], [prov]: key };
  if (Object.keys(all).length > MAX_ENTRIES) return { ok: false, error: "too many repositories" };
  const p = path();
  mkdirSync(dirname(p), { recursive: true });
  // Written beside and renamed over, so a crash leaves the old file, not half of one.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, p);
  cache = null;
  return { ok: true, accounts: all };
}

/** A seat or worker reaches only its own repository's tracker account. `ownSlug` is
 *  the `owner/name` of its own root (null when it has none); a repo named in the query
 *  or body that is not that one is refused, with the rule and where it lives. */
export function trackerRepoRefusal(confined: boolean, ownSlug: string | null | undefined, repo: string | null): string | null {
  if (!confined || repo === null) return null;
  if (ownSlug && repo.toLowerCase() === ownSlug.toLowerCase()) return null;
  return "a seat or worker uses only its own repository's tracker account (trackerRepoRefusal in server/src/trackerAccounts.ts); the person reaches the others";
}
