// Who on the tracker a GitHub login is, when "Same people as reviewers" has to put them on the card.
//
// Nobody is guessed. A GitHub login and a tracker account are different systems with different
// identities, and no email, name or nickname makes one the other (decision 2026-10-09): a wrong
// person on a card is worse than none. So a login is a card person only after the person CONFIRMED
// it once, in the card half of the picker ("Link ines-r to..."). That link is stored per tracker,
// shown where it is used, and can be changed or removed there. A login with no link is named and
// left for the person to link; it is never found.
//
// The ceiling: a link is per tracker KIND (ClickUp, Jira), not per workspace or site, and it is
// edited where the login is picked, not in a list of its own.

/** A tracker person as a link stores them: what a write sends, how the card names them, and their name. */
export interface CardMember { key: string; ident: string; name: string }
export type Links = Record<string, CardMember>;

const lc = (s: string) => s.toLowerCase();

export interface Mirrored<M> { matched: { login: string; member: M }[]; unlinked: { login: string; stale: boolean }[] }

/**
 * The picked logins as tracker people: who is linked, and who is not. Teams are not people on a card.
 * `roster` is the tracker's people when it has a list of them (ClickUp): a link to someone who is no
 * longer in it is "stale", offered for a new link. A tracker without a list (Jira, found by typing)
 * passes null and the stored person is used as it was confirmed.
 */
export function mirrorLinked<M extends CardMember>(
  picked: readonly string[], links: Links, roster: readonly M[] | null, fromLink: (m: CardMember) => M,
): Mirrored<M> {
  const out: Mirrored<M> = { matched: [], unlinked: [] };
  for (const login of picked) {
    if (login.startsWith("@")) continue;
    const link = links[lc(login)];
    if (!link) { out.unlinked.push({ login, stale: false }); continue; }
    const member = roster ? roster.find((r) => r.key === link.key) : fromLink(link);
    if (!member) { out.unlinked.push({ login, stale: true }); continue; }
    if (!out.matched.some((x) => x.member.key === member.key)) out.matched.push({ login, member });
  }
  return out;
}

/** `person` is the confirmed one; null takes the link away. Returns the new set, the old one untouched. */
export function withLink(links: Links, login: string, person: CardMember | null): Links {
  const next = { ...links };
  if (person) next[lc(login)] = { key: person.key, ident: person.ident, name: person.name };
  else delete next[lc(login)];
  return next;
}

export interface Suggestible extends CardMember { email?: string; me?: boolean }

/**
 * Who the card half offers for "Add someone" / "Link ... to": typed text narrows the tracker's people;
 * with nothing typed it is the card's current people first, then you, then the rest of the roster.
 */
export function cardSuggestions<P extends Suggestible>(o: {
  q: string; onCard: readonly P[]; roster: readonly P[] | null; found: readonly P[]; skip: readonly string[]; limit: number;
}): { person: P; why: "On the card" | "You" | null }[] {
  const q = o.q.trim().toLowerCase().replace(/^@/, "");
  const skip = new Set(o.skip);
  const seen = new Set<string>();
  const out: { person: P; why: "On the card" | "You" | null }[] = [];
  const push = (person: P, why: "On the card" | "You" | null) => {
    if (skip.has(person.key) || seen.has(person.key)) return;
    seen.add(person.key);
    out.push({ person, why });
  };
  if (q) {
    for (const p of [...(o.roster ?? []), ...o.found]) if (p.name.toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q)) push(p, o.onCard.some((c) => c.key === p.key) ? "On the card" : p.me ? "You" : null);
    return out.slice(0, o.limit);
  }
  for (const p of o.onCard) push(p, "On the card");
  for (const p of o.roster ?? []) if (p.me) push(p, "You");
  for (const p of o.roster ?? []) push(p, null);
  return out.slice(0, o.limit);
}

const KEY = (kind: string) => `agentglass.pr.cardLinks.${kind}`;

/** The confirmed links for a tracker; anything that is not the shape of one is dropped, never repaired. */
export function readLinks(kind: string): Links {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(kind)) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Links = {};
    for (const [login, v] of Object.entries(raw as Record<string, unknown>)) {
      const m = v as Partial<CardMember> | null;
      if (m && typeof m.key === "string" && typeof m.ident === "string" && typeof m.name === "string" && m.key) out[lc(login)] = { key: m.key, ident: m.ident, name: m.name };
    }
    return out;
  } catch { return {}; }
}

/** Written as the whole set; an empty one removes the key, like the board's folded lanes. */
export function writeLinks(kind: string, links: Links): void {
  try {
    if (!Object.keys(links).length) localStorage.removeItem(KEY(kind));
    else localStorage.setItem(KEY(kind), JSON.stringify(links));
  } catch { /* private mode, or a browser that has said no */ }
}
