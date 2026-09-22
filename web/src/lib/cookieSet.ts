/**
 * `cookies --set` as a Network.setCookie call, for the writes a page cannot
 * make itself.
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

const ATTRS = ["secure", "httpOnly", "sameSite", "expires", "partitionKey"] as const;

/** Whether this write has to go through the protocol: an attribute
 *  document.cookie cannot express, or a prefixed name. A plain name=value
 *  keeps the page's own path, which is what the page itself would see. */
export function needsProtocol(set: Record<string, unknown>): boolean {
  const name = String(set.name ?? "");
  return /^__(Host|Secure)-/.test(name) || ATTRS.some((k) => set[k] !== undefined && set[k] !== false);
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
  const secure = set.secure === true || (prefixed && set.secure !== false);

  if (prefixed && set.secure === false) return { error: `a ${host ? "__Host-" : "__Secure-"} cookie is Secure by definition — it cannot be set with secure: false` };
  if (host && domain) return { error: "a __Host- cookie cannot carry a domain — Chromium refuses it; drop --domain" };
  if (host && path !== "/") return { error: "a __Host- cookie must have path / — Chromium refuses any other" };
  if (sameSite === "None" && !secure) return { error: "SameSite=None needs Secure (--secure), or Chromium drops the cookie" };
  if (partition && !secure) return { error: "a partitioned cookie needs Secure (--secure)" };

  let page: URL;
  try { page = new URL(pageUrl); } catch { return { error: `the page's address (${pageUrl}) is not a URL to set a cookie for` }; }
  const where = domain ? domain.replace(/^\./, "") : page.hostname;
  const scheme = secure ? "https" : page.protocol.replace(/:$/, "");
  const params: CookieSetParams = { name, value, url: `${scheme}://${where}${path}`, path };
  if (domain) params.domain = domain;
  if (secure) params.secure = true;
  if (set.httpOnly === true) params.httpOnly = true;
  if (sameSite) params.sameSite = sameSite;
  if (typeof set.expires === "number" && Number.isFinite(set.expires)) params.expires = set.expires;
  if (partition) params.partitionKey = { topLevelSite: partition, hasCrossSiteAncestor: false };
  return { params };
}
