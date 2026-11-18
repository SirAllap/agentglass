/*
 * "Open web links in": the one place that decides where a web link that would
 * have gone to the machine's browser goes instead. The setting keeps its id
 * (terminal.otherLinks) from when only terminal links obeyed it; now every
 * link in the app does, through openExternal (externalUrl.ts) and, for the
 * shell's own escapes (target=_blank, window.open), through installLinkRoute.
 */
import { hasUrlCredentials } from "../../../shared/urlCredentials.ts";
import { otherLinks, type OtherLinks } from "./termPrefs.ts";
import { HAS_BROWSER, onOpenLink, openOnMachine } from "./desktop.ts";
import { showBrowserOnBench } from "./benchStore.ts";
import { requestBrowserNav } from "./browserNav.ts";

const TRAILING = /[)\].,;:!?'"»>]+$/;

/** The eight 16-bit groups of an IPv6 literal (`::` expanded, a dotted tail folded in), or null when it is not one. */
function v6Groups(h: string): number[] | null {
  let s = h;
  const tail = s.slice(s.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const q = tail.split(".").map(Number);
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, s.lastIndexOf(":") + 1) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rear = halves[1] ? halves[1].split(":") : [];
  const gap = halves.length === 2 ? 8 - head.length - rear.length : 0;
  if (halves.length === 1 ? head.length !== 8 : gap < 1) return null;
  const g = [...head, ...Array<string>(Math.max(gap, 0)).fill("0"), ...rear].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((n) => !Number.isNaN(n)) ? g : null;
}

/**
 * A literal host the agentglass browser is not sent to from a link: link-local
 * (169.254.0.0/16, the cloud metadata address; fe80::/10), and the unspecified
 * address. Loopback is allowed: a local dev server is what the bench browser is for. The host is normalised first, so an IPv4 wearing an IPv6
 * hat (`::ffff:169.254.169.254`, its hex spelling `::ffff:a9fe:a9fe`, the
 * deprecated `::a9fe:a9fe`) is judged as its IPv4. A name is not judged here.
 * The server's and the shell's guards need node:net, which the web bundle does not have.
 */
export function blockedLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let v4: number[] | null = null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) v4 = h.split(".").map(Number);
  else if (h.includes(":")) {
    const g = v6Groups(h);
    if (!g) return true; // not an address we can read: do not guess
    if (g[0]! >= 0xfe80 && g[0]! <= 0xfebf) return true;
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      if (g[5] === 0 && g[6] === 0 && g[7]! <= 1) return g[7] === 0; // :: is blocked, ::1 is loopback
      v4 = [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
    }
  }
  if (!v4) return false;
  return v4[0] === 0 || (v4[0] === 169 && v4[1] === 254);
}

/**
 * Where a web link goes, given the "Open web links in" setting. Pure. Only
 * http(s) the browser's egress guard would let through is ever sent to the
 * agentglass browser: anything else (file:, javascript:, mailto:, a link-local
 * address, an address with credentials) answers "default", so it goes to the
 * machine's browser exactly as before, with no error.
 */
export function otherLinkSurface(raw: string | null | undefined, mode: OtherLinks): OtherLinks {
  if (mode === "default") return "default";
  const text = raw?.trim().replace(TRAILING, "");
  if (!text) return "default";
  let u: URL;
  try { u = new URL(text); } catch { return "default"; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || hasUrlCredentials(u)) return "default";
  if (blockedLiteral(u.hostname)) return "default";
  return mode;
}

/** Opens a new tab in the agentglass browser, in the view or on the bench. False when it could not (no browser build): the caller falls back. */
export function openInBrowser(url: string, where: "view" | "bench"): boolean {
  if (!HAS_BROWSER) return false;
  if (where === "bench") { if (!showBrowserOnBench()) return false; requestBrowserNav(url); return true; }
  requestBrowserNav(url, "view");
  return true;
}

/** Follow the setting. True when the agentglass browser took the link. */
export function routeLink(url: string): boolean {
  const where = otherLinkSurface(url, otherLinks());
  return where !== "default" && openInBrowser(url, where);
}

/** The shell sends every link it would have opened on the machine here; the setting lives in this process. Returns the unsubscribe. */
export function installLinkRoute(): () => void {
  return onOpenLink((url) => { if (!routeLink(url)) openOnMachine(url); });
}
