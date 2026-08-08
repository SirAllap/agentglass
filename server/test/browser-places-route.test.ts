/*
 * The history save must not be eaten by the browser-drive relay.
 *
 * Measured against the running app, not reasoned: importing history brought in
 * zero pages and places.db stayed empty, though the reader returned 15,049.
 * The POST went to /browser/places, and the `pathname.startsWith("/browser/")
 * && POST` relay above it — the one that drives the browser for an agent —
 * claimed it first, read "places" as a verb, and answered 400 "unknown browser
 * operation". The catch at the call site treats a failed history read as "the
 * logins are in, the history is a bonus", so nothing ever said it broke.
 *
 * Both sides are pinned here so the fix cannot regress in either direction: a
 * data route (places, visit) reaches its handler and saves; a genuinely unknown
 * verb still bounces off the relay as before.
 *
 * XDG_DATA_HOME is redirected at a temp dir on purpose — placestore writes
 * places.db under it, and a test must never touch the developer's own history.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir: string, data: string, base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: auth(headers), body: JSON.stringify(body) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-places-route-"));
  data = mkdtempSync(join(tmpdir(), "agx-places-data-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const src = new URL("../src/index.ts", import.meta.url).pathname;
  proc = Bun.spawn(["bun", "run", src], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: data, // placestore writes places.db here — never the real one
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

test("POST /browser/places saves history instead of 'unknown browser operation'", async () => {
  const places = [
    { url: "https://example.com/docs", title: "Docs", visits: 3, lastAt: 1_700_000_000, bookmarked: false },
    { url: "https://www.google.com/search?q=react+hooks", title: "react hooks - Google Search", visits: 1, lastAt: 1_700_000_001, bookmarked: false },
  ];
  const r = await post("/browser/places", { source: "unit-import", places });
  const body = await r.json() as { ok?: boolean; error?: string; saved?: number };

  // The regression itself: the relay must NOT have claimed this route.
  expect(body.error).not.toBe("unknown browser operation");
  expect(r.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.saved).toBe(2);

  // And they are actually queryable back, which is what the address bar reads.
  const all = await fetch(`${base}/browser/places/all`, { headers: auth() }).then((x) => x.json()) as { places: { url: string }[] };
  const urls = new Set(all.places.map((p) => p.url));
  expect(urls.has("https://www.google.com/search?q=react+hooks")).toBe(true);
});

test("POST /browser/visit records your own visit, also past the relay", async () => {
  const r = await post("/browser/visit", { url: "https://own.example/page", title: "Mine" });
  const body = await r.json() as { ok?: boolean; error?: string };
  expect(body.error).not.toBe("unknown browser operation");
  expect(body.ok).toBe(true);

  const all = await fetch(`${base}/browser/places/all`, { headers: auth() }).then((x) => x.json()) as { places: { url: string }[] };
  expect(all.places.some((p) => p.url === "https://own.example/page")).toBe(true);
});

test("a genuinely unknown /browser/ verb still bounces off the relay", async () => {
  // The other direction: the fix excludes the data routes by exact path, so an
  // actual unknown drive verb must still be rejected exactly as before.
  const r = await post("/browser/frobnicate", { any: "thing" });
  const body = await r.json() as { error?: string };
  expect(body.error).toBe("unknown browser operation");
});
