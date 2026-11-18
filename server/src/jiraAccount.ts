/**
 * Which Jira account a call is for.
 *
 * Same shape as clickupAccount.ts: the route edge resolves the repo to an
 * account key once and enters it here; every credential read in the Jira
 * files takes the key from this scope, so no call site grows a parameter.
 * No scope means the default account, which is what the watchers use: they
 * have no repo, and polling every account would cost a modest machine a
 * request per account per tick.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { accountFor } from "./trackerAccounts.ts";
import { redactedAccount, secretFor } from "./credentials.ts";

const scope = new AsyncLocalStorage<{ key: string }>();

/** The account key in force, or `undefined` for the default account. */
export const jiraAccount = (): string | undefined => scope.getStore()?.key;

/** Run `fn` with `key` as the account. */
export const inJiraAccount = <T>(key: string, fn: () => T): T => scope.run({ key }, fn);

/** The secret of the account in force. */
export const jiraSecret = (): string | null => secretFor("jira", jiraAccount());

/** The notes (never the token) of the account in force. */
export const jiraNotes = () => redactedAccount("jira", jiraAccount());

/** What a repo's Jira account is: no entry → default; an entry → its key;
 *  an entry that names an account that is gone → a sentence, never the default. */
export function jiraAccountForRepo(repo: string): { ok: true; key?: string } | { ok: false; error: string } {
  let a: ReturnType<typeof accountFor>;
  try { a = accountFor(repo, "jira"); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "The account map could not be read" }; }
  if (a.missing) return { ok: false, error: `The Jira account "${a.key}" chosen for ${repo} is not connected` };
  return a.key ? { ok: true, key: a.key } : { ok: true };
}

/** The repo a Jira request names: in the query, or for a POST in its JSON body, as a ClickUp write does. Reads a clone, so the route still gets the body. */
export async function repoOfJiraRequest(req: Request, url: URL): Promise<string | null> {
  const q = url.searchParams.get("repo");
  if (q !== null || req.method !== "POST") return q;
  const b = await req.clone().json().catch(() => null) as { repo?: unknown } | null;
  return typeof b?.repo === "string" ? b.repo : null;
}

/** The route edge: `repo` is the `?repo=` a request carried, or null. A repo with an
 *  account enters it for the rest of the request; one whose account is gone gets the
 *  sentence to send back. No repo, or no entry, changes nothing. */
export function enterJiraForRepo(repo: string | null): { ok: false; error: string } | null {
  if (repo === null) return null;
  const a = jiraAccountForRepo(repo);
  if (!a.ok) return a;
  if (a.key) scope.enterWith({ key: a.key });
  return null;
}
