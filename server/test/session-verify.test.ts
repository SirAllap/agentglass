/*
 * `session verify` names a rejected session instead of stepping past it.
 *
 * The bug it is for: a copied session reads pages, but the sensitive POST
 * redirects to a login or confirm page and the site shows "you signed in with
 * another tab or window" — no error, so an agent carries on as if it worked.
 * verify reads the page in front and says whether it is such a wall.
 */
import { afterEach, expect, test } from "bun:test";
import { startBrowserStub, runCli } from "./fixtures/browser-stub.ts";

const HAVE_PY = !!Bun.which("python3");

/** A stub whose page (as `eval` sees it) is fixed per test. */
function pageStub(page: { url: string; title?: string; pw?: boolean; text?: string }) {
  return startBrowserStub((op) => {
    if (op === "eval") return { ok: true, value: { value: JSON.stringify({ url: page.url, title: page.title ?? "", pw: !!page.pw, text: page.text ?? "" }) } };
    return { ok: true, value: {} };
  });
}

let stub: ReturnType<typeof startBrowserStub> | null = null;
afterEach(() => { stub?.stop(); stub = null; });

test.skipIf(!HAVE_PY)("the site's own words are the verdict, and its reason is quoted", async () => {
  stub = pageStub({ url: "https://www.orbit.example/login?reason=another-browser", pw: true, text: "You signed in with another tab or window." });
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "verify"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("the session was rejected");
  expect(r.stdout).toContain("signed in with another tab or window");
});

test.skipIf(!HAVE_PY)("a redirect to a confirm page is caught by its path, with the reason", async () => {
  stub = pageStub({ url: "https://www.orbit.example/sessions/confirm?reason=sudo", title: "Confirm access" });
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "verify"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("sudo");
});

test.skipIf(!HAVE_PY)("a page that is not a wall passes, and says where", async () => {
  stub = pageStub({ url: "https://www.orbit.example/settings/danger", title: "Danger zone" });
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "verify"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("looks accepted");
  expect(r.stdout).toContain("/settings/danger");
});

test.skipIf(!HAVE_PY)("a plain page with a password field alone is NOT called a wall", async () => {
  // A change-password form deep in a signed-in app has a password field and is
  // not a login. Only a field PLUS a login-shaped url or title is a wall.
  stub = pageStub({ url: "https://www.orbit.example/settings/security", title: "Security settings", pw: true });
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "verify"]);
  expect(r.code, r.stdout).toBe(0);
});
