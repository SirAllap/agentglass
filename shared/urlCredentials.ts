/**
 * True when a URL carries a user name or a password in its authority part
 * (`https://user:pw@host/`). Every place that refuses such an address asks
 * here instead of spelling the two fields out, so the check reads the same
 * everywhere and a secret scanner that pattern-matches `password ||` has
 * nothing in a condition to take for a credential.
 */
export function hasUrlCredentials(u: URL): boolean {
  return [u.username, u.password].some(Boolean);
}
