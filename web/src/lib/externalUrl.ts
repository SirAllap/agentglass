import { routeLink } from "./otherLinks.ts";
import { openOnMachine } from "./desktop.ts";

// Opening a URL that arrived over the wire.
//
// Every outbound link in the pull request panel — the pull request itself, a
// check's run, a review, a comment, a thread — is a string GitHub handed us.
// In practice they are all `https://github.com/…`, and that is exactly the
// reasoning that ages badly: `javascript:` and `data:` are URLs too, and
// `window.open` on one runs it. The panel is not the right place to be deciding
// that a response is trustworthy, so it does not — it checks the scheme and
// declines anything that is not plain http(s).
//
// Returns the URL when it is safe to navigate to, and `undefined` when it is
// not, so the caller renders nothing rather than rendering a dead or hostile
// link. `undefined` rather than `""` on purpose: `href={undefined}` omits the
// attribute, while `href=""` reloads the page.

/** The URL if it is safe to hand to a browser, `undefined` otherwise. */
export function externalUrl(raw: string | null | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let u: URL;
  try {
    // No base on purpose. Resolving a relative URL against our own origin turns
    // a blank or malformed field into a link back to the app, which looks like
    // a working link and is not one — these are all meant to be absolute.
    u = new URL(raw.trim());
  } catch {
    return undefined; // not an absolute URL at all
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
}

/**
 * Open one, if it is safe to: where "Open web links in" says (the agentglass
 * browser, or the machine's), falling back to the machine's browser when the
 * agentglass browser cannot take it. `machine` skips the setting: a Ctrl-click
 * or an explicit "Open in your own browser".
 *
 * `noopener` matters beyond the scanner: without it the page we open keeps a
 * handle on ours through `window.opener` and can navigate it.
 */
export function openExternal(raw: string | null | undefined, opts: { machine?: boolean } = {}): boolean {
  const href = externalUrl(raw);
  if (!href) return false;
  if (!opts.machine && routeLink(href)) return true;
  // In the desktop shell the machine's browser is asked for directly: a
  // window.open would come back through the shell's escape handler and be
  // routed by the setting again.
  if (openOnMachine(href)) return true;
  window.open(href, "_blank", "noopener,noreferrer");
  return true;
}
