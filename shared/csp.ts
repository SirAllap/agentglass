// The Content-Security-Policy agentglass serves the UI under, written once.
//
// The same web/dist is served from two origins and only one of them had a
// policy. The desktop shell hands the renderer out over its own
// `agentglass://app` scheme and put a CSP on it (electron/main.js); the sidecar
// hands the very same bundle to a phone, to a browser on the LAN and to
// whatever reaches a `tailscale serve` hostname, and sent no policy at all.
// That is backwards — the HTTP origin is the one a stranger can reach — so both
// now read this file and the test beside it (server/test/csp.test.ts) fails if
// they ever stop agreeing.
//
// Why either origin is worth a policy: the renderer is handed the machine token
// as a plain synchronous value (preload.js) next to IPC channels that import
// browser cookies and drive a browser, and the app renders pull-request and
// issue markdown from whatever repository the user happens to be triaging,
// through a hand-written converter, into several `dangerouslySetInnerHTML`
// sinks. An XSS has already shipped through that converter once. So the
// load-bearing directives are `connect-src` — an injected script can reach this
// app and its own loopback sidecar and no outside host, which is what stops the
// token leaving the machine — and `script-src`/`object-src`/`base-uri`, which
// leave it nothing to inject in the first place.

/**
 * The sha256 of the inline bootstrap in web/index.html — the splash that fills
 * the window while the 1.8 MB bundle parses.
 *
 * It is the only inline script in the page, and it is why the desktop header
 * shipped Report-Only for as long as it did: an enforcing `script-src 'self'`
 * blanks the window until that inline is named. Hashing it is the naming.
 *
 * The hash covers the exact bytes BETWEEN the tags, and vite copies the tag
 * through the build untouched (measured: the inline in web/dist/index.html is
 * byte-identical to the source), so one hash is right for the dev page, the
 * build, and the copy electron-builder stages into the app.
 */
export const BOOT_SCRIPT_SHA256 = "'sha256-avgYkkkdd6eLtDuXfkYt2w13v+s20IiZ9Mraf4FR2JY='";

/**
 * The sha256 of the single-port marker the sidecar plants into index.html on
 * its way out (see injectSameOrigin in server/src/webui.ts).
 *
 * Only the HTTP origin ever carries it, but both headers name it: two policies
 * that differ in one directive are two policies, and the whole point of this
 * file is that there is one. A hash for a script the desktop page never
 * contains costs that page nothing.
 */
export const SAME_ORIGIN_MARKER_SHA256 = "'sha256-WoyIdsXRXsB6KXPWR0pkumt+r5WqeyVOTWuslDXPNb8='";

/** The policy, one directive per entry. Kept as a list because that is the form
 *  electron/main.js has to repeat verbatim (it cannot import this file — see the
 *  note there), and a list diffs line by line when the two are compared. */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'none'",
  `script-src 'self' ${BOOT_SCRIPT_SHA256} ${SAME_ORIGIN_MARKER_SHA256}`,
  "style-src 'self' 'unsafe-inline'",
  /* The two hosts this app really draws pictures from, named rather than left
     to break: without them every avatar in the pull request panel and every
     screenshot on a card goes blank. Images only — neither host can run a
     script under this policy. */
  /* Two different ClickUp hosts, and missing either one blanks a picture:
     card attachments come from `<id>.p.clickup-attachments.com`, while a
     member's `profilePicture` (clickup.ts:334, :1586) is served from
     `attachments.clickup.com` — which the -attachments.com wildcard does not
     match, because it is a different registrable domain. */
  /* And the sidecar itself, which is where every proxied picture actually
     comes from. The desktop renderer is served from `agentglass://app`, so
     `'self'` is that scheme and NOT the loopback the API lives on — and each
     avatar is `http://127.0.0.1:<port>/prs/asset?url=…`, the allowlisted proxy
     that fetches GitHub for us. Naming the two GitHub hosts above was
     therefore not enough: the request never goes there from the page.
     Measured, A/B, on the real proxy answering 200 image/jpeg: without this
     directive the <img> ends with naturalWidth 0 and an error event; with it,
     48. Reported as "we don't have the avatar images". */
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https://*.clickup-attachments.com https://*.clickup.com https://*.githubusercontent.com https://avatars.githubusercontent.com",
  /* Not folded into default-src by any browser: `manifest-src` falls back to
     default-src, and 'none' there blocks web.manifest. Measured — loading a
     real build under this policy in headless Chromium reported exactly one
     violation, `manifest-src`, and it is the directive the phone flow depends
     on: the QR code ends at "add to home screen", which is the manifest. */
  "manifest-src 'self'",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  /* 'self' covers the WebSocket back to this same origin — the terminal, the
     notifications stream, the live feed. That is CSP3's rule (a ws:// URL
     matches 'self' when the document is http:// on the same host and port) and
     it is not folklore: a page served with exactly this directive opens a
     same-origin WebSocket in Chromium, measured. The loopback entries are for
     the desktop origin, whose sidecar is a different origin from the page. */
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "child-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  /* Nobody frames this app. Every form on screen is a React `onSubmit`, and the
     browser panel's `<webview>` is a guest, not an ancestor. */
  "frame-ancestors 'none'",
];

/** The header value both origins send. */
export const CSP = CSP_DIRECTIVES.join("; ");

/**
 * The rest of what a document should be sent with.
 *
 * `nosniff` matters most on the assets, not the page: web/dist is served with a
 * MIME table, and a browser that sniffs its way past one turns a file the user
 * uploaded into a script. `no-referrer` because the URLs here name repositories,
 * worktrees and cards, and there is no outbound request that has any business
 * carrying one.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Those plus the policy — for an HTML document, the only response whose CSP a
 *  browser reads. */
export const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": CSP,
};
