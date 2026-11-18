// One row per person, in every picker.
//
// Two rows under the same name are not one person when the accounts differ: the
// tracker hands over "Ada Dev" with ada@acme.test and the GitHub list hands over
// "adadev", and folding them because the names look alike would assign the card
// to one person and the pull request to another. A shared email is no better —
// two accounts in two systems are allowed to point at the same mailbox. So the
// key is the account id, or the login when the source has one, and never the
// name or the email.
//
// The line under the name is what tells them apart: the email when the source
// gives one (Jira, ClickUp; GitHub only a public one), else the login and the
// system it came from, and never an empty line.

export type PersonSource = "GitHub" | "Jira" | "ClickUp";

export interface PersonLike {
  /** The account id in its own system, or the login when that is all there is. */
  id: string | number;
  /** GitHub's handle, when the source has one. */
  login?: string;
  email?: string;
}

/** What two rows must share to be the same person. A matching email is not enough. */
export function personKey(p: PersonLike): string {
  return p.login ? `login:${p.login.toLowerCase()}` : `id:${String(p.id)}`;
}

/**
 * The rows whose name or email contains what is typed, case-insensitive. An empty
 * box is everybody: the order is the caller's, so the top row is the suggestion.
 */
export function filterPeople<T extends { name: string; email?: string }>(rows: readonly T[], q: string): T[] {
  const text = q.trim().toLowerCase();
  if (!text) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(text) || (r.email ?? "").toLowerCase().includes(text));
}

/** The first row per key, keeping the order the source gave. */
export function dedupePeople<T>(rows: readonly T[], keyOf: (row: T) => string = (row) => personKey(row as PersonLike)): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * The grey line under a name.
 *
 * `sub` is what the caller already had to say about the row (a verdict, a code
 * owner's reason); the email or the login + source comes first, because it is
 * the part that says WHICH Ada this is. Repeated pieces are dropped once.
 */
export function subline(p: { id?: string | number; email?: string; login?: string; source?: PersonSource; sub?: string }): string {
  const parts: string[] = [];
  if (p.email) parts.push(p.email);
  else {
    if (p.login) parts.push(`@${p.login}`);
    if (p.source) parts.push(p.source);
  }
  if (p.sub) parts.push(p.sub);
  return [...new Set(parts.map((x) => x.trim()).filter(Boolean))].join(" · ");
}
