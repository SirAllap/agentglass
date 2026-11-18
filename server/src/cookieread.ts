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
import { findProfiles, probeChromium, readFirefox, readFirefoxAll, snapshot, type FoundProfile } from "./cookiesources.ts";
import {
  isNoCopy, listVaults, noCopyDefault, pullSite, readPullLog, readSettings, readVault, removeSite, removeVault, emptyVaults, suggestSensitive, visitSuggestSensitive, mostUsedSites, vaultIdOf, VaultError,
  vaultSites, writeSettings, writeVault, type VaultIndexEntry, type VaultSettings,
} from "./loginvault.ts";
import { siteOf, type CookieRow, type SkipReason } from "./cookieimport.ts";
import { chromiumKey, chromiumVerdict, chromiumWhy, deriveKey, readChromium, type ChromiumRead } from "./chromiumcookies.ts";
import { readFirefoxPlaces, readChromeHistory, readChromeBookmarks, merge as mergePlaces, type Place as PlaceRow } from "./places.ts";
import { join } from "node:path";
import { readZenShelf } from "./zenshelf.ts";
import { readFirefoxStorage } from "./sitestorage.ts";

/**
 * One Chrome-family profile, decrypted — or the reason it would not open.
 *
 * "Wrong" is decided by the result, not by the prefix: a jar where nothing
 * decrypts is unreadable, and one where most of it does is readable with a
 * count of what did not. Guessing from `v11` alone is what made this browser
 * unimportable for a year. Unreadable now says WHY: no keyring answered, the
 * keyring is locked, or its key is the wrong one.
 */
async function readChromiumProfile(p: FoundProfile): Promise<{ read: ChromiumRead | null; why: string }> {
  const key = await chromiumKey(p.keyring ?? p.source);
  const snap = snapshot(p.db);
  let read: ChromiumRead | null = null;
  try {
    read = readChromium(snap.path, deriveKey(key.password));
  } catch {
    read = null;
  } finally {
    snap.dispose();
  }
  const verdict = chromiumVerdict(key.state, read?.rows.length ?? 0, read ? read.failed : 1);
  if (read && read.rows.length) return { read, why: "" };
  return { read: null, why: chromiumWhy(verdict === "ok" ? "no-key" : verdict, p.label) };
}
import { planImport } from "./cookieimport.ts";

/**
 * Every login in one browser profile, into the vault: one vault per container
 * (decision F5: never merged), session and partitioned cookies kept.
 *
 * Runs only inside this one-shot, started by the person (decision 2). What
 * leaves is counts per vault — never a site's cookie name or value.
 */
export async function importToVaults(
  profile: FoundProfile, rows: CookieRow[], nowSeconds = Math.floor(Date.now() / 1000),
  /** Sites the person marked "needs storage" (cause 7); only these are read. */
  storageSites: ReadonlySet<string> = new Set(),
): Promise<{ vaults: ({ id: string } & VaultIndexEntry)[]; skipped: Record<SkipReason, number>[] }> {
  const containers = [...new Set(rows.map((r) => r.container ?? "0"))].sort();
  const vaults: ({ id: string } & VaultIndexEntry)[] = [];
  const skipped: Record<SkipReason, number>[] = [];
  for (const container of containers) {
    const opts = { nowSeconds, container, keepSession: true, keepPartitioned: true };
    const sites = planImport(rows, profile.kind, { ...opts, sites: [] }).sites.map((s) => s.site);
    const plan = planImport(rows, profile.kind, { ...opts, sites });
    skipped.push(plan.skipped);
    if (!plan.install.length) continue;
    const id = vaultIdOf(profile.id, container);
    const wanted = new Set(sites.filter((x) => storageSites.has(x)));
    const storage = profile.kind === "firefox" ? readFirefoxStorage(profile.dir, container, wanted, siteOf) : {};
    const entry = await writeVault({
      v: 1, id, importedAt: nowSeconds,
      source: { profile: profile.id, container, label: container === "0" ? profile.label : `${profile.label} — container ${container}` },
      cookies: plan.install, storage,
    }, siteOf);
    vaults.push({ id, ...entry });
  }
  return { vaults, skipped };
}

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
          const { read, why } = await readChromiumProfile(p);
          if (!read) {
            sources.push({ id: p.id, label: p.label, kind: p.kind, readable: false, rows: probe.rows, reason: probe.reason, why, sites: [] });
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
        const { read, why } = await readChromiumProfile(profile);
        if (!read) { await say({ ok: false, error: why }); return 1; }
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
    if (cmd === "vault-import") {
      const id = argv[argv.indexOf("--source") + 1] ?? "";
      const profile = findProfiles().find((p) => p.id === id);
      if (!profile) { await say({ ok: false, error: `no such browser profile: ${id}` }); return 1; }
      let rows: CookieRow[];
      if (profile.kind === "firefox") rows = readFirefoxAll(profile.db, profile.dir);
      else {
        const { read, why } = await readChromiumProfile(profile);
        if (!read) { await say({ ok: false, error: why }); return 1; }
        rows = read.rows;
      }
      /* `--sites a,b`: only these sites go in (the person's picks, state 2). */
      const at = argv.indexOf("--sites");
      if (at >= 0) {
        const only = new Set((argv[at + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
        rows = rows.filter((r) => only.has(siteOf(r.host)));
      }
      try {
        const settings = await readSettings();
        const done = await importToVaults(profile, rows, undefined, new Set(Object.keys(settings.storage)));
        await say({ ok: true, vaults: done.vaults, skipped: done.skipped });
        return 0;
      } catch (e) {
        if (e instanceof VaultError) { await say({ ok: false, code: e.code, error: e.message }); return 1; }
        throw e;
      }
    }
    /*
     * One site, one vault, for one pull (plan part C, decision F3).
     *
     * Electron main spawns this per pull and reads the answer off the pipe.
     * The values go to main and nowhere else: main sets them into the lane and
     * drops them. The server and the agent get the count from main, never
     * this answer.
     */
    if (cmd === "vault-pull") {
      const site = argv.includes("--site") ? argv[argv.indexOf("--site") + 1] ?? "" : "";
      const vault = argv.includes("--vault") ? argv[argv.indexOf("--vault") + 1] : undefined;
      try {
        const got = await pullSite({ site, ...(vault ? { vault } : {}) }, siteOf);
        await say(got);
        return got.ok ? 0 : 1;
      } catch (e) {
        if (e instanceof VaultError) { await say({ ok: false, code: e.code, error: e.message }); return 1; }
        throw e;
      }
    }
    /* What the vault table shows (mockup state 3): sites, counts, expiry,
       sensitive marks and the pull log. No cookie name, no value. */
    if (cmd === "vault-list") {
      try {
        const settings = await readSettings();
        const vaults = await vaultSites(siteOf);
        const used = new Set(mostUsedSites(vaults));
        const index = Object.fromEntries(listVaults().map((v) => [v.id, v]));
        await say({
          ok: true, signOutAtEnd: settings.signOutAtEnd, signInOnVisit: settings.signInOnVisit === true,
          defaultVault: settings.defaultVault && index[settings.defaultVault] ? settings.defaultVault : null,
          vaults: vaults.map((v) => ({
            ...v, updatedAt: index[v.vault]?.updatedAt ?? 0,
            sites: v.sites.map((s) => ({
              ...s, sensitive: settings.sensitive[s.site] === true, noCopy: isNoCopy(s.site, settings), suggested: suggestSensitive(s.site),
              suggestedVisit: visitSuggestSensitive(s.site), mostUsed: used.has(s.site),
              needsStorage: settings.storage[s.site] === true, isDefault: settings.defaults[s.site] === v.vault,
            })),
          })),
          pulls: readPullLog(undefined, 200),
        });
        return 0;
      } catch (e) {
        if (e instanceof VaultError) { await say({ ok: false, code: e.code, error: e.message }); return 1; }
        throw e;
      }
    }
    /* The person's choices about sites. Only the Settings page sends this,
       through main; an agent has no path to it (decision 2). */
    if (cmd === "vault-settings") {
      try {
        const raw = argv[argv.indexOf("--set") + 1] ?? "{}";
        const ask = JSON.parse(raw) as {
          site?: string; sensitive?: boolean; needsStorage?: boolean; defaultVault?: string | null; signOutAtEnd?: boolean;
          signInOnVisit?: boolean; noCopy?: boolean;
        };
        const next: VaultSettings = await readSettings();
        const site = typeof ask.site === "string" ? ask.site.trim().toLowerCase() : "";
        if (site) {
          if (ask.sensitive === true) next.sensitive[site] = true; else if (ask.sensitive === false) delete next.sensitive[site];
          if (ask.needsStorage === true) next.storage[site] = true; else if (ask.needsStorage === false) delete next.storage[site];
          if (typeof ask.defaultVault === "string") next.defaults[site] = ask.defaultVault;
          else if (ask.defaultVault === null) delete next.defaults[site];
          /* Only a choice that differs from the default is kept, so a later
             change to the built-in list still reaches the sites never touched. */
          if (typeof ask.noCopy === "boolean") {
            if (ask.noCopy === noCopyDefault(site)) delete next.noCopy[site]; else next.noCopy[site] = ask.noCopy;
          }
        }
        /* The person's default vault for every site that has no choice of its own.
           A site-less defaultVault; null takes it away. An id the index does not
           hold is refused, so a typo cannot silently turn the default off. */
        if (!site && (typeof ask.defaultVault === "string" || ask.defaultVault === null)) {
          if (ask.defaultVault === null) delete next.defaultVault;
          else if (listVaults().some((v) => v.id === ask.defaultVault)) next.defaultVault = ask.defaultVault;
          else { await say({ ok: false, code: "missing", error: "there is no such vault to make the default" }); return 1; }
        }
        if (typeof ask.signOutAtEnd === "boolean") next.signOutAtEnd = ask.signOutAtEnd;
        if (typeof ask.signInOnVisit === "boolean") next.signInOnVisit = ask.signInOnVisit;
        await writeSettings(next);
        await say({ ok: true });
        return 0;
      } catch (e) {
        if (e instanceof VaultError) { await say({ ok: false, code: e.code, error: e.message }); return 1; }
        await say({ ok: false, error: String(e instanceof Error ? e.message : e) });
        return 1;
      }
    }
    if (cmd === "vault-remove") {
      const id = argv[argv.indexOf("--vault") + 1] ?? "";
      if (argv.includes("--all")) { await say({ ok: true, removed: emptyVaults() }); return 0; }
      if (argv.includes("--site")) {
        const site = argv[argv.indexOf("--site") + 1] ?? "";
        try { await say({ ok: await removeSite(id, site, siteOf) }); return 0; }
        catch (e) {
          if (e instanceof VaultError) { await say({ ok: false, code: e.code, error: e.message }); return 1; }
          throw e;
        }
      }
      await say({ ok: removeVault(id) });
      return 0;
    }
    /*
     * "Use in my browser" (decision F4): a chosen vault, all or chosen sites,
     * for main to pour into the person's own jar. Same pipe, same rule.
     */
    if (cmd === "vault-read") {
      const id = argv[argv.indexOf("--vault") + 1] ?? "";
      const sites = argv.includes("--sites") ? (argv[argv.indexOf("--sites") + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean) : [];
      try {
        const data = await readVault(id);
        const settings = await readSettings();
        const siteOfCookie = (c: { domain?: string; url: string }) => siteOf((c.domain ?? new URL(c.url).hostname).replace(/^\./, ""));
        const asked = sites.length ? data.cookies.filter((c) => sites.includes(siteOfCookie(c))) : data.cookies;
        /* A "never copy" site stays out of every jar, the person's own
           browser too: its values never leave this helper. Named, so main's
           confirm can say which were left out. */
        const noCopy = [...new Set(asked.map(siteOfCookie))].filter((x) => isNoCopy(x, settings)).sort();
        const cookies = asked.filter((c) => !noCopy.includes(siteOfCookie(c)));
        /* The sensitive sites among them, by name, so main's confirm can say
           so before they go into the person's own browser (finding 7). */
        const marks = settings.sensitive;
        const sensitive = [...new Set(cookies.map(siteOfCookie))].filter((x) => marks[x] === true).sort();
        await say({ ok: true, cookies, sensitive, noCopy });
        return 0;
      } catch (e) {
        if (e instanceof VaultError) { await say({ ok: false, code: e.code, error: e.message }); return 1; }
        throw e;
      }
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
