/*
 * The `will-attach-webview` guard, finally under test.
 *
 * docs/BROWSER-TIER1.md asked for this when the browser shipped ("The
 * `will-attach-webview` guard: given hostile params, assert the dangerous ones
 * are stripped") and it did not exist. Nothing in the repo touched
 * `safeGuestUrl` or the guard body — web/test/browser-drive.test.ts covers the
 * verbs against a fake element, web/test/browser-profiles.test.ts covers the
 * partition NAMES, and the one function that decides whether a page the app did
 * not write may hold the app's bridge was checked by eye, in a running app,
 * once.
 *
 * Written before the Electron 33 → 43 upgrade rather than after, so "the guard
 * survived the bump" is something the suite says and not something the person
 * who did the bump says.
 *
 * The two failures it exists to catch, both silent in the worst direction:
 *   * a guest that attaches with a `preload` — it would get `window.agentglass`
 *     and with it the API token, i.e. a terminal and git write access handed to
 *     whatever page is loaded;
 *   * a guest that attaches on `persist:agentglass` — the app's OWN session,
 *     where that token's storage lives.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

/*
 * `createRequire` rather than an import: the shell is CommonJS with no build
 * step, and web/tsconfig.test.json (which typechecks this directory) has no
 * allowJs, so a plain import of a .js file outside web/ is a type error before
 * it is anything else. This keeps the module resolution at runtime, where bun
 * does it happily.
 */
const load = createRequire(import.meta.url);
const guard: {
  BROWSER_PARTITION: string;
  BROWSER_PARTITION_RE: RegExp;
  isBrowserPartition: (p: unknown) => boolean;
  safeGuestUrl: (src: unknown) => string | null;
  applyGuestGuard: (
    webPreferences: Record<string, unknown>,
    params: Record<string, unknown>,
  ) => boolean;
} = load("../../electron/guest-guard.js");

const { BROWSER_PARTITION, isBrowserPartition, safeGuestUrl, applyGuestGuard } = guard;

/** What Electron hands the handler: the preferences it is about to build the
 *  guest from, and the tag's attributes. Both are the renderer's to write, which
 *  is why neither is trusted. */
const attach = (params: Record<string, unknown>, webPreferences: Record<string, unknown> = {}) => {
  const prefs: Record<string, unknown> = { partition: BROWSER_PARTITION, ...webPreferences };
  const p: Record<string, unknown> = { src: "https://example.com/", ...params };
  return { allowed: applyGuestGuard(prefs, p), prefs, params: p };
};

describe("safeGuestUrl", () => {
  test("http and https pass", () => {
    expect(safeGuestUrl("https://example.com/")).toBe("https://example.com/");
    expect(safeGuestUrl("http://example.com/")).toBe("http://example.com/");
  });

  test("about:blank passes, because a blank home page is a setting", () => {
    // Refusing it would turn "leave the home page blank" into a guest that
    // never attaches — a blank rectangle with no error.
    expect(safeGuestUrl("about:blank")).toBe("about:blank");
  });

  test("file: does not", () => {
    // The exact probe to type into DevTools. A guest on file: reads the disk of
    // the person running the app.
    expect(safeGuestUrl("file:///etc/passwd")).toBeNull();
    expect(safeGuestUrl("file:///home/user/.config/agentglass/token")).toBeNull();
  });

  test("nor any other scheme that can reach the app or the machine", () => {
    for (const src of [
      "agentglass://index.html",      // the renderer's own origin, where localStorage lives
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "javascript:fetch('/api')",
      "data:text/html,<script>1</script>",
      "blob:https://example.com/abc",
      "ws://127.0.0.1:4000/",
    ]) expect(safeGuestUrl(src), src).toBeNull();
  });

  test("credentials in the URL are refused, not stripped", () => {
    // `https://user:pass@host` in a src attribute is a credential-stuffing
    // shape, never something a person typed.
    expect(safeGuestUrl("https://user:pass@example.com/")).toBeNull();
    expect(safeGuestUrl("https://user@example.com/")).toBeNull();
  });

  test("nothing that is not a string, and nothing empty", () => {
    for (const src of [undefined, null, "", 0, {}, [], true]) {
      expect(safeGuestUrl(src), String(src)).toBeNull();
    }
  });
});

describe("which partition a guest may attach on", () => {
  test("the app's own session is not in the family", () => {
    // The one string this must never accept. `persist:agentglass` holds the
    // renderer's storage, including the API token's.
    expect(isBrowserPartition("persist:agentglass")).toBe(false);
    expect(attach({}, { partition: "persist:agentglass" }).allowed).toBe(false);
  });

  test("the browsing family is", () => {
    expect(attach({}, { partition: BROWSER_PARTITION }).allowed).toBe(true);
    expect(attach({}, { partition: `${BROWSER_PARTITION}-work` }).allowed).toBe(true);
  });

  test("and nothing that only looks like it", () => {
    for (const partition of [
      "persist:agentglass-browser-",          // an empty suffix is not a profile
      "persist:agentglass-browser-WORK",      // uppercase is outside the alphabet
      "persist:agentglass-browser-../../app", // a path is the reason for the alphabet
      "persist:agentglass-browserx",
      "agentglass-browser",                   // not persisted, and not the family
      "",
      undefined,
    ]) expect(attach({}, { partition }).allowed, String(partition)).toBe(false);
  });
});

describe("what an attaching guest is allowed to be", () => {
  test("a hostile src never attaches", () => {
    expect(attach({ src: "file:///etc/passwd" }).allowed).toBe(false);
    expect(attach({ src: "agentglass://index.html" }).allowed).toBe(false);
  });

  test("a preload is removed, in both spellings and on both objects", () => {
    // The whole reason the guard exists. `preload` is the app's bridge; a guest
    // holding it holds the token. `preloadURL` is the older spelling Electron
    // carried alongside it — leaving either is how a guest ends up with it.
    const { allowed, prefs, params } = attach(
      { preload: "/app/preload.js" },
      { preload: "/app/preload.js", preloadURL: "file:///app/preload.js" },
    );
    expect(allowed).toBe(true);
    expect("preload" in prefs).toBe(false);
    expect("preloadURL" in prefs).toBe(false);
    expect("preload" in params).toBe(false);
  });

  test("every dangerous preference the renderer asked for is overwritten", () => {
    const { allowed, prefs } = attach({}, {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      enableBlinkFeatures: "AllowContentInitiatedDataUrlNavigations",
    });
    expect(allowed).toBe(true);
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableBlinkFeatures: "",
    });
  });

  test("the profile it chose is kept", () => {
    // Hardening must not collapse every tab into one cookie jar: which profile
    // a tab is in is the renderer's decision, already checked above.
    expect(attach({}, { partition: `${BROWSER_PARTITION}-work` }).prefs.partition)
      .toBe(`${BROWSER_PARTITION}-work`);
  });

  test("a refused guest is refused before anything is granted", () => {
    // Fail closed: a bad partition with a good src must not come back with a
    // hardened-and-therefore-attachable set of preferences.
    const { allowed, prefs } = attach({}, { partition: "persist:agentglass", sandbox: false });
    expect(allowed).toBe(false);
    expect(prefs.sandbox).toBe(false); // untouched — the caller preventDefaults
  });
});

/*
 * And the wiring, which the unit tests above cannot see.
 *
 * `applyGuestGuard` could be perfect and never called, or called and its answer
 * ignored. main.js is the Electron entry point and cannot be imported under bun
 * (it takes the single-instance lock and registers schemes), so this is read —
 * the same compromise server/test/desktop-origin.test.ts makes for the same
 * reason.
 */
describe("main.js actually uses it", () => {
  const main = load("node:fs").readFileSync(
    new URL("../../electron/main.js", import.meta.url), "utf8",
  ) as string;

  test("the guard is wired to will-attach-webview, and refusal preventDefaults", () => {
    expect(main).toContain('win.webContents.on("will-attach-webview"');
    expect(main).toContain("if (!applyGuestGuard(webPreferences, params)) e.preventDefault();");
  });

  test("nothing re-implements the boundary alongside it", () => {
    // A second copy that drifts is the failure this file cannot otherwise see.
    expect(main).not.toContain("function safeGuestUrl(");
    expect(main).not.toContain("BROWSER_PARTITION_RE =");
  });
});
