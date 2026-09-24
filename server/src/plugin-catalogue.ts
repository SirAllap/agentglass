/**
 * The distribution half of plugins.ts: a catalogue is a JSON document
 * anybody can host, listing plugins by their git source. Fetching one adds
 * no registry, no account and no server of ours in the middle — publishing a
 * plugin is publishing a git repo, and publishing a catalogue is publishing
 * one more file next to it.
 */
import { catalogueUrlError, pluginGitUrlError, pluginRefError } from "./plugin-sources.ts";
import { failed } from "./refused.ts";
import { guardedFetch, type GuardedFetchOptions } from "./net.ts";

export interface CataloguePlugin {
  id: string;
  source: { kind: "git"; url: string; ref: string | null };
  /** The content hash of the tree at `source.ref`, by the walk the install
   *  does. Present, the install refuses anything that hashes otherwise: the
   *  entry then names bytes, not a repository its author can keep pushing
   *  to. This project's catalogue writes one with every listing. */
  sha256?: string;
  description: string;
  categories: string[];
  /** What the card says when there is one. A catalogue that carries none of
   *  these still lists: the id and the description are the contract, and the
   *  rest is what a shelf needs to be read rather than parsed. */
  title?: string;
  publisher?: string;
  /** Where it draws, as the manifest's own words — so a card can say "a
   *  button in pull requests" before anybody installs anything. */
  draws?: string[];
  /** ISO date it was listed. The only ordering a catalogue can offer that
   *  its author cannot game by rewriting the file. */
  added?: string;
  /** The oldest agentglass it works on, copied from its manifest so a card
   *  can say "needs 0.18+" before anybody presses anything. The install
   *  checks the manifest itself; this is only the warning. */
  minApp?: string;
  /** A picture of the plugin, as an https URL — a card that shows what a
   *  thing looks like is read before one that describes it. Drawn by the
   *  website only: the app never fetches a stranger's image. */
  preview?: string;
}

export interface Catalogue {
  name: string;
  owner: string;
  plugins: CataloguePlugin[];
  /** How many the document listed, which is not how many came back when it
   *  listed more than the cap. A shelf that silently shows the first five
   *  hundred of three thousand is a shelf that lies about what is on it. */
  total: number;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const MAX_TEXT = 500;
const MAX_PLUGINS = 500;
const MAX_CATEGORIES = 20;

/** Shape-checked entry by entry, `plugins.ts`'s own rule for a document a
 *  stranger controls: one bad plugin entry in a catalogue of fifty loses
 *  that entry, not the other forty-nine. */
function validateCataloguePlugin(raw: unknown): CataloguePlugin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  // Exactly as written, not trimmed into shape: ids are compared as they
  // stand everywhere else, so "local-review\n" trimmed here was a second
  // local-review card under whoever listed it.
  if (typeof p.id !== "string" || !p.id.trim() || p.id !== p.id.trim() || p.id.length > 120) return null;
  const src = p.source;
  if (!src || typeof src !== "object" || (src as Record<string, unknown>).kind !== "git") return null;
  const url = (src as Record<string, unknown>).url;
  if (pluginGitUrlError(url) !== null) return null;
  const ref = (src as Record<string, unknown>).ref ?? null;
  if (pluginRefError(ref) !== null) return null;
  if (typeof p.description !== "string" || !p.description.trim() || p.description.length > MAX_TEXT) return null;
  // Malformed is dropped, not ignored: ignoring it would install the entry
  // with no hash to hold it to, which is the unpinned install it asked not
  // to be.
  if (p.sha256 !== undefined && (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256))) return null;
  const categories = Array.isArray(p.categories)
    ? p.categories.filter((c) => typeof c === "string" && c.trim()).slice(0, MAX_CATEGORIES).map((c) => String(c).trim())
    : [];
  const short = (v: unknown, limit: number): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, limit) : undefined;
  const draws = Array.isArray(p.draws)
    ? p.draws.filter((d) => typeof d === "string" && d.trim()).slice(0, 8).map((d) => String(d).trim().slice(0, 40))
    : undefined;
  return {
    id: p.id,
    source: { kind: "git", url: (url as string).trim(), ref: ref === null ? null : (ref as string).trim() },
    ...(typeof p.sha256 === "string" ? { sha256: p.sha256 } : {}),
    description: p.description.trim().slice(0, MAX_TEXT),
    categories,
    ...(short(p.title, 80) ? { title: short(p.title, 80) } : {}),
    ...(short(p.publisher, 80) ? { publisher: short(p.publisher, 80) } : {}),
    ...(draws?.length ? { draws } : {}),
    ...(short(p.added, 40) ? { added: short(p.added, 40) } : {}),
    ...(typeof p.minApp === "string" && /^\d{1,4}(\.\d{1,4}){0,2}$/.test(p.minApp) ? { minApp: p.minApp } : {}),
    ...(typeof p.preview === "string" && /^https:\/\/[^\s"'<>]{4,512}$/.test(p.preview) ? { preview: p.preview } : {}),
  };
}

export function validateCatalogue(raw: unknown): Catalogue | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "catalogue must be a JSON object";
  const c = raw as Record<string, unknown>;
  /*
   * A catalogue's name is a heading, not an identifier.
   *
   * It was held to the shape a PLUGIN name is held to — letters, digits, dots,
   * dashes — because that rule was sitting next door. A plugin's name becomes
   * a folder on disk and has to be that narrow; a catalogue's name is drawn in
   * a row and nothing else, and the first catalogue this project published was
   * refused by its own app for being called "agentglass plugins".
   *
   * So: anything printable, trimmed, capped, and no control characters — which
   * is what a heading can be without being able to lie about where it is.
   */
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 60 || CONTROL_CHARS.test(c.name)) {
    return "catalogue name must be 1-60 characters and hold no control characters";
  }
  if (typeof c.owner !== "string" || !c.owner.trim() || c.owner.length > 200) return "catalogue owner must be 1-200 characters";
  if (!Array.isArray(c.plugins)) return "catalogue plugins must be an array";
  const plugins = c.plugins.slice(0, MAX_PLUGINS).map(validateCataloguePlugin).filter((p): p is CataloguePlugin => p !== null);
  return { name: c.name.trim(), owner: c.owner.trim().slice(0, 200), plugins, total: c.plugins.length };
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * What every hop of a catalogue fetch must satisfy — the same https-only rule
 * the first URL passed, applied again to each `Location`. A catalogue that
 * redirects to plain http has downgraded itself and is refused; a redirect to a
 * private address is refused by guardedFetch before this is consulted again.
 */
const catalogueHop = (u: URL): string | null => (u.protocol === "https:" ? null : "catalogue redirected off https");

/**
 * Fetch and parse — nothing here trusts the response's `Content-Length`,
 * because a hostile server does not have to tell the truth about it. The
 * body is read up to the cap and cut off rather than buffered whole first.
 *
 * And nothing here trusts the response's REDIRECT either. `redirect: "follow"`
 * let the catalogue's server choose the next URL, with no check on where it
 * pointed: a 302 to a loopback or LAN address was fetched with this server's
 * network position and its body parsed as a catalogue. guardedFetch (net.ts)
 * walks the hops itself and refuses a private, link-local or unresolvable host
 * at each one, the first included — `catalogueUrlError` never looked at the
 * host at all.
 *
 * `guard` is for the test, which answers the first hop with a 302 to a private
 * address and proves the second is never made — see GuardedFetchOptions.
 */
export async function fetchCatalogue(url: string, guard: GuardedFetchOptions = {}): Promise<{ ok: true; catalogue: Catalogue } | { ok: false; error: string }> {
  const bad = catalogueUrlError(url);
  if (bad) return { ok: false, error: bad };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const got = await guardedFetch(url, { signal: controller.signal }, catalogueHop, guard);
    if (!got.res) return { ok: false, error: `catalogue fetch refused: ${got.error}` };
    const res = got.res;
    if (!res.ok || !res.body) return { ok: false, error: `catalogue fetch failed: HTTP ${res.status}` };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } return { ok: false, error: "catalogue is larger than 5MB" }; }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { ok: false, error: "catalogue is not valid JSON" }; }
    const catalogue = validateCatalogue(raw);
    if (typeof catalogue === "string") return { ok: false, error: catalogue };
    return { ok: true, catalogue };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "AbortError" ? "catalogue fetch timed out" : failed("plugins/catalogue", e, "the plugin catalogue could not be fetched") };
  } finally {
    clearTimeout(timer);
  }
}
