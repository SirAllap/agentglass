/**
 * Letting an agent drive the built-in browser.
 *
 * The point is the logins. An agent can already fetch a URL from its shell and
 * get the signed-out version of everything that matters — the dashboard, the
 * staging app, the ticket — because the session lives in a browser and not in
 * `curl`. This app has a browser with those sessions in it, sitting in a pane,
 * and until now nothing outside the window could reach it.
 *
 * Which makes this a relay, not a driver. The page lives in a guest process
 * inside the desktop shell; the only thing that can touch it is the panel it is
 * mounted in. So an agent's HTTP request is parked here, handed to that panel
 * over the socket every window already holds, and answered when the panel says
 * what happened. The alternative — a second browser, driven headlessly, holding
 * its own copy of somebody's cookies — is the thing this deliberately is not.
 *
 * Three consequences worth stating rather than discovering:
 *
 *   * **It needs the window open.** A request with nobody listening fails
 *     quickly and says so, rather than hanging until the agent's own timeout
 *     and reading as "the browser is broken".
 *   * **Every operation is a closed verb**, not a script. `click` takes a
 *     selector; there is no "run this JavaScript". The panel implements each
 *     one, so the set of things reachable through this door is the set someone
 *     wrote down here — which is the same rule the terminal's command paths and
 *     the tmux control surface already follow.
 *   * **Every request is bounded.** A page that never settles must not hold a
 *     socket, a pending map entry and an agent's turn open forever.
 */

import { isIP } from "node:net";

/** What the panel can be asked to do. Each one is implemented there; nothing
 *  here is interpreted, and there is deliberately no `eval`. */
export type BrowserOp =
  | "open" | "read" | "click" | "type" | "wait" | "shot"
  | "back" | "forward" | "scroll" | "press" | "text";
const OPS: readonly BrowserOp[] = [
  "open", "read", "click", "type", "wait", "shot",
  "back", "forward", "scroll", "press", "text",
];

/**
 * The keys that may be pressed.
 *
 * A closed set, and not because a letter would be dangerous — `type` already
 * puts letters in a field. These are the keys that are not text: the ones that
 * dismiss, submit, move a selection or page a list, which is the whole reason
 * an agent needs a key at all. Anything outside it is a request that would be
 * silently ignored by the page, and silence is the failure this whole surface
 * is written to avoid.
 */
const KEYS: readonly string[] = [
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End",
];

export interface BrowserAsk {
  id: string;
  op: BrowserOp;
  /** Validated per-op below; the panel trusts what arrives here. */
  args: Record<string, unknown>;
}

export interface BrowserReply {
  ok: boolean;
  /** Shape depends on the op — see the panel. */
  value?: unknown;
  error?: string;
}

/** How long a request may wait for the window. Generous for a page load,
 *  short for the rest: the common failure is a selector that never appears,
 *  and an agent learns nothing from a minute of silence that it would not
 *  learn in fifteen seconds. */
const TIMEOUT_MS: Record<BrowserOp, number> = {
  open: 45_000, read: 15_000, click: 15_000, type: 15_000, wait: 45_000, shot: 20_000,
  // Going back is a navigation and gets a navigation's patience; the rest are a
  // round trip to the page and nothing more.
  back: 45_000, forward: 45_000, scroll: 15_000, press: 15_000, text: 15_000,
};

/** Requests handed to the window and not yet answered. */
const pending = new Map<string, { resolve: (r: BrowserReply) => void; timer: ReturnType<typeof setTimeout> }>();

/** How this reaches the window. Injected so the whole relay can be tested
 *  without a server, a socket or a browser. */
let sink: { send: (ask: BrowserAsk) => void; listeners: () => number } | null = null;
export function setBrowserSink(s: typeof sink) { sink = s; }

/**
 * Which clients can actually drive a browser, and when they last said so.
 *
 * "Is anybody listening" was the wrong question and it produced a wrong answer
 * in an ordinary setup: the ask goes to every open client, and a dashboard
 * loaded in an ordinary browser tab is a client too. It has no `<webview>` —
 * that is an Electron thing — so it answered "the browser view is not open in
 * this window" and, being first, that became the agent's answer while the
 * desktop app sat there perfectly able to do the work.
 *
 * So a panel registers itself, and only a registered one replies. A stale
 * registration is worse than none — it turns a fast, honest "no window" into a
 * fifteen-second timeout — so it is a heartbeat with a TTL rather than a flag
 * somebody has to remember to clear on a crash.
 */
const ready = new Map<string, number>();
const READY_TTL_MS = 90_000;

export function noteBrowserReady(client: unknown, on: boolean): boolean {
  if (typeof client !== "string" || !client || client.length > 128) return false;
  if (on) ready.set(client, Date.now());
  else ready.delete(client);
  return true;
}

/** How many windows could drive a browser right now. */
export function browserReadyCount(): number {
  const cutoff = Date.now() - READY_TTL_MS;
  for (const [id, at] of ready) if (at < cutoff) ready.delete(id);
  return ready.size;
}

let seq = 0;
const nextId = () => `b${++seq}`;

/** Addresses the browser relay refuses even over http(s): link-local — which is
 *  where the cloud metadata endpoint 169.254.169.254 lives — and the unspecified
 *  address. `open` drives a real, logged-in browser and `read` hands back the
 *  page, so without this the relay is an SSRF probe with a credentialed response
 *  channel. Loopback and RFC1918 are deliberately NOT blocked: pointing the
 *  browser at a local dev server or a box on your own LAN is ordinary use here.
 *  A bare hostname passes — re-resolving to pin the IP is a TOCTOU we don't win,
 *  and a redirect can still land somewhere internal; the guest's own network
 *  stack is the backstop for those. */
function blockedV4(h: string): boolean {
  return h.startsWith("169.254.") || h === "0.0.0.0";
}

/** The eight 16-bit groups of a valid IPv6 address (isIP has already said v6),
 *  with `::` expanded and any trailing dotted-quad (`::ffff:1.2.3.4`) folded
 *  into its two hex groups. Given a valid address this always yields eight. */
function ipv6Groups(h: string): number[] {
  let s = h;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) { // embedded IPv4 dotted-quad → two hex groups
    const q = tail.split(".").map((n) => parseInt(n, 10) & 0xff);
    s = s.slice(0, lastColon + 1) +
      ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const [left, right] = s.split("::");
  const head = left ? left.split(":") : [];
  const rear = right !== undefined ? (right ? right.split(":") : []) : [];
  const gap = right !== undefined ? 8 - head.length - rear.length : 0;
  return [...head, ...Array(Math.max(gap, 0)).fill("0"), ...rear].map((g) => parseInt(g, 16));
}

function blockedTarget(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase(); // URL keeps IPv6 brackets
  const v = isIP(h);
  if (v === 4) return blockedV4(h);
  if (v === 6) {
    if (/^fe[89ab]/.test(h) || h === "::") return true; // fe80::/10 link-local, unspecified
    // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96) forms
    // carry a v4 address in the low 32 bits — so `[::ffff:169.254.169.254]` (which
    // the URL parser folds to `::ffff:a9fe:a9fe`) is the metadata endpoint wearing
    // a v6 hat. Re-run the v4 rules on the embedded address; loopback/LAN mapped
    // in this way (e.g. `::ffff:127.0.0.1`) stays allowed, same as its v4 self.
    const g = ipv6Groups(h);
    const embedded =
      g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 &&
      (g[5] === 0xffff || g[5] === 0);
    if (embedded) {
      const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
      return blockedV4(v4);
    }
    // NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) embed a v4 address the same
    // way, just under a non-zero prefix — `[64:ff9b::a9fe:a9fe]` and
    // `[2002:a9fe:a9fe::]` are 169.254.169.254 wearing a routable-looking hat.
    // Fold each ONLY when its prefix actually matches, so a global v6 whose low
    // bits merely resemble 169.254.x.x is not over-blocked.
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
      return blockedV4(v4);
    }
    if (g[0] === 0x2002) {
      const v4 = `${g[1]! >> 8}.${g[1]! & 0xff}.${g[2]! >> 8}.${g[2]! & 0xff}`;
      return blockedV4(v4);
    }
    return false;
  }
  return false;
}

/** The URLs the browser may be sent to. Same rule as the address bar: a page,
 *  not a `file://` read of somebody's keys and not a `javascript:` that would
 *  make `open` the `eval` this deliberately does not have — plus a refusal of the
 *  internal addresses no page navigation has a reason to reach (see blockedTarget). */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (blockedTarget(u.hostname)) return null;
  return u.toString();
}

/** A CSS selector, held to something that cannot carry a newline or run off
 *  into a page's own quoting. Length-capped because it ends up in a string
 *  literal the panel builds. */
const okSelector = (s: unknown): s is string =>
  typeof s === "string" && !!s.trim() && s.length <= 512 && !/[\n\r\u0000]/.test(s);

/** Turn an untrusted body into an ask, or say why not. The message is shown to
 *  whoever typed the command, so it names the field. */
export function parseAsk(op: unknown, body: unknown): { ask: BrowserAsk } | { error: string } {
  if (!OPS.includes(op as BrowserOp)) return { error: `unknown browser operation` };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  switch (op as BrowserOp) {
    case "open": {
      const url = safeUrl(b.url);
      if (!url) return { error: "url must be an http(s) address" };
      args.url = url;
      break;
    }
    case "click":
    case "wait": {
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      args.selector = b.selector;
      break;
    }
    case "type": {
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      if (typeof b.text !== "string" || b.text.length > 10_000) return { error: "text must be a string" };
      args.selector = b.selector;
      args.text = b.text;
      args.submit = b.submit === true;
      break;
    }
    case "text": {
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      args.selector = b.selector;
      break;
    }
    case "scroll": {
      // Exactly one of the three, because "scroll down AND to this element" has
      // no single answer and picking one silently is how an agent ends up
      // describing a part of the page it never reached.
      const given = [b.selector !== undefined, b.by !== undefined, b.to !== undefined].filter(Boolean).length;
      if (given !== 1) return { error: "scroll takes exactly one of: selector, by (pixels), to (top|bottom)" };
      if (b.selector !== undefined) {
        if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
        args.selector = b.selector;
      } else if (b.by !== undefined) {
        const by = typeof b.by === "number" ? b.by : Number(b.by);
        // Capped rather than unbounded: a page cannot be scrolled by a number
        // it cannot hold, and an agent that meant 500 and typed 5e9 should be
        // told, not obeyed.
        if (!Number.isFinite(by) || Math.abs(by) > 1_000_000) return { error: "by must be a number of pixels" };
        args.by = by;
      } else {
        if (b.to !== "top" && b.to !== "bottom") return { error: "to must be top or bottom" };
        args.to = b.to;
      }
      break;
    }
    case "press": {
      if (typeof b.key !== "string" || !KEYS.includes(b.key)) {
        return { error: `key must be one of: ${KEYS.join(", ")}` };
      }
      args.key = b.key;
      break;
    }
    case "read":
    case "shot":
    case "back":
    case "forward":
      break;
  }
  return { ask: { id: nextId(), op: op as BrowserOp, args } };
}

/**
 * Ask the window, and wait for its answer.
 *
 * The "no window" case is checked before parking anything: a request that will
 * never be answered should fail in milliseconds with a sentence somebody can
 * act on, not time out. It is also the commonest failure by far — an agent
 * driving a browser in an app nobody has opened.
 */
export function askBrowser(ask: BrowserAsk): Promise<BrowserReply> {
  // Two different absences, said differently, because only one of them can be
  // fixed by the caller. Collapsing them cost a working feature for one build:
  // with the pane simply not opened yet, the answer said the window was shut,
  // so the CLI — which knows how to open a pane and not how to open a window —
  // stopped instead of retrying.
  if (!sink || sink.listeners() === 0) {
    return Promise.resolve({ ok: false, error: "the agentglass window is not open — the browser lives in it" });
  }
  if (browserReadyCount() === 0) {
    return Promise.resolve({ ok: false, error: "the browser view is not open in this window" });
  }
  return new Promise<BrowserReply>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(ask.id);
      resolve({ ok: false, error: `the browser did not answer in time (${ask.op})` });
    }, TIMEOUT_MS[ask.op]);
    pending.set(ask.id, { resolve, timer });
    sink!.send(ask);
  });
}

/** The panel reporting back. Unknown ids are dropped rather than logged loudly:
 *  a reply arriving after its timeout is ordinary, not an error. */
export function settleBrowser(id: unknown, reply: BrowserReply): boolean {
  if (typeof id !== "string") return false;
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(reply);
  return true;
}

/** For tests, and for a shutdown that should not leave timers behind. */
export function resetBrowserDrive(): void {
  ready.clear();
  for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "cancelled" }); }
  pending.clear();
  sink = null;
  seq = 0;
}

/** How many requests are in flight — the panel's own health readout, and a
 *  guard in tests against a leak that only shows up as a slow suite. */
export const pendingBrowserCount = () => pending.size;
