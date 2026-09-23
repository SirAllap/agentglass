/*
 * The strict site itself, checked with hand-built Cookie headers.
 *
 * Every other session-import test leans on this fixture telling half-copied
 * sessions apart by the `reason` it redirects with, so each reason is pinned
 * here first: a fixture that waved everything through would make every import
 * test pass for nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIREFOX_UA, WWW, API, startStrictSite, type Seeded, type StrictSite } from "./fixtures/strict-site.ts";

let site: StrictSite;
beforeAll(() => { site = startStrictSite(); });
afterAll(() => site.stop());

const header = (s: Seeded, drop: string[] = []) =>
  s.cookies.filter((c) => !drop.includes(c.name)).map((c) => `${c.name}=${c.value}`).join("; ");

/** GET the form with these cookies, fill it the way the page's script would,
 *  POST it back, and answer where it went. `form` is fetched with the same
 *  cookies plus any the GET set, which is what a browser tab would carry. */
async function sensitive(cookie: string, opts: { ua?: string; device?: string; hints?: boolean } = {}) {
  const ua = opts.ua ?? FIREFOX_UA;
  const get = await fetch(site.direct("/settings/danger"), {
    headers: { host: WWW, cookie, "user-agent": ua }, redirect: "manual",
  });
  if (get.status !== 200) return get.headers.get("location");
  const fresh = get.headers.getSetCookie().map((c) => c.split(";")[0]);
  // A fresh cookie the GET set goes FIRST, the way an older cookie of the same
  // name is ordered ahead of a newer one.
  const carried = [...fresh, cookie].filter(Boolean).join("; ");
  const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
  const body = new URLSearchParams({ csrf, device: opts.device ?? "" });
  const post = await fetch(site.direct("/settings/danger"), {
    method: "POST", body, redirect: "manual",
    headers: {
      host: WWW, cookie: carried, "user-agent": ua, "content-type": "application/x-www-form-urlencoded",
      ...(opts.hints ? { "sec-ch-ua": '"Chromium";v="152"' } : {}),
    },
  });
  return post.status === 200 ? "done" : post.headers.get("location");
}

const device = (s: Seeded) => s.localStorage[0]!.entries.acme_device_key!;

describe("the strict site tells each half-copied session apart", () => {
  test("the whole session, same browser, same device: the action happens", async () => {
    const s = site.seed();
    expect(await sensitive(header(s), { device: device(s) })).toBe("done");
  });

  test("reading works without the session cookie; the sensitive action asks to confirm", async () => {
    const s = site.seed();
    const home = await fetch(site.direct("/"), { headers: { host: WWW, cookie: header(s, ["acme_sess"]) } });
    expect(await home.text()).toContain("Signed in as");
    expect(await sensitive(header(s, ["acme_sess"]), { device: device(s) })).toBe("/sessions/confirm?reason=sudo");
  });

  test("each missing piece has its own reason", async () => {
    const s = site.seed();
    expect(await sensitive(header(s, ["__Host-acme_sid"]), { device: device(s) })).toBe("/login?reason=signed-out");
    expect(await sensitive(header(s, ["__Secure-acme_same_site"]), { device: device(s) })).toBe("/login?reason=same-site");
    expect(await sensitive(header(s), { device: "" })).toBe("/sessions/confirm?reason=device");
  });

  test("another browser family, or a Firefox UA with Chromium's client hints, is another browser", async () => {
    const s = site.seed();
    const chromeUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    expect(await sensitive(header(s), { device: device(s), ua: chromeUa })).toBe("/login?reason=another-browser");
    expect(await sensitive(header(s), { device: device(s), hints: true })).toBe("/login?reason=another-browser");
    const login = await fetch(site.direct("/login?reason=another-browser"), { headers: { host: WWW } });
    expect(await login.text()).toContain("You signed in with another tab or window");
  });

  test("a CSRF token minted for one session cookie and posted with another is another tab", async () => {
    const s = site.seed();
    const get = await fetch(site.direct("/settings/danger"), {
      headers: { host: WWW, cookie: header(s, ["acme_sess"]), "user-agent": FIREFOX_UA }, redirect: "manual",
    });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const post = await fetch(site.direct("/settings/danger"), {
      method: "POST", redirect: "manual", body: new URLSearchParams({ csrf, device: device(s) }),
      headers: { host: WWW, cookie: header(s), "user-agent": FIREFOX_UA },
    });
    expect(post.headers.get("location")).toBe("/settings/danger?flash=another-tab");
  });

  test("a sibling host reports cookie NAMES only, never a value", async () => {
    const s = site.seed();
    const r = await (await fetch(site.direct("/whoami"), { headers: { host: API, cookie: header(s) } })).json() as { cookies: string[] };
    expect(r.cookies).toContain("acme_sess");
    expect(JSON.stringify(r)).not.toContain(s.cookies[0]!.value);
  });
});
