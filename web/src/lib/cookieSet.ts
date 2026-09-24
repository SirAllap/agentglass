/**
 * `cookies --set` as a Network.setCookie call. Every set goes through it:
 * measured in headless Chromium, `document.cookie = "__Host-x=..."` is dropped
 * without a throw, and every other cookie it writes lands non-Secure,
 * non-HttpOnly and SameSite unset whatever was asked for.
 *
 * The rules here are Chromium's, applied BEFORE the call so a refusal can say
 * why: the protocol answers `success: false` for all of them and names none.
 *   * `__Host-` — Secure, Path=/ and no Domain, or it is not stored;
 *   * `__Secure-` — Secure;
 *   * SameSite=None — Secure, or it is dropped;
 *   * a partition (CHIPS) — Secure.
 * A prefix implies its Secure rather than demanding the flag: the name already
 * says it, and refusing `--set __Host-sid x` for want of `--secure` is a
 * refusal nobody learns anything from.
 *
 * Secure defaults to "the page is a secure context": https, or the loopback
 * hosts Chromium itself treats as one over plain http, so local dev targets
 * are not cut off. `secure: false` (the CLI's `--insecure`) opts out of that
 * default, and is refused for a prefixed name.
 */
export interface CookieSetParams {
  name: string;
  value: string;
  url: string;
  path: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

/** Chromium's "potentially trustworthy origin" rule for plain http. */
function isSecureContextHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.startsWith("127.") || hostname === "[::1]";
}

export function cookieSetParams(set: Record<string, unknown>, pageUrl: string): { params: CookieSetParams } | { error: string } {
  const name = String(set.name ?? "");
  const value = String(set.value ?? "");
  const host = name.startsWith("__Host-");
  const prefixed = host || name.startsWith("__Secure-");
  const domain = typeof set.domain === "string" && set.domain ? set.domain : undefined;
  const path = typeof set.path === "string" && set.path ? set.path : "/";
  const rawSameSite = typeof set.sameSite === "string" ? set.sameSite.toLowerCase() : "";
  const sameSite = rawSameSite === "strict" ? "Strict" : rawSameSite === "lax" ? "Lax" : rawSameSite === "none" ? "None" : undefined;
  if (rawSameSite && !sameSite) return { error: `SameSite must be Strict, Lax or None, not "${String(set.sameSite)}"` };
  const partition = typeof set.partitionKey === "string" && set.partitionKey ? set.partitionKey : undefined;
  // `host` is the cookie's own host, for an import that sets it before the tab
  // is on the site — a host-only cookie must bind to its host, not the page's.
  // The Domain attribute still comes from `domain` alone, so a host given here
  // does not turn a host-only cookie into a domain one.
  const hostArg = typeof set.host === "string" && set.host ? set.host.replace(/^\./, "") : undefined;
  let page: URL | undefined;
  try { page = new URL(pageUrl); } catch { page = undefined; }
  const pageOk = !!page && (page.protocol === "http:" || page.protocol === "https:");
  if (!pageOk && !domain && !hostArg) return { error: "open a page on the cookie's site first" };
  // An import names its own host and sets over https; a page-less write has no context to inherit.
  const secureContext = hostArg ? true : !!page && (page.protocol === "https:" || isSecureContextHost(page.hostname));
  const secure = set.secure === true || (prefixed ? set.secure !== false : set.secure === undefined && secureContext && !hostArg);
  if (prefixed && !secureContext && !domain) return { error: `a ${host ? "__Host-" : "__Secure-"} cookie needs a secure page (https, or http://localhost)` };
  if (prefixed && set.secure === false) return { error: `a ${host ? "__Host-" : "__Secure-"} cookie is Secure by definition — it cannot be set with secure: false` };
  if (host && domain) return { error: "a __Host- cookie cannot carry a domain — Chromium refuses it; drop --domain" };
  if (host && path !== "/") return { error: "a __Host- cookie must have path / — Chromium refuses any other" };
  if (sameSite === "None" && !secure) return { error: "SameSite=None needs Secure (--secure), or Chromium drops the cookie" };
  if (partition && !secure) return { error: "a partitioned cookie needs Secure (--secure)" };

  // The URL is where the write happens, so a Domain that is not the page's is
  // Chromium's to refuse (and is reported as such). Off a page, or for an import
  // that names its host, the cookie's own host stands in for it.
  const where = hostArg ?? (pageOk ? page!.hostname : domain?.replace(/^\./, ""));
  if (!where) return { error: `no host to set the cookie for: the page's address (${pageUrl}) is not a URL and no host was given` };
  const scheme = secure ? "https" : hostArg ? "https" : page?.protocol.replace(/:$/, "") ?? "https";
  const params: CookieSetParams = { name, value, url: `${scheme}://${where}${path}`, path };
  if (domain) params.domain = domain;
  if (secure) params.secure = true;
  params.httpOnly = set.httpOnly === true;
  if (sameSite) params.sameSite = sameSite;
  if (typeof set.expires === "number" && Number.isFinite(set.expires)) params.expires = set.expires;
  if (partition) params.partitionKey = { topLevelSite: partition, hasCrossSiteAncestor: false };
  return { params };
}
