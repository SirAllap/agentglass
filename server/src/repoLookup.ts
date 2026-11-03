/*
 * "Is this a repository I can read?" for the Open projects dialog, asked of a
 * name that has no checkout on this machine.
 *
 * REST only (`gh api repos/<o>/<r>`, never graphql, never `gh repo view`), so
 * the GraphQL hold in `gh()` can never block it and it spends the separate REST
 * core budget. Read-only calls, argv only, and the name is validated before a
 * process is spawned.
 *
 * Only a SUCCESS is cached (60 s, by lowercased name): a failure that stuck for
 * a minute would turn "sign in, then retry" into a wait.
 */
import { gh, ghCapabilityCached, type GhResult } from "./prs.ts";

export type LookupError = "not-found" | "no-access" | "gh-not-signed-in" | "gh-missing" | "unreachable" | "bad-repo";
export type RepoLookup =
  | { found: true; repo: string; private: boolean; description: string; defaultBranch: string; openPrs?: number }
  | { found: false; error: LookupError; /** The `gh` account that was refused, for the no-access card. */ account?: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** One budget for the whole lookup (repo call, count, account), not 8 s per call. */
const LOOKUP_MS = Number(process.env.AGX_REPO_LOOKUP_MS) || 8_000;
const KEEP_MS = 60_000;
/** Ceiling on remembered answers: the list is capped at 30, but a person can type any name. */
const KEEP_MAX = Number(process.env.AGX_REPO_KEEP_MAX) || 200;

export function validRepo(s: string): boolean {
  const [o, n, ...rest] = s.split("/");
  return !rest.length && !!o && !!n && OWNER.test(o) && NAME.test(n) && n !== "." && n !== "..";
}

/** The one place a failed `gh api` becomes a sentence the dialog can draw. */
export function lookupError(r: GhResult | "timeout"): LookupError {
  if (r === "timeout") return "unreachable";
  if (r.code === 127) return "gh-missing";
  const text = `${r.stderr}\n${r.stdout}`;
  // GitHub answers a spent budget (primary or secondary) with 403 too: that is "try later", not "not yours".
  if (/rate limit/i.test(text)) return "unreachable";
  if (/HTTP 401|auth login|not logged in|no oauth token/i.test(text)) return "gh-not-signed-in";
  if (/HTTP 404/.test(text)) return "not-found";
  if (/HTTP 403|SAML|Resource not accessible/.test(text)) return "no-access";
  return "unreachable";
}

/** `gh` with what is left of the shared deadline; it kills its own process at the end of it. */
async function bounded(args: string[], deadline: number): Promise<GhResult | "timeout"> {
  const left = deadline - Date.now();
  if (left <= 0) return "timeout";
  const r = await gh(args, undefined, undefined, left);
  return Date.now() >= deadline && r.code !== 0 && !r.stderr.trim() ? "timeout" : r;
}

/** The signed-in account, for the no-access card; skipped when the deadline is spent. */
async function accountWithin(deadline: number): Promise<string | undefined> {
  const cached = ghCapabilityCached();
  if (cached) return cached.login;
  const left = deadline - Date.now();
  if (left <= 0) return undefined;
  // Its own call rather than ghCapability(): that one cannot be given the time
  // that is left, so a lost race would leave `gh auth status` running. Not
  // cached either — an answer cut short must not read as "not logged in".
  const r = await gh(["auth", "status", "--active"], undefined, undefined, left);
  if (r.code !== 0) return undefined;
  const out = r.stdout + r.stderr;
  return (out.match(/account\s+(\S+)/i) || out.match(/as\s+(\S+)\s/i))?.[1];
}

const kept = new Map<string, { at: number; answer: RepoLookup }>();
/** For the test of the ceiling. */
export const keptCount = (): number => kept.size;

export async function repoLookup(repo: string, fresh = false): Promise<RepoLookup> {
  if (!validRepo(repo)) return { found: false, error: "bad-repo" };
  const key = repo.toLowerCase();
  const hit = kept.get(key);
  if (!fresh && hit && Date.now() - hit.at < KEEP_MS) return hit.answer;
  const deadline = Date.now() + LOOKUP_MS;
  const r = await bounded(["api", `repos/${repo}`], deadline);
  if (r === "timeout" || r.code !== 0 || !r.stdout.trim()) {
    const error = lookupError(r);
    const account = error === "no-access" ? await accountWithin(deadline) : undefined;
    return { found: false, error, ...(account ? { account } : {}) };
  }
  let body: { full_name?: string; private?: boolean; description?: string | null; default_branch?: string };
  try { body = JSON.parse(r.stdout); } catch { return { found: false, error: "unreachable" }; }
  const answer: RepoLookup = {
    found: true,
    repo: typeof body.full_name === "string" && validRepo(body.full_name) ? body.full_name : repo,
    private: body.private === true,
    description: body.description ?? "",
    defaultBranch: body.default_branch ?? "",
  };
  // The count is a courtesy: when it fails the repository is still found.
  const c = await bounded(["api", `search/issues?q=repo:${repo}+type:pr+state:open&per_page=1`], deadline);
  if (c !== "timeout" && c.code === 0) {
    try { const n = JSON.parse(c.stdout).total_count; if (Number.isInteger(n)) answer.openPrs = n; } catch { /* leave it out */ }
  }
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at >= KEEP_MS) kept.delete(k);
  while (kept.size >= KEEP_MAX) kept.delete(kept.keys().next().value as string);
  kept.set(key, { at: now, answer });
  return answer;
}
