// What to offer while somebody types an address.
//
// Pure, and separate from both the store and the bar, because the ranking is
// the feature: with fifteen thousand pages in the list, "does it contain what
// I typed" matches hundreds and is useless. What people mean by a browser that
// completes well is that the FIRST row is the one they wanted.

export interface Place {
  url: string;
  title: string;
  visits: number;
  /** Seconds since 1970, or 0. */
  lastAt: number;
  bookmarked: boolean;
}

export interface Suggestion extends Place {
  /** Why it is here, so the row can say so rather than looking arbitrary. */
  why: "host" | "bookmark" | "title" | "url" | "search";
  score: number;
  /** For a "search" row: the term you searched, so the bar can offer it back as
   *  a query rather than the long results URL it is stored as. */
  query?: string;
}

/**
 * Your past searches, recovered from where they already are.
 *
 * A search you ran is in history as its results page —
 * `google.com/search?q=react+hooks`. Importing history already brought those
 * across; what was missing is treating them AS searches: pulling the term back
 * out so the bar can offer "react hooks" instead of a hundred-character URL,
 * and — the actual bug — not collapsing every one of them into a single
 * `google.com` row under the per-host de-dup. Measured on this machine: 969 of
 * the fifteen thousand imported pages are search results, all on two hosts.
 *
 * Only the results path counts. Google carries `?q=` on maps and images too,
 * and those are places you went, not searches you'd re-run from the bar.
 */
const SEARCH_ENGINES: { host: RegExp; param: string; path?: RegExp }[] = [
  { host: /(^|\.)google\.[a-z.]+$/, param: "q", path: /^\/search\b/ },
  { host: /(^|\.)bing\.com$/, param: "q", path: /^\/search\b/ },
  { host: /(^|\.)duckduckgo\.com$/, param: "q" },
  { host: /(^|\.)search\.brave\.com$/, param: "q" },
  { host: /(^|\.)ecosia\.org$/, param: "q" },
  { host: /(^|\.)qwant\.com$/, param: "q" },
  { host: /(^|\.)startpage\.com$/, param: "query" },
  { host: /(^|\.)search\.yahoo\.[a-z.]+$/, param: "p" },
];

export function searchTerm(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./i, "");
  const eng = SEARCH_ENGINES.find((e) => e.host.test(host));
  if (!eng) return null;
  if (eng.path && !eng.path.test(u.pathname)) return null;
  const raw = u.searchParams.get(eng.param);
  if (raw === null) return null;
  const term = raw.replace(/\s+/g, " ").trim();
  // Too short to rank on; too long to be a query somebody typed on purpose.
  return term.length >= 2 && term.length <= 120 ? term : null;
}

/** How many past searches a completion list may show, so they inform the list
 *  rather than becoming it — the rest of the eight rows are for sites. */
export const SEARCH_MAX = 4;

/** The bit of a URL somebody is actually typing at: no scheme, no `www.`, and
 *  the trailing slash gone. Typing `github` should match `https://github.com/`
 *  on its first character, not its ninth. */
export function typedHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/**
 * How well one page answers what was typed.
 *
 * The shape of it: WHERE the match landed dominates, and how often you go
 * there breaks the ties. A host that starts with what you typed is what you
 * meant; the same letters buried in a query string almost never are.
 *
 * Zero means "do not show this at all", which is a different answer from a low
 * score and is why this returns 0 rather than a small number for a miss.
 */
export function score(p: Place, q: string): { score: number; why: Suggestion["why"] } {
  const query = q.trim().toLowerCase();
  if (!query) return { score: 0, why: "url" };
  const short = typedHost(p.url).toLowerCase();
  const host = short.split("/")[0] ?? "";
  const title = p.title.toLowerCase();

  // A visit count grows without limit and would otherwise swamp every
  // positional signal — a page seen 431 times outranking an exact host match.
  // Logarithmic, so the hundredth visit counts for much less than the second.
  const popular = Math.log2(1 + Math.max(0, p.visits)) * 4;
  const kept = p.bookmarked ? 30 : 0;

  if (host.startsWith(query)) return { score: 1000 + popular + kept, why: "host" };
  if (short.startsWith(query)) return { score: 800 + popular + kept, why: "url" };
  if (p.bookmarked && title.includes(query)) return { score: 620 + popular, why: "bookmark" };
  if (host.includes(query)) return { score: 500 + popular + kept, why: "host" };
  // A past search, matched on the term you typed at rather than on the results
  // URL it is stored as. Ranked around a title match — below the site itself
  // (so typing "google" still gives you google.com, not your searches) but
  // above a stray substring buried in some other page's path.
  const term = searchTerm(p.url);
  if (term) {
    const t = term.toLowerCase();
    if (t.startsWith(query)) return { score: 380 + popular, why: "search" };
    if (t.includes(query)) return { score: 300 + popular, why: "search" };
  }
  if (title.startsWith(query)) return { score: 400 + popular + kept, why: "title" };
  if (title.includes(query)) return { score: 250 + popular + kept, why: "title" };
  if (short.includes(query)) return { score: 120 + popular + kept, why: "url" };
  return { score: 0, why: "url" };
}

/** How many rows a completion list may have. Past about eight it stops being
 *  a suggestion and becomes a page of search results you have to read. */
export const SUGGEST_MAX = 8;

/**
 * The rows to offer, best first.
 *
 * One per host among the top few, because five pages of the same site is the
 * other way a completion list wastes its space — you almost never want the
 * fourth-deepest page of a domain you have not finished typing.
 */
export function suggest(places: Place[], q: string, max = SUGGEST_MAX): Suggestion[] {
  const query = q.trim();
  if (query.length < 1) return [];
  const hits: Suggestion[] = [];
  for (const p of places) {
    const { score: s, why } = score(p, query);
    if (s > 0) hits.push({ ...p, score: s, why, ...(why === "search" ? { query: searchTerm(p.url) ?? undefined } : {}) });
  }
  hits.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt || a.url.length - b.url.length);

  const out: Suggestion[] = [];
  const hosts = new Set<string>();
  const terms = new Set<string>();
  let searches = 0;
  for (const h of hits) {
    if (h.why === "search") {
      // De-duped by TERM, not host — the whole point, since every google search
      // shares one host and the host rule would show only the first. Capped so a
      // list of past searches never crowds out the sites.
      const term = (h.query ?? "").toLowerCase();
      if (terms.has(term) || searches >= SEARCH_MAX) continue;
      terms.add(term);
      searches++;
    } else {
      const host = typedHost(h.url).split("/")[0] ?? "";
      // A bookmark earns its place even when its host is already represented:
      // it was kept on purpose, which is a stronger signal than a repeat visit.
      if (hosts.has(host) && !h.bookmarked) continue;
      hosts.add(host);
    }
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}
