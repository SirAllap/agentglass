/**
 * The distribution half of plugins.ts: a catalogue is a JSON document
 * anybody can host, listing plugins by their git source. Fetching one adds
 * no registry, no account and no server of ours in the middle — publishing a
 * plugin is publishing a git repo, and publishing a catalogue is publishing
 * one more file next to it.
 */
import { catalogueUrlError, pluginGitUrlError, pluginRefError } from "./plugin-sources.ts";
import { guardedFetch, type GuardedFetchOptions } from "./net.ts";

export interface CataloguePlugin {
  id: string;
  source: { kind: "git"; url: string; ref: string | null };
  description: string;
  categories: string[];
}

export interface Catalogue {
  name: string;
  owner: string;
  plugins: CataloguePlugin[];
}

const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
const MAX_TEXT = 500;
const MAX_PLUGINS = 500;
const MAX_CATEGORIES = 20;

/** Shape-checked entry by entry, `plugins.ts`'s own rule for a document a
 *  stranger controls: one bad plugin entry in a catalogue of fifty loses
 *  that entry, not the other forty-nine. */
function validateCataloguePlugin(raw: unknown): CataloguePlugin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id.trim() || p.id.length > 120) return null;
  const src = p.source;
  if (!src || typeof src !== "object" || (src as Record<string, unknown>).kind !== "git") return null;
  const url = (src as Record<string, unknown>).url;
  if (pluginGitUrlError(url) !== null) return null;
  const ref = (src as Record<string, unknown>).ref ?? null;
  if (pluginRefError(ref) !== null) return null;
  if (typeof p.description !== "string" || !p.description.trim() || p.description.length > MAX_TEXT) return null;
  const categories = Array.isArray(p.categories)
    ? p.categories.filter((c) => typeof c === "string" && c.trim()).slice(0, MAX_CATEGORIES).map((c) => String(c).trim())
    : [];
  return {
    id: p.id.trim(),
    source: { kind: "git", url: (url as string).trim(), ref: ref === null ? null : (ref as string).trim() },
    description: p.description.trim().slice(0, MAX_TEXT),
    categories,
  };
}

export function validateCatalogue(raw: unknown): Catalogue | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "catalogue must be a JSON object";
  const c = raw as Record<string, unknown>;
  // The same shape a plugin name is held to (plugins.ts `validPluginName`),
  // repeated rather than imported because plugins.ts imports this file. A
  // catalogue name never becomes a path, but "." and ".." are not names.
  if (typeof c.name !== "string" || !NAME_RE.test(c.name) || c.name === "." || c.name === ".." || c.name.startsWith(".")) {
    return "catalogue name must be 1-60 characters: letters, numbers, dots, dashes or underscores";
  }
  if (typeof c.owner !== "string" || !c.owner.trim() || c.owner.length > 200) return "catalogue owner must be 1-200 characters";
  if (!Array.isArray(c.plugins)) return "catalogue plugins must be an array";
  const plugins = c.plugins.slice(0, MAX_PLUGINS).map(validateCataloguePlugin).filter((p): p is CataloguePlugin => p !== null);
  return { name: c.name, owner: c.owner.trim().slice(0, 200), plugins };
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
    return { ok: false, error: e instanceof Error && e.name === "AbortError" ? "catalogue fetch timed out" : (e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}
