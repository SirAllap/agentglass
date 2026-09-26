/**
 * robots.txt, honoured by the driven browser when asked to.
 *
 * Off unless `AGENTGLASS_BROWSER_ROBOTS=1`, and on purpose: this browser is a
 * person's own, signed in as they are, and a person opening a page is not a
 * crawler. What the switch is for is the other use — an agent sent to read a
 * hundred pages of a site it has no relationship with — where the operator
 * wants the site's own rules followed and does not want to be the one who
 * remembers to check them. Then every `open` and `newtab` asks the origin's
 * robots.txt first and is refused, by name, when the path is disallowed for
 * `agentglass` (or for `*` when no group names it).
 *
 * The file is read the way the standard says: the group whose user-agent line
 * is the longest match for ours wins, the most specific rule (longest path
 * pattern) inside it wins, and on a tie Allow wins. `*` and `$` are the only
 * wildcards. A robots.txt that cannot be fetched — no file, a 4xx, a host the
 * server may not reach — allows everything, which is what every crawler does
 * and the only answer that does not make a missing file a wall.
 *
 * One fetch per origin per hour. The fetch goes through `guardedFetch` like
 * every address this server did not choose, with the host check held to the
 * browser's own policy on every hop, redirects included: loopback and the LAN
 * are where the pages a local developer opens live, and a dev server's
 * robots.txt is as real as any; link-local and the unspecified address are
 * refused on the literal and on what a name resolves to. The first version
 * turned the check off, and this fetch runs in the SERVER — the browser's
 * egress guard never sees it — so a robots.txt that answered 302 to the
 * metadata address had the server read it and leak allow/refuse as one bit.
 * The ceiling: the check resolves a name and the fetch resolves it again, so
 * a name with a zero TTL that flips between the two still reaches the address
 * the check did not see. Closing that means connecting to the checked
 * address, which `fetch` has no way to be told; the switch being off by
 * default is what bounds it.
 */
import { blockedTarget, dnsResolver, guardedFetch, type Resolver } from "./net.ts";

export const ROBOTS_ENV = "AGENTGLASS_BROWSER_ROBOTS";
export const ROBOTS_AGENT = "agentglass";
const TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 500;
const MAX_BYTES = 512 * 1024;

export function robotsOn(): boolean {
  return process.env[ROBOTS_ENV] === "1";
}

interface Rule { allow: boolean; pattern: string }
interface Group { agents: string[]; rules: Rule[] }

/** The groups of a robots.txt: each a run of user-agent lines followed by its rules. */
export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", pattern: value });
  }
  return groups;
}

/** `*` matches anything, `$` anchors the end, everything else is literal. */
function patternMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  return new RegExp(re).test(path);
}

/** Whether `path` (with its query) may be fetched by `agent` under this
 *  robots.txt. The rules of EVERY group naming the best-matching token apply,
 *  merged (RFC 9309 lets a site split them); an empty `User-agent:` names
 *  nobody, since every name starts with the empty string. */
export function robotsAllows(text: string, path: string, agent = ROBOTS_AGENT): boolean {
  const groups = parseRobots(text);
  const me = agent.toLowerCase();
  let bestName: string | null = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a && a !== "*" && me.startsWith(a) && a.length > (bestName?.length ?? -1)) bestName = a;
    }
  }
  const token = bestName ?? "*";
  const rules = groups.filter((g) => g.agents.includes(token)).flatMap((g) => g.rules);
  if (!groups.some((g) => g.agents.includes(token))) return true;
  let verdict = true;
  let verdictLen = -1;
  for (const r of rules) {
    if (!patternMatches(r.pattern, path)) continue;
    const len = r.pattern.length;
    if (len > verdictLen || (len === verdictLen && r.allow)) { verdict = r.allow; verdictLen = len; }
  }
  return verdict;
}

interface Cached { text: string | null; at: number }
const cache = new Map<string, Cached>();
let fetchImpl: typeof fetch | null = null;
let lookupImpl: Resolver = dnsResolver;

/** For tests: a fetch that answers a robots.txt without a network, and a
 *  resolver that answers what the test says. Null restores the real ones. */
export function __setRobotsFetch(fn: typeof fetch | null, resolver?: Resolver): void {
  fetchImpl = fn;
  lookupImpl = resolver ?? dnsResolver;
  cache.clear();
}

async function robotsFor(origin: string, now: number): Promise<string | null> {
  const hit = cache.get(origin);
  if (hit && now - hit.at < TTL_MS) return hit.text;
  let text: string | null = null;
  try {
    const r = await guardedFetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000), headers: { "user-agent": `${ROBOTS_AGENT}/robots` } },
      (u) => (u.protocol === "http:" || u.protocol === "https:" ? null : "robots.txt is fetched over http(s) only"),
      { ...(fetchImpl ? { fetchImpl } : {}), resolver: lookupImpl, refuses: blockedTarget });
    if (r.res && r.res.ok) {
      const body = await r.res.text();
      text = body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body;
    }
  } catch { text = null; }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(origin, { text, at: now });
  return text;
}

/**
 * Why `url` may not be opened under the origin's robots.txt, or null. A URL
 * that does not parse is somebody else's refusal; this one only speaks when a
 * robots.txt was read and says no.
 */
export async function robotsRefusal(url: string, now = Date.now()): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const text = await robotsFor(u.origin, now);
  if (text === null) return null;
  const path = u.pathname + u.search;
  if (robotsAllows(text, path, ROBOTS_AGENT)) return null;
  return `${u.origin}/robots.txt disallows ${path} for ${ROBOTS_AGENT}: refused because ${ROBOTS_ENV}=1 asks the browser to honour it. `
    + "Open a page the file allows, or unset the switch if this is not a crawl.";
}
