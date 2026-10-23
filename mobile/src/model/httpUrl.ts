/*
 * The one question every "open this link" button asks: is it a web page?
 *
 * The addresses behind those buttons arrive from a tracker or from GitHub, and
 * `Linking.openURL` will hand any scheme to the system: another app's deep
 * link, a `tel:` number, a `file:` path. The markdown renderer already limits
 * what a body can link to; this is the same limit for the buttons that open
 * an address a field held. No parsing beyond the scheme: the system browser
 * deals with the rest of a web address.
 */
const WEB = /^https?:\/\/[^\s]/i;

/** The address when it is an http(s) page, `null` otherwise. */
export function httpUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim();
  return url && WEB.test(url) ? url : null;
}
