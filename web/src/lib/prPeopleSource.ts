// What the repository knows about who can be asked, shaped for askView.
//
// The old reviewer picker did three things before it drew a row: it read
// CODEOWNERS and floated the owners of the changed files, it put the people who
// had already reviewed ahead of the collaborator list (a stale approval before
// every other past reviewer, because that is the "yes" the pull request no
// longer really has), and it lifted the colleagues this person reaches for
// every day. All of that is kept; it just ends in the three things the shared
// picker draws: "Already asked", "Suggested" with a reason line, and "Teams".
//
// The ceiling: a CODEOWNERS team is named, not counted (the file holds no
// membership), and "Suggested" is owners then habit, nothing smarter.
import type { AskMode, Asked, Person, Suggestion, Team } from "./prAskWho.ts";
import type { ReviewerRow } from "./prReviewers.ts";
import { loginOf } from "./codeowners.ts";
import { rankPeople, type PersonUse } from "./personUsage.ts";

export interface SourceInput {
  mode: AskMode;
  author: string;
  /** `reviewerRoster(d)`: everybody asked or who has reviewed, with where each stands. */
  roster: readonly ReviewerRow[];
  /** ISO time of the last commit: an approval older than it is stale. */
  lastCommitAt?: string;
  /** The repository's collaborators (what a review can be asked of). */
  users: readonly string[];
  /** The logins GitHub offers as assignees. */
  assignable: readonly string[];
  /** Assignees on the pull request now. */
  assigned: readonly string[];
  /** `ownersOf(rules, changedPaths)`. */
  owners: readonly { owner: string; paths: readonly string[] }[];
  use: PersonUse;
  now?: number;
}

export interface Source { people: Person[]; teams: Team[]; asked: Asked[]; assigned: string[]; suggested: Suggestion[] }

const lc = (s: string) => s.toLowerCase();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Past reviewers, an approval the new commits outran first, then by recency; those still awaited last. */
export function askedOrder(roster: readonly ReviewerRow[], lastCommitAt?: string): Asked[] {
  const rows = roster.filter((r) => !r.isBot && !r.isTeam);
  const past = rows.filter((r) => r.state !== "awaiting");
  const stale = past.filter((r) => r.state === "approved" && r.at && lastCommitAt && r.at < lastCommitAt);
  const byRecent = (xs: ReviewerRow[]) => [...xs].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return [...byRecent(stale), ...byRecent(past.filter((r) => !stale.includes(r))), ...rows.filter((r) => r.state === "awaiting")]
    .map((r) => ({ login: r.login, state: r.state }));
}

export function askSource(i: SourceInput): Source {
  const reviewing = i.mode === "reviewers";
  const logins = [...new Set(reviewing ? i.users : i.assignable)];
  const people: Person[] = logins.map((login) => ({ login }));
  const known = new Set(logins.map(lc));

  const teams: Team[] = [];
  const suggested: Suggestion[] = [];
  const seen = new Set<string>();
  if (reviewing) {
    for (const o of i.owners) {
      const login = loginOf(o.owner);
      if (!login) { teams.push({ slug: o.owner.replace(/^@/, "") }); continue; }
      if (!known.has(lc(login)) || seen.has(lc(login))) continue;
      seen.add(lc(login));
      suggested.push({ login, reason: `Code owner of ${o.paths.length === 1 ? o.paths[0] : plural(o.paths.length, "changed file")}` });
    }
  }
  const habit = reviewing ? "You ask them often" : "You assign them often";
  for (const login of rankPeople(logins, i.use, i.now).frequent) {
    if (seen.has(lc(login))) continue;
    seen.add(lc(login));
    suggested.push({ login, reason: habit });
  }

  return {
    people, teams, suggested,
    asked: reviewing ? askedOrder(i.roster, i.lastCommitAt) : [],
    assigned: reviewing ? [] : [...i.assigned],
  };
}
