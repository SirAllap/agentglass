/**
 * A local site that is as fussy about a copied session as a large real one.
 *
 * Reading a page proves very little about an imported login: the persistent
 * sign-in cookie is enough for that. What fails is the SENSITIVE action — the
 * POST behind a settings page — and it fails by redirecting somewhere
 * unremarkable rather than by erroring. This site reproduces each of the ways
 * a session can be half-copied, and says which one it caught in the redirect's
 * `reason`, so a test (or a person in a browser) can tell them apart:
 *
 *   signed-out       the `__Host-` session cookie never arrived — Chromium
 *                    refuses a `__Host-` cookie that carries a Domain, and a
 *                    copy that turns every host-only cookie into a domain one
 *                    loses exactly this one;
 *   same-site        the SameSite=Strict marker on the parent domain did not
 *                    come with the request (not copied, or not for this host);
 *   another-browser  the user agent is not the family the session signed in
 *                    with, or its client hints contradict it;
 *   another-tab      the CSRF token on the form was minted for a different
 *                    session cookie than the POST carried — a fresh session
 *                    cookie shadowing the copied one, which is what two cookies
 *                    of the same name at different scopes produce;
 *   sudo             the session cookie that remembers a recent re-auth is a
 *                    SESSION cookie (no expiry), and a copy that skips session
 *                    cookies gets a fresh one without it;
 *   device           the device key the page reads from localStorage is not
 *                    the one this session was bound to.
 *
 * Every name and value here is invented. No real site is being imitated in
 * any detail beyond "checks the things strict sites check".
 */
import { createHmac, randomBytes } from "node:crypto";

export const SITE = "acme.test";
export const WWW = `www.${SITE}`;
export const API = `api.${SITE}`;

export const FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** A cookie as the SOURCE browser's jar holds it: every attribute, because
 *  the fake Firefox profile is written from this. `expires` is seconds since
 *  the epoch, 0 for a session cookie. */
export interface JarCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "none" | "lax" | "strict" | "unset";
}

export interface Seeded {
  cookies: JarCookie[];
  localStorage: { origin: string; entries: Record<string, string> }[];
  ua: string;
}

export interface StrictSite {
  port: number;
  scheme: "http" | "https";
  url: (host: string, path?: string) => string;
  /** The same server by loopback address, for a client with no resolver
   *  rules: send the site's hostname in a `host` header. */
  direct: (path?: string) => string;
  /** A signed-in, recently re-authenticated session, as the source browser
   *  would hold it. */
  seed: (ua?: string) => Seeded;
  stop: () => void;
}

interface Session { user: string; ua: string; device: string }
interface Sess { secret: string; elevated: boolean; sid?: string }

type Family = "firefox" | "chromium" | "electron" | "other";
export function family(ua: string): Family {
  if (/Electron\//.test(ua)) return "electron";
  if (/Firefox\/\d/.test(ua) && !/Chrome\//.test(ua)) return "firefox";
  if (/Chrome\//.test(ua)) return "chromium";
  return "other";
}

/** The FIRST value of a cookie name, which is what most frameworks read when a
 *  request carries two — and so what makes a shadowing duplicate bite. */
export function firstCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}
export function cookieNames(header: string | null): string[] {
  return (header ?? "").split(/;\s*/).map((p) => p.slice(0, Math.max(0, p.indexOf("=")))).filter(Boolean);
}

const DAY = 86_400;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function startStrictSite(opts: { tls?: { cert: string; key: string } } = {}): StrictSite {
  const sessions = new Map<string, Session>();
  const sesses = new Map<string, Sess>();
  const key = randomBytes(16);
  const csrfFor = (secret: string) => createHmac("sha256", key).update(secret).digest("hex").slice(0, 32);
  const scheme = opts.tls ? "https" : "http";

  const page = (title: string, body: string, headers: Record<string, string> = {}, status = 200) =>
    new Response(`<!doctype html><title>${esc(title)}</title><h1>${esc(title)}</h1>${body}`,
      { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  const redirect = (to: string, headers: Headers = new Headers()) => {
    headers.set("location", to);
    return new Response(null, { status: 303, headers });
  };

  const server = Bun.serve({
    port: 0,
    ...(opts.tls ? { tls: opts.tls } : {}),
    async fetch(req) {
      const u = new URL(req.url);
      const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
      const cookie = req.headers.get("cookie");
      const ua = req.headers.get("user-agent") ?? "";

      // Any host: which cookie NAMES arrived. Never the values. This is how a
      // host-only cookie that was copied as a domain cookie shows up — it
      // reaches a sibling it was never meant for.
      if (u.pathname === "/whoami") {
        return Response.json({ host, cookies: cookieNames(cookie) });
      }
      if (host !== WWW) return new Response("not this host", { status: 404 });

      const sid = firstCookie(cookie, "__Host-acme_sid");
      const who = sid ? sessions.get(sid) : undefined;

      if (u.pathname === "/") {
        return who ? page(`Signed in as ${who.user}`, `<a href="/settings/danger">Danger zone</a>`)
          : page("Sign in to Acme", `<form method="post" action="/login"><input name="password" type="password"></form>`);
      }
      if (u.pathname === "/login") {
        const reason = u.searchParams.get("reason") ?? "";
        const flash = reason === "another-browser" ? "<p class=flash>You signed in with another tab or window.</p>" : "";
        return page("Sign in to Acme", `${flash}<form method="post" action="/login"><input name="password" type="password"></form>`);
      }
      if (u.pathname === "/sessions/confirm") {
        return page("Confirm access", `<form method="post" action="/sessions/confirm"><input name="password" type="password"></form>`);
      }
      if (u.pathname === "/settings/danger" && req.method === "GET") {
        if (!who) return redirect("/login?reason=signed-out");
        // A missing or unknown session cookie gets a fresh one, as any
        // framework does — which is exactly how a skipped session cookie hides.
        const headers = new Headers();
        let sessId = firstCookie(cookie, "acme_sess");
        let sess = sessId ? sesses.get(sessId) : undefined;
        if (!sess) {
          sessId = randomBytes(12).toString("hex");
          sess = { secret: randomBytes(12).toString("hex"), elevated: false };
          sesses.set(sessId, sess);
          headers.append("set-cookie", `acme_sess=${sessId}; Path=/; Secure; HttpOnly; SameSite=Lax`);
        }
        const flash = u.searchParams.get("flash") === "another-tab"
          ? "<p class=flash>You signed in with another tab or window. Reload to refresh your session.</p>" : "";
        const hdrs: Record<string, string> = {};
        headers.forEach((v, k) => { hdrs[k] = v; });
        const r = page("Danger zone", `${flash}
<form method="post" action="/settings/danger">
  <input type="hidden" name="csrf" value="${csrfFor(sess.secret)}">
  <input type="hidden" name="device" value="">
  <button id="go">Delete everything</button>
</form>
<script>document.querySelector('[name=device]').value = localStorage.getItem('acme_device_key') || '';</script>`);
        for (const v of headers.getSetCookie()) r.headers.append("set-cookie", v);
        return r;
      }
      if (u.pathname === "/settings/danger" && req.method === "POST") {
        const form = await req.formData();
        if (!who) return redirect("/login?reason=signed-out");
        const marker = firstCookie(cookie, "__Secure-acme_same_site");
        if (!marker || marker !== sid) return redirect("/login?reason=same-site");
        const claimsChromium = req.headers.has("sec-ch-ua");
        if (family(ua) !== family(who.ua) || (family(ua) === "firefox" && claimsChromium)) {
          return redirect("/login?reason=another-browser");
        }
        const sessId = firstCookie(cookie, "acme_sess");
        const sess = sessId ? sesses.get(sessId) : undefined;
        if (!sess || form.get("csrf") !== csrfFor(sess.secret)) return redirect("/settings/danger?flash=another-tab");
        if (!sess.elevated || sess.sid !== sid) return redirect("/sessions/confirm?reason=sudo");
        if (form.get("device") !== who.device) return redirect("/sessions/confirm?reason=device");
        return page("Done", `<p id="done">The dangerous thing happened.</p>`);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port as number;
  return {
    port,
    scheme,
    url: (host, path = "/") => `${scheme}://${host}:${port}${path}`,
    direct: (path = "/") => `${scheme}://127.0.0.1:${port}${path}`,
    seed(uaIn = FIREFOX_UA) {
      const sid = randomBytes(16).toString("hex");
      const sessId = randomBytes(12).toString("hex");
      const device = randomBytes(8).toString("hex");
      sessions.set(sid, { user: "orbit-dev", ua: uaIn, device });
      sesses.set(sessId, { secret: randomBytes(12).toString("hex"), elevated: true, sid });
      const now = Math.floor(Date.now() / 1000);
      return {
        ua: uaIn,
        cookies: [
          { host: WWW, name: "__Host-acme_sid", value: sid, path: "/", expires: now + 30 * DAY, secure: true, httpOnly: true, sameSite: "lax" },
          { host: `.${SITE}`, name: "__Secure-acme_same_site", value: sid, path: "/", expires: now + 30 * DAY, secure: true, httpOnly: true, sameSite: "strict" },
          { host: WWW, name: "acme_sess", value: sessId, path: "/", expires: 0, secure: true, httpOnly: true, sameSite: "lax" },
          { host: `.${SITE}`, name: "acme_theme", value: "dark", path: "/", expires: now + 365 * DAY, secure: false, httpOnly: false, sameSite: "unset" },
        ],
        localStorage: [{ origin: `${scheme}://${WWW}:${port}`, entries: { acme_device_key: device, acme_draft: "hello" } }],
      };
    },
    stop: () => server.stop(true),
  };
}
