// The free-text match of a pull request list, shared by the desktop's filter
// bar and the phone's search box so the two cannot answer the same words
// differently. Pure and structural: it asks for the few fields it reads, not
// for a whole PrSummary, and a row from a fixture or an older cache may carry
// neither `assignees` nor `reviewers`.
//
// Matches number, title, author, head branch, assignee and requested reviewer,
// case-insensitively. A leading "#" is dropped first, because "#595" is how a
// number is written everywhere a person copies one from.
//
// Ceiling: one substring, not a query language. Words are not split, so
// "dock orbit" finds only a row containing that exact run.
export interface PrTextFields {
  number: number;
  title: string;
  author: string;
  headRefName?: string;
  assignees?: string[];
  reviewers?: { login: string }[];
}

export function prTextMatch(p: PrTextFields, text: string): boolean {
  const q = text.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  const has = (s: string | undefined): boolean => !!s && s.toLowerCase().includes(q);
  if (String(p.number).includes(q) || has(p.title) || has(p.author) || has(p.headRefName)) return true;
  return (p.assignees ?? []).some(has) || (p.reviewers ?? []).some((r) => has(r.login));
}
