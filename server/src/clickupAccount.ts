/**
 * Which ClickUp account a call is for.
 *
 * The route edge resolves the repo to an account key once and enters it here;
 * every credential read in clickup.ts takes the key from this scope, so no
 * call site grows a parameter. No scope means the default account, which is
 * what the board and the card watch use: they have no repo, and polling every
 * account would cost a modest machine a request per account per tick.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { accountFor } from "./trackerAccounts.ts";
import { notConnected } from "./credentials.ts";

const scope = new AsyncLocalStorage<{ key: string }>();

/** The account key in force, or `undefined` for the default account. */
export const clickupAccount = (): string | undefined => scope.getStore()?.key;

/** Run `fn` with `key` as the account. */
export const inClickupAccount = <T>(key: string, fn: () => T): T => scope.run({ key }, fn);

/** Make `key` the account for the rest of this request. For the route edge,
 *  which is one long function and has no callback to wrap. */
export const enterClickupAccount = (key: string): void => scope.enterWith({ key });

/** What a repo's ClickUp account is: no entry → default; an entry → its key;
 *  an entry that names an account that is gone → a sentence, never the default. */
export function clickupAccountForRepo(repo: string): { ok: true; key?: string } | { ok: false; error: string } {
  let a: ReturnType<typeof accountFor>;
  try { a = accountFor(repo, "clickup"); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "The account map could not be read" }; }
  if (a.missing) return { ok: false, error: `The ClickUp account "${a.key}" chosen for ${repo} is not connected` };
  return a.key ? { ok: true, key: a.key } : { ok: true };
}

/** The not-connected sentence for the account in force: it names a named account, and says `fallback` for the default. */
export function clickupNotConnected(fallback: string): string {
  const a = clickupAccount();
  return notConnected("clickup", a ? `The ClickUp account "${a}" is not connected` : fallback, a);
}

/** The route edge: `repo` is the `?repo=` a request carried, or null. A repo with an
 *  account enters it for the rest of the request; one whose account is gone gets the
 *  sentence to send back. No repo, or no entry, changes nothing. */
export function enterForRepo(repo: string | null): { ok: false; error: string } | null {
  if (repo === null) return null;
  const a = clickupAccountForRepo(repo);
  if (!a.ok) return a;
  if (a.key) enterClickupAccount(a.key);
  return null;
}
