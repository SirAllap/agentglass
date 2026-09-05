/**
 * The one-shot reader: a separate process, on purpose.
 *
 * This used to say the shell COULD NOT do the read: Electron 33 ran Node 20,
 * which had no SQLite. That reason expired at Electron 43 — it ships Node 24,
 * whose `node:sqlite` is unflagged — and the design does not change, because the
 * inability was never what justified it:
 *
 *   * cookie VALUES stay out of the long-lived processes. They exist inside this
 *     one-shot, go out as one line of JSON, and die with it. Nothing in the
 *     shell or the server ever holds them;
 *   * there is no HTTP route for any of it, so an agent driving the browser
 *     cannot ask for somebody's logins. An API route was the obvious other
 *     shape and is deliberately not taken.
 *
 * A packaged app also has no `bun` on PATH, which is why main.js runs the
 * sidecar BINARY with `cookies` rather than `bun run` on this file when packaged
 * — the same code, reached differently.
 *
 * The answer is the LAST line of stdout, not all of it: a module this imports
 * may warn, and a warning must not be parsed as the answer.
 */
import { findProfiles, probeChromium, readFirefox, snapshot, type FoundProfile } from "./cookiesources.ts";
import { chromiumPassword, deriveKey, readChromium, type ChromiumRead } from "./chromiumcookies.ts";
import { readFirefoxPlaces, readChromeHistory, readChromeBookmarks, merge as mergePlaces, type Place as PlaceRow } from "./places.ts";
import { join } from "node:path";
import { readZenShelf } from "./zenshelf.ts";

/**
 * One Chrome-family profile, decrypted — or null when the key was wrong.
 *
 * "Wrong" is decided by the result, not by the prefix: a jar where nothing
 * decrypts is unreadable, and one where most of it does is readable with a
 * count of what did not. Guessing from `v11` alone is what made this browser
 * unimportable for a year.
 */
async function readChromiumProfile(p: FoundProfile): Promise<ChromiumRead | null> {
  const key = deriveKey(await chromiumPassword(p.keyring ?? p.source));
  const snap = snapshot(p.db);
  try {
    const read = readChromium(snap.path, key);
    return read.rows.length ? read : null;
  } catch {
    return null;
  } finally {
    snap.dispose();
  }
}
import { planImport } from "./cookieimport.ts";

export async function runCookieReader(argv: string[]): Promise<number> {
  /*
   * Say it, and wait until it has actually been said.
   *
   * `process.stdout.write` to a PIPE is asynchronous: it returns having queued
   * the bytes, and the caller of this — cookieentry.ts — then calls
   * `process.exit()`, which throws away whatever is still queued. Two hundred
   * and one sites is 360 KB of JSON; 219 KB of it reached the app and the rest
   * died in the buffer, so the answer arrived cut in half and unparseable.
   *
   * It never showed up in a terminal because a redirect to a FILE is written
   * synchronously — the same command, measured the same day, produced all
   * 360,266 bytes and parsed. The pipe is the whole difference, so a test that
   * does not use one cannot see this.
   *
   * The callback form resolves when the bytes have left. Awaiting it before
   * returning the exit code is what makes the exit safe.
   */
  const say = (v: unknown) => new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(v) + "\n", () => resolve());
  });
  const cmd = argv[0];
  try {
    if (cmd === "list") {
      const now = Math.floor(Date.now() / 1000);
      const sources = [];
      for (const p of findProfiles()) {
        if (p.kind !== "firefox") {
          /*
           * Chrome-family, and readable now.
           *
           * This branch used to report `readable: false` and a reason, because
           * the values are sealed. They are — with a key the desktop keyring
           * will hand over for the asking. It is only unreadable when nothing
           * decrypts, which is a thing to find out by trying rather than to
           * assume from the prefix. See chromiumcookies.ts.
           */
          const probe = probeChromium(p.db);
          const read = await readChromiumProfile(p);
          if (!read) {
            sources.push({ id: p.id, label: p.label, kind: p.kind, readable: false, rows: probe.rows, reason: probe.reason, sites: [] });
            continue;
          }
          const plan = planImport(read.rows, "chromium", { sites: [], nowSeconds: now });
          sources.push({
            id: p.id, label: p.label, kind: p.kind, readable: true,
            rows: plan.sites.reduce((n, s) => n + s.cookies, 0), sites: plan.sites,
            ...(read.failed ? { partial: read.failed } : {}),
          });
          continue;
        }
        const plan = planImport(readFirefox(p.db), "firefox", { sites: [], nowSeconds: now });
        sources.push({ id: p.id, label: p.label, kind: p.kind, readable: true, rows: plan.sites.reduce((n, s) => n + s.cookies, 0), sites: plan.sites });
      }
      await say({ ok: true, sources });
      return 0;
    }
    if (cmd === "read") {
      const id = argv[argv.indexOf("--source") + 1] ?? "";
      const sites = (argv[argv.indexOf("--sites") + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const profile = findProfiles().find((p) => p.id === id);
      if (!profile) { await say({ ok: false, error: `no such browser profile: ${id}` }); return 1; }
      if (profile.kind !== "firefox") {
        const read = await readChromiumProfile(profile);
        if (!read) { await say({ ok: false, error: `${profile.label} would not decrypt — its key is not in this session's keyring` }); return 1; }
        if (!sites.length) { await say({ ok: false, error: "choose at least one site" }); return 1; }
        const plan = planImport(read.rows, "chromium", { sites, nowSeconds: Math.floor(Date.now() / 1000) });
        await say({ ok: true, cookies: plan.install, skipped: plan.skipped });
        return 0;
      }
      // Nothing chosen imports nothing — the invariant, enforced here as well as
      // in planImport, because this is the process that holds the values.
      if (!sites.length) { await say({ ok: false, error: "choose at least one site" }); return 1; }
      const plan = planImport(readFirefox(profile.db), "firefox", { sites, nowSeconds: Math.floor(Date.now() / 1000) });
      await say({ ok: true, cookies: plan.install, skipped: plan.skipped });
      return 0;
    }
    /*
     * History and bookmarks, from the same profiles the cookies came from.
     *
     * Here rather than on an HTTP route for the same reason the cookies are:
     * this is somebody's browsing history, and a route would put it on the API
     * surface where an agent driving the browser could ask for it.
     */
    if (cmd === "places") {
      const id = argv[argv.indexOf("--source") + 1] ?? "";
      const profile = findProfiles().find((p) => p.id === id);
      if (!profile) { await say({ ok: false, error: `no such browser profile: ${id}` }); return 1; }
      const dir = profile.dir;
      let places: PlaceRow[] = [];
      if (profile.kind === "firefox") {
        const snap = snapshot(join(dir, "places.sqlite"));
        try { places = readFirefoxPlaces(snap.path); } catch { /* no history there */ } finally { snap.dispose(); }
      } else {
        const snap = snapshot(join(dir, "History"));
        try { places = readChromeHistory(snap.path); } catch { /* no history there */ } finally { snap.dispose(); }
        places = mergePlaces(places, readChromeBookmarks(join(dir, "Bookmarks")));
      }
      await say({ ok: true, places });
      return 0;
    }
    /*
     * Somebody's Zen sidebar: its spaces, its folders and its pinned pages.
     *
     * Here for the same reason as the history above — this is somebody's
     * browsing, read once by a one-shot with no HTTP route in front of it. Zen
     * only: the file is Zen's own, and Firefox proper has no sidebar to import.
     */
    if (cmd === "shelf") {
      const id = argv[argv.indexOf("--source") + 1] ?? "";
      const profile = findProfiles().find((p) => p.id === id);
      if (!profile) { await say({ ok: false, error: `no such browser profile: ${id}` }); return 1; }
      if (!id.startsWith("zen:")) { await say({ ok: false, error: `${profile.label} does not keep a sidebar to import` }); return 1; }
      try {
        await say({ ok: true, shelf: readZenShelf(profile.dir) });
        return 0;
      } catch (e) {
        // Named, because "it did not work" for a file that is simply not there
        // yet (a Zen that has never been opened) is a different thing to fix.
        await say({ ok: false, error: `could not read ${profile.label}'s sidebar: ${e instanceof Error ? e.message : String(e)}` });
        return 1;
      }
    }
    await say({ ok: false, error: `unknown cookie command: ${cmd ?? "(none)"}` });
    return 1;
  } catch (e) {
    await say({ ok: false, error: e instanceof Error ? e.message : String(e) });
    return 1;
  }
}

// Only when run as a program. Imported by index.ts as a module, this must do
// nothing at all — otherwise every server boot runs the reader.
if (import.meta.main) {
  process.exit(await runCookieReader(process.argv.slice(2)));
}
