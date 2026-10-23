/*
 * Which avatar hosts a tracker hands out that the page may not load itself.
 *
 * A Jira Cloud person's picture is a Gravatar URL whose `d=` falls back to an
 * Atlassian initials image. Neither host is in the desktop CSP's `img-src`, and
 * widening that policy is the worse trade, so the picture goes through the
 * sidecar's `/prs/asset` proxy like a GitHub avatar does. Server and web ask
 * the same question here so they cannot drift.
 *
 * Ceiling: Jira Data Center / Server avatars live on the site's own host and
 * may need a login. They are not here on purpose (the proxy never forwards a
 * credential), so those people keep their initials.
 */
import { hasUrlCredentials } from "./urlCredentials.ts";


const ATLASSIAN_AVATARS = /^avatar-management--avatars\.[a-z0-9-]+\.prod\.public\.atl-paas\.net$/;

/** Exact host names only: no suffix match, so no lookalike and no sibling subdomain. */
export function isJiraAvatarHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "secure.gravatar.com" || ATLASSIAN_AVATARS.test(h);
}

/** An https URL on one of those hosts, on the default port, with no userinfo. */
export function isJiraAvatarUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === "https:" && !hasUrlCredentials(u) && u.port === "" && isJiraAvatarHost(u.hostname);
}
