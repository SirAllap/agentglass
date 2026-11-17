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
  /** Set when this page is already open in another of the person's tabs: the row
   *  says "Switch to tab" and choosing it shows that tab rather than navigating. */
  tabId?: string;
}

/** The part of a tab the omnibox needs. */
export interface OpenTab { id: string; url: string; title?: string; agent?: string }

/** Origin (any case) + path (case kept) + query, with the path's trailing slash
 *  and any hash gone except an SPA route (`#/…`, `#!…`): the same page as far as "is it already open" goes.
 *  `?q=a` and `?q=b` are two pages. Null for what is not a web page. */
export function tabKey(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}${/^#[/!]/.test(u.hash) ? u.hash : ""}`;
}

/** The key an omnibox row for a live tab carries. */
export const tabRowKey = (id: string): string => `t:${id}`;

/** True when a "Switch to tab" suggestion points at a tab the list already shows
 *  as an "open" row, so one tab never appears twice. */
export function listedAsTab(rows: { key: string }[], s: Suggestion): boolean {
  return !!s.tabId && rows.some((r) => r.key === tabRowKey(s.tabId!));
}

/** The tabs a row may offer to switch to: not the current one, not an agent's
 *  (`agent` is set while an agent is the last to drive it), one per page. */
export function switchable(tabs: OpenTab[], currentId: string): OpenTab[] {
  const seen = new Set<string>();
  const out: OpenTab[] = [];
  for (const t of tabs) {
    if (t.id === currentId || t.agent) continue;
    const k = tabKey(t.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
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
export function score(p: Place, q: string, now = Date.now() / 1000): { score: number; why: Suggestion["why"] } {
  const query = q.trim().toLowerCase();
  if (!query) return { score: 0, why: "url" };
  const short = typedHost(p.url).toLowerCase();
  const host = short.split("/")[0] ?? "";
  const title = p.title.toLowerCase();

  // A visit count grows without limit and would otherwise swamp every
  // positional signal — a page seen 431 times outranking an exact host match.
  // Logarithmic, so the hundredth visit counts for much less than the second.
  const popular = Math.log2(1 + frecency(p, now) / 100) * 4;
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

/**
 * Frecency: how often you went, weighted by how recently. A page seen forty
 * times last year should beat one seen once a minute ago, and a page seen
 * forty times this week should beat both. Buckets, as Firefox does, because a
 * smooth curve here is precision nobody can see in the order.
 */
export function frecency(p: Place, now = Date.now() / 1000): number {
  const visits = Math.max(0, p.visits);
  if (!p.lastAt) return visits * 50; // age unknown: neither fresh nor stale
  const days = Math.max(0, (now - p.lastAt) / 86400);
  const weight = days < 4 ? 100 : days < 14 ? 70 : days < 31 ? 50 : days < 90 ? 30 : 10;
  return visits * weight;
}

const JUNK_HOST = /(^|\.)s3[.-][a-z0-9-]*\.?amazonaws\.com$|\.s3\.amazonaws\.com$|user-?asset|usercontent/i;
const JUNK_FILE = /\.(zip|gz|tgz|tar|7z|rar|dmg|exe|msi|pkg|deb|apk|iso|png|jpe?g|gif|webp|svg|ico|mp4|mov|webm|mp3|wav|woff2?|ttf|pdf|csv|bin)$/i;
// Hex of 24+, a UUID, or a 32+ run of letters AND digits with no hyphen. A plain
// hyphenated slug ("how-to-configure-the-widget") is a page, never junk.
const JUNK_HASH = /^[a-f0-9]{24,}$|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const JUNK_MIXED = /^[A-Za-z0-9_]{32,}$/;
const isHash = (x: string): boolean => JUNK_HASH.test(x) || (JUNK_MIXED.test(x) && /\d/.test(x) && /[A-Za-z]/.test(x));
// A hash only condemns a page on a host that serves assets, or under a path that
// reads as a download. /commit/<sha> on a normal site is a page.
const ASSET_LABEL = /^(cdn\d*|assets?|static|media|files?|blobs?|storage|bucket|downloads?|dl|uploads?)$/i;
// blob/raw are code-host permalinks (/blob/<sha>/src/a.ts), pages on a normal host.
// On an asset host they are still caught by JUNK_HOST / ASSET_LABEL above.
const DOWNLOAD_SEG = /^(downloads?|dl|files?|assets?|attachments?|uploads?|objects?)$/i;

/** A blob or asset address: never what somebody means by typing a site name. */
export function isJunk(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (JUNK_HOST.test(u.hostname)) return true;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length && JUNK_FILE.test(segs[segs.length - 1]!)) return true;
  if (!segs.some(isHash)) return false;
  return u.hostname.split(".").some((l) => ASSET_LABEL.test(l)) || segs.some((x) => DOWNLOAD_SEG.test(x));
}

const siteOf = (url: string): string => (typedHost(url).split("/")[0] ?? "").toLowerCase();
const sameKey = (p: Place): string => typedHost(p.url).toLowerCase().replace(/#.*$/, "");

/** What parsing a URL costs, paid once per place object: a new list (the store
 *  hands one over when history changes) is the only thing that re-parses. */
interface Facts { junk: boolean; site: string; term: string | null; www: boolean }
const facts = new WeakMap<Place, Facts>();
function factsOf(p: Place): Facts {
  let f = facts.get(p);
  if (!f) { f = { junk: isJunk(p.url), site: siteOf(p.url), term: searchTerm(p.url), www: /^https?:\/\/www\./i.test(p.url) }; facts.set(p, f); }
  return f;
}

/** The visited site whose host starts with what was typed and that you use most,
 *  or null. Shared by the first row and by the inline completion so the two
 *  cannot disagree about which site "git" means. */
type Top = { host: string; pages: Place[]; www: boolean } | null;
let topMemo: { places: Place[]; prefix: string; top: Top } | null = null;
/** One pass per keystroke: the completion (onChange) and the rows (render) ask
 *  for the same site, so the second ask is the first one's answer. */
function topSite(places: Place[], prefix: string, now = Date.now() / 1000): Top {
  if (topMemo && topMemo.places === places && topMemo.prefix === prefix) return topMemo.top;
  const top = findTop(places, prefix, now);
  topMemo = { places, prefix, top };
  return top;
}
function findTop(places: Place[], prefix: string, now: number): Top {
  const by = new Map<string, Place[]>();
  for (const p of places) {
    const fa = factsOf(p);
    if (fa.junk || fa.term) continue;
    const h = fa.site;
    if (!h.startsWith(prefix)) continue;
    (by.get(h) ?? by.set(h, []).get(h)!).push(p);
  }
  // The host you typed in full is the host you meant, whatever else is busier.
  const exact = by.get(prefix);
  let best: { host: string; pages: Place[]; f: number } | null = exact ? { host: prefix, pages: exact, f: 0 } : null;
  if (!best) {
    for (const [host, pages] of by) {
      // Kept on purpose counts for more than any run of visits.
      const f = pages.reduce((a, p) => a + frecency(p, now) + (p.bookmarked ? 500 : 0), 0);
      if (!best || f > best.f) best = { host, pages, f };
    }
  }
  if (!best) return null;
  return { host: best.host, pages: best.pages, www: best.pages.some((p) => factsOf(p).www) };
}

/**
 * The rest of the host to put after what was typed, selected, the way Firefox
 * completes "git" to "github.com/". Null for anything that is not a host
 * prefix: a space means a search, a slash means the host is already chosen.
 */
export function completion(places: Place[], typed: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?([^\s/]+)$/i.exec(typed);
  if (!m) return null;
  const prefix = m[1]!.toLowerCase();
  const top = topSite(places, prefix);
  if (!top) return null;
  // Completed from the stored host only: a typed "www." survives only when the
  // site was stored with it, else Enter would open a host never visited.
  if (/^(?:https?:\/\/)?www\./i.test(typed) && !top.www) return null;
  if (top.host === prefix) return null;
  return `${top.host.slice(prefix.length)}/`;
}

/** How many rows a completion list may have. Past about eight it stops being
 *  a suggestion and becomes a page of search results you have to read. */
export const SUGGEST_MAX = 8;

/** Pages of the leading site shown under its bare origin. */
export const SITE_PAGES = 3;

/**
 * The rows to offer, best first.
 *
 * When what you typed is the start of a site you visit, that site's bare
 * origin is row one, then its most-visited pages, then everything else at one
 * row per host: five pages of a domain you have not finished typing is a list
 * that wastes its space. Asset and blob URLs never appear.
 */
export function suggest(places: Place[], q: string, max = SUGGEST_MAX, open: OpenTab[] = []): Suggestion[] {
  const query = q.trim();
  if (query.length < 1) return [];
  const now = Date.now() / 1000;
  const tabAt = new Map<string, string>();
  const tabPlaces: Place[] = [];
  for (const t of open) {
    const k = tabKey(t.url);
    if (!k || tabAt.has(k)) continue;
    tabAt.set(k, t.id);
    // As if a history hit with high frecency: open now, so visited just now, often.
    tabPlaces.push({ url: t.url, title: t.title ?? "", visits: 30, lastAt: now, bookmarked: false });
  }
  if (tabPlaces.length) places = [...tabPlaces, ...places];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const titles = new Set<string>();
  const push = (h: Suggestion): boolean => {
    const key = sameKey(h);
    const tk = `${siteOf(h.url)}|${h.title.trim().toLowerCase()}`;
    if (seen.has(key) || (h.title.trim() && titles.has(tk))) return false;
    seen.add(key); titles.add(tk); out.push(h);
    return true;
  };

  const hosts = new Set<string>();
  const top = /\s/.test(query) ? null : topSite(places, query.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, ""), now);
  if (top) {
    hosts.add(top.host);
    const root = top.pages.find((p) => typedHost(p.url).toLowerCase() === top.host);
    const lead = [...top.pages].sort((a, b) => frecency(b, now) - frecency(a, now))[0]!;
    const label = top.host.split(".").slice(-2, -1)[0] ?? top.host;
    push({
      url: root?.url ?? `${new URL(lead.url).origin}/`,
      title: root?.title.trim() || label.charAt(0).toUpperCase() + label.slice(1),
      visits: top.pages.reduce((a, p) => a + p.visits, 0),
      lastAt: Math.max(...top.pages.map((p) => p.lastAt)),
      bookmarked: top.pages.some((p) => p.bookmarked),
      score: 2000, why: "host",
    });
    const pages = top.pages
      .filter((p) => typedHost(p.url).toLowerCase() !== top.host)
      .sort((a, b) => frecency(b, now) - frecency(a, now) || a.url.length - b.url.length)
      .slice(0, SITE_PAGES);
    for (const p of pages) { if (out.length < max) push({ ...p, score: 1500 + frecency(p, now) / 1000, why: "url" }); }
  }

  const hits: Suggestion[] = [];
  for (const p of places) {
    if (factsOf(p).junk) continue;
    const { score: s, why } = score(p, query, now);
    if (s > 0) hits.push({ ...p, score: s, why, ...(why === "search" ? { query: searchTerm(p.url) ?? undefined } : {}) });
  }
  hits.sort((a, b) => b.score - a.score || frecency(b, now) - frecency(a, now) || b.lastAt - a.lastAt || a.url.length - b.url.length);

  const terms = new Set<string>();
  let searches = 0;
  for (const h of hits) {
    if (out.length >= max) break;
    if (h.why === "search") {
      // De-duped by TERM, not host — the whole point, since every google search
      // shares one host and the host rule would show only the first. Capped so a
      // list of past searches never crowds out the sites.
      const term = (h.query ?? "").toLowerCase();
      if (terms.has(term) || searches >= SEARCH_MAX) continue;
      terms.add(term);
      if (push(h)) searches++;
    } else {
      const host = siteOf(h.url);
      // A bookmark earns its place even when its host is already represented:
      // it was kept on purpose, which is a stronger signal than a repeat visit.
      if (hosts.has(host) && !h.bookmarked) continue;
      if (push(h)) hosts.add(host);
    }
  }
  if (tabAt.size) for (const r of out) { const k = tabKey(r.url); const id = k && tabAt.get(k); if (id) r.tabId = id; }
  return out;
}

let memo: { places: Place[]; q: string; max: number; open: string; rows: Suggestion[] } | null = null;
/** `suggest`, remembered for the same list and the same text, so a render that
 *  changes nothing about either does not rank fifteen thousand pages again. */
export function suggestMemo(places: Place[], q: string, max = SUGGEST_MAX, open: OpenTab[] = []): Suggestion[] {
  const ok = open.map((t) => `${t.id}\n${t.url}`).join("\n");
  if (memo && memo.places === places && memo.q === q && memo.max === max && memo.open === ok) return memo.rows;
  const rows = suggest(places, q, max, open);
  memo = { places, q, max, open: ok, rows };
  return rows;
}

/** The row Enter opens, or -1 for "what was typed". Nothing is lit until the
 *  person arrows or moves the pointer, except a completion, which is row 0:
 *  what is lit is what Enter opens, and with none lit Enter takes the text. */
export function litRow(hint: number, hasCompletion: boolean): number {
  return hint >= 0 ? hint : hasCompletion ? 0 : -1;
}
