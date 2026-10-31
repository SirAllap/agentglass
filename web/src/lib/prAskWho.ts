// Who a pull request can be asked of, decided apart from the picker.
//
// One picker serves "Request a review" and "Assign". The rows it lists, the
// sections they fall into and the ones that cannot be chosen all follow from
// the people the repository has, who is already asked, who is picked and what
// has been typed, so that is here and the picker only draws it.
//
// GitHub refuses a review from the person who opened the pull request, and its
// own picker does not list them. This one lists them, greyed, with the reason:
// a row that is missing leaves the question of where they went. The comparison
// is `withoutAuthor` from reviewerPick.ts, so the two never disagree. As an
// assignee the author is fine.
//
// The ceiling: teams are asked for review only (GitHub assigns people, not
// teams), and a team's members are a count, never expanded.
import type { ReviewerState } from "./prReviewers.ts";
import { withoutAuthor } from "./reviewerPick.ts";

export type AskMode = "reviewers" | "assignees";

export interface Person { login: string; name?: string }
/** `members` is a count when the repository's teams were read; a CODEOWNERS team has only a name. */
export interface Team { slug: string; members?: number }
export interface Asked { login: string; state: ReviewerState }
export interface Suggestion { login: string; reason: string }

export interface AskInput {
  mode: AskMode;
  /** Login of whoever opened the pull request. */
  author: string;
  /** The person at the keys opened it: changes who the author's reason is about. */
  viewerDidAuthor?: boolean;
  /** `owner/name`, for the sentence that says who cannot be asked. */
  repo: string;
  people: Person[];
  teams: Team[];
  /** Reviewers already asked, with where each stands. Reviewers mode only. */
  asked?: Asked[];
  /** Logins already on the pull request as assignees. Assignees mode only. */
  assigned?: string[];
  suggested?: Suggestion[];
  /** Logins and `@org/team` slugs picked so far, in the order they were picked. */
  picked: string[];
  query: string;
}

export type SectionId = "asked" | "suggested" | "teams" | "everyone" | "results";

export interface AskRow {
  /** What is picked and sent: a login, or `@org/team`. */
  id: string;
  kind: "person" | "team";
  /** The first line. */
  label: string;
  /** The grey line under it: `@login`, a reason, "4 people". */
  sub: string;
  picked: boolean;
  /** Why this row cannot be chosen; absent when it can. */
  disabled?: string;
  /** Reviewed or awaiting, for the "Already asked" rows. */
  state?: ReviewerState;
  /** Asking again makes sense: they have reviewed since. */
  canRerequest?: boolean;
  /** Already on the pull request in this role: not picked again, and the keys walk past it. */
  held?: boolean;
  /** Taking them off makes sense: a review not yet given, or an assignee. */
  canRemove?: boolean;
  /** Where the typed text matched, in the first line, for the highlight. */
  mark?: [number, number];
}

export interface AskSection { id: SectionId; title: string; rows: AskRow[] }

export interface AskChip { id: string; label: string; team: boolean; remove: string }

export interface AskView {
  sections: AskSection[];
  /** Every row in reading order, for the keyboard. */
  rows: AskRow[];
  chips: AskChip[];
  chipsHint: string;
  /** Typed something and nothing matched. */
  empty: { title: string; hint: string } | null;
}

const lc = (s: string) => s.trim().toLowerCase();
const teamId = (slug: string) => (slug.startsWith("@") ? slug : `@${slug}`);

const ASKED_SAID: Record<ReviewerState, string> = {
  approved: "approved", changes: "changes requested", awaiting: "awaiting", commented: "commented", dismissed: "dismissed",
};

/** First occurrence of the query in `text`, ignoring case; null when it is not there. */
function find(text: string, q: string): [number, number] | null {
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q);
  return at < 0 ? null : [at, at + q.length];
}

export function askView(i: AskInput): AskView {
  const reviewing = i.mode === "reviewers";
  const q = lc(i.query).replace(/^@/, "");
  const picked = new Set(i.picked);
  const askable = new Set(withoutAuthor(i.people.map((p) => ({ value: p.login })), reviewing ? i.author : undefined).map((o) => lc(o.value)));
  const askedBy = new Map((reviewing ? i.asked ?? [] : []).map((a) => [lc(a.login), a.state]));
  const assigned = new Set((reviewing ? [] : i.assigned ?? []).map(lc));

  const personRow = (p: Person, sub?: string): AskRow => {
    const named = !!p.name && lc(p.name) !== lc(p.login);
    const state = askedBy.get(lc(p.login));
    const row: AskRow = {
      id: p.login, kind: "person", label: named ? p.name! : p.login,
      sub: sub ?? (state ? ASKED_SAID[state] : named ? `@${p.login}` : ""),
      picked: picked.has(p.login),
    };
    if (!askable.has(lc(p.login))) {
      row.disabled = i.viewerDidAuthor
        ? "You opened this pull request, so you cannot ask yourself."
        : `${i.author} opened this pull request, so they cannot be asked.`;
    }
    if (state) { row.state = state; row.held = true; row.canRerequest = state !== "awaiting"; row.canRemove = state === "awaiting"; }
    if (assigned.has(lc(p.login))) { row.held = true; row.canRemove = true; if (!row.sub) row.sub = "Assigned"; }
    return row;
  };
  const teamRow = (t: Team): AskRow => ({
    id: teamId(t.slug), kind: "team", label: teamId(t.slug),
    sub: t.members == null ? "Team" : `${t.members} ${t.members === 1 ? "person" : "people"}`, picked: picked.has(teamId(t.slug)),
  });

  const chips: AskChip[] = i.picked.map((id) => {
    const person = i.people.find((p) => p.login === id);
    return { id, label: person?.name && lc(person.name) !== lc(id) ? person.name : id, team: id.startsWith("@"), remove: `Remove ${id}` };
  });
  const base = { chips, chipsHint: "Nobody picked yet" };

  if (q) {
    const scored = (text: string, login: string) => {
      const l = lc(login), t = lc(text);
      return l.startsWith(q) ? 0 : t.startsWith(q) ? 1 : l.includes(q) ? 2 : t.includes(q) ? 3 : -1;
    };
    const hits: { row: AskRow; score: number }[] = [];
    for (const p of i.people) {
      const row = personRow(p);
      const score = scored(p.name ?? "", p.login);
      if (score < 0) continue;
      const mark = find(row.label, q) ?? undefined;
      hits.push({ row: mark ? { ...row, mark } : row, score });
    }
    if (reviewing) {
      for (const t of i.teams) {
        const row = teamRow(t);
        const score = scored(t.slug, t.slug.replace(/^@/, ""));
        if (score >= 0) hits.push({ row: { ...row, mark: find(row.label, q) ?? undefined }, score });
      }
    }
    /* Stable by score: the people list's own order breaks ties. */
    const rows = hits.map((h, n) => ({ ...h, n })).sort((a, b) => a.score - b.score || a.n - b.n).map((h) => h.row);
    return {
      ...base, rows, sections: rows.length ? [{ id: "results", title: "", rows }] : [],
      empty: rows.length ? null : {
        title: `No one matches “${i.query.trim()}”`,
        hint: `Try a name or @login. People outside ${i.repo} cannot be asked.`,
      },
    };
  }

  const sections: AskSection[] = [];
  const used = new Set<string>();
  const take = (rows: AskRow[]) => { for (const r of rows) used.add(lc(r.id)); return rows; };

  const personOf = (login: string) => i.people.find((x) => lc(x.login) === lc(login)) ?? { login };
  if (reviewing && askedBy.size) {
    const rows = take((i.asked ?? []).map((a) => personRow(personOf(a.login))));
    sections.push({ id: "asked", title: "Already asked", rows });
  } else if (!reviewing && i.assigned?.length) {
    const rows = take(i.assigned.map((l) => personRow(personOf(l))));
    sections.push({ id: "asked", title: "Already assigned", rows });
  }
  const suggested = take((i.suggested ?? [])
    .filter((s) => !used.has(lc(s.login)) && askable.has(lc(s.login)))
    .flatMap((s) => {
      const p = i.people.find((x) => lc(x.login) === lc(s.login));
      return p ? [personRow(p, s.reason)] : [];
    }));
  if (suggested.length) sections.push({ id: "suggested", title: "Suggested", rows: suggested });
  if (reviewing && i.teams.length) sections.push({ id: "teams", title: "Teams", rows: i.teams.map(teamRow) });
  const everyone = i.people.filter((p) => !used.has(lc(p.login))).map((p) => personRow(p));
  if (everyone.length) {
    sections.push({ id: "everyone", title: suggested.length ? "Everyone" : "Nobody to suggest here. Everyone", rows: everyone });
  }
  return { ...base, sections, rows: sections.flatMap((s) => s.rows), empty: null };
}

/**
 * Pick or unpick. A row that cannot be asked is not picked, so a click or an
 * Enter on it changes nothing; the picked order is the order they were chosen in.
 */
export function togglePick(picked: string[], row: Pick<AskRow, "id" | "disabled" | "held">): string[] {
  if (row.disabled || row.held) return picked;
  return picked.includes(row.id) ? picked.filter((x) => x !== row.id) : [...picked, row.id];
}

/** Backspace in an empty search box takes the last chip off. */
export function dropLast(picked: string[], query: string): string[] {
  return query === "" && picked.length ? picked.slice(0, -1) : picked;
}

/**
 * The row the arrow keys land on: the next one that can be chosen, wrapping.
 * `from` is the current index, or -1 for none; -1 with a step back starts at the end.
 */
export function stepRow(rows: readonly Pick<AskRow, "disabled" | "held">[], from: number, step: 1 | -1): number {
  const n = rows.length;
  if (!n) return -1;
  const start = from < 0 && step < 0 ? 0 : from;
  for (let k = 1; k <= n; k++) {
    const at = (((start + step * k) % n) + n) % n;
    if (!rows[at].disabled && !rows[at].held) return at;
  }
  return -1;
}
