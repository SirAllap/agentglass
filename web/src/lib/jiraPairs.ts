/*
 * The Jira account a GitHub login is, as this machine learned it: the pairs the
 * server holds (server/src/jiraPairs.ts), and which of them a picker offers first.
 *
 * A pair exists only after the person made both picks on one pull request or
 * card. Nothing is compared by name or email — a GitHub login is often a
 * pseudonym, and two accounts that share a display name are still two people.
 * With no pair for the logins at hand, the list is exactly what it was.
 */
import { api } from "./api.ts";

export type { JiraPair } from "../../../shared/providers.ts";
import type { JiraPair } from "../../../shared/providers.ts";

/**
 * The pairs that name one of these logins, most-picked first: a team is not a login, and the
 * readings of what a reviewer is paired with all take their order from here.
 */
export function reviewerPairs(logins: readonly string[], pairs: readonly JiraPair[]): JiraPair[] {
  const want = new Set(logins.filter((l) => !l.startsWith("@")).map((l) => l.toLowerCase()));
  return pairs.filter((p) => want.has(p.login.toLowerCase())).sort((a, b) => b.n - a.n || b.at - a.at);
}

/**
 * The people a picker offers, with the accounts paired to these logins first.
 * `logins` are the pull request's reviewers (already picked on GitHub); a person
 * is lifted only when their own account id is the paired one, never by a name.
 */
export function pairedFirst<P extends { id?: string | number; key?: string | number }>(people: readonly P[], o: { logins: readonly string[]; pairs: readonly JiraPair[] }): P[] {
  const order = new Map(reviewerPairs(o.logins, o.pairs).map((p, i) => [p.accountId, i] as const));
  if (!order.size) return [...people];
  const rank = (p: P) => order.get(String(p.key ?? p.id)) ?? order.size;
  return people.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/** The pairs this machine holds. Empty when the server did not answer: no suggestion beats a guess. */
export async function loadPairs(): Promise<JiraPair[]> {
  const r = await api.jiraPairs().catch(() => null);
  return r?.ok ? r.pairs ?? [] : [];
}

/**
 * The pairs one errand makes. Exactly one login has to have been picked: the account on the card
 * is that login's. Two reviewers and one account are not a pair, and learning one would put the
 * same person on the next card whose only reviewer is the other. Teams are not logins.
 */
export function pairPick(
  logins: readonly string[],
  who: { key: string | number; name: string; email?: string },
): { login: string; accountId: string; name: string; email?: string }[] {
  const people = logins.filter((l) => !l.startsWith("@"));
  if (people.length !== 1) return [];
  return [{ login: people[0]!, accountId: String(who.key), name: who.name, ...(who.email ? { email: who.email } : null) }];
}

/**
 * The accounts paired to these logins, as rows a picker can draw. Jira is searched by typing, so
 * with nothing typed no row for a learned account exists and `pairedFirst` has nothing to lift.
 */
export function pairRows(logins: readonly string[], pairs: readonly JiraPair[]): { id: string; key: string; ident: string; name: string; email?: string }[] {
  const want = new Set(logins.filter((l) => !l.startsWith("@")).map((l) => l.toLowerCase()));
  return pairs
    .filter((p) => want.has(p.login.toLowerCase()))
    .sort((a, b) => b.n - a.n || b.at - a.at)
    .map((p) => ({ id: p.accountId, key: p.accountId, ident: p.accountId, name: p.name, ...(p.email ? { email: p.email } : null) }));
}

/** One errand made these pairs: the reviewer picked on GitHub, and the Jira account put on the card with it. */
export async function recordPairs(pairs: { login: string; accountId: string; name: string; email?: string }[]): Promise<void> {
  if (!pairs.length) return;
  await api.jiraLearnPairs(pairs).catch(() => null);
}

export async function forgetPair(login: string): Promise<JiraPair[]> {
  const r = await api.jiraForgetPair(login).catch(() => null);
  return r?.ok ? r.pairs ?? [] : loadPairs();
}
