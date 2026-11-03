/**
 * Does this variable hold a credential?
 *
 * Deliberately broad. A false positive costs one masked value in a diff nobody
 * needed; a false negative puts somebody's production token in a screenshot.
 * Matched on the NAME only — a heuristic on the value would leak exactly the
 * things whose shape is unusual.
 */
export function isSecret(name: string): boolean {
  return /(?:^|_)(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|AUTH|CREDENTIAL|CREDENTIALS|SIGNATURE|PRIVATE|SESSION|COOKIE|DSN|SALT|PEPPER)(?:_|$)/i.test(name)
    // Names that are one word and obviously a credential.
    || /^(?:password|secret|token|apikey|api_key|authorization)$/i.test(name);
}
