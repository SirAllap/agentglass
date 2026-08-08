/**
 * Finding a browser's cookie store on this machine, and reading it safely.
 *
 * The only place in this feature that touches a filesystem or a database. It is
 * separate from the conversion (cookieimport.ts) because the conversion is
 * where the subtle mistakes live and it should be testable without any of this;
 * this half is where the *machine* is, and the machine is where the surprises
 * are:
 *
 *   * **Never open the live file.** Firefox runs in WAL mode, so a single-file
 *     copy can miss committed data or be torn. The `-wal` comes with it; the
 *     `-shm` deliberately does not — SQLite regenerates it, and copying a live
 *     one alongside a `-wal` is how the two end up disagreeing.
 *   * **Profiles are not a glob.** This machine has two Firefox profile
 *     directories with no cookie store at all, a Zen profile whose directory
 *     name contains a space and brackets, and two Chrome profiles that are two
 *     separate stores. `profiles.ini` is the only thing that knows.
 *   * **Chromium's values are encrypted, and that is not final.** Every value in
 *     this machine's Chrome is `v11`, keyed from the desktop keyring. This file
 *     used to stop there and report a refusal, on the grounds that reaching the
 *     key would take a hand-rolled D-Bus Secret Service conversation and half
 *     of one was worse than none. That conversation is now written
 *     (secretservice.ts) and the decryption with it (chromiumcookies.ts): 276
 *     cookies out of 276 on the profile that prompted the refusal. `probe` is
 *     still here, because a jar where nothing decrypts is still a real answer —
 *     it is just no longer the assumed one.
 *
 * What leaves this module for the picker is counts and site names. Never a
 * cookie value, and never a cookie name.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CookieRow, SourceKind } from "./cookieimport.ts";
import { chromeEpochSeconds, ffExpirySeconds } from "./cookieimport.ts";

function home(): string {
  const env = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  return env && env.length ? env : homedir();
}

export interface SourceDef {
  id: string;
  label: string;
  kind: SourceKind;
  /** Where the profiles live, relative to home. The first one that exists wins;
   *  the list covers native, snap and flatpak layouts of the same browser. */
  dirs: string[];
  /** What this browser files its cookie key under in the desktop keyring.
   *  Chromium-family only — Firefox stores its values in the clear. */
  keyring?: string;
}

/**
 * The install shapes worth looking in.
 *
 * Broader than what this machine has on purpose — it has native Firefox, a
 * flatpak Zen and native Chrome, and somebody else's has the others — but every
 * entry is a real path a real packaging of that browser uses, not a guess.
 */
export const LINUX_SOURCES: SourceDef[] = [
  { id: "firefox", label: "Firefox", kind: "firefox", dirs: [".mozilla/firefox", "snap/firefox/common/.mozilla/firefox", ".var/app/org.mozilla.firefox/.mozilla/firefox"] },
  { id: "zen", label: "Zen", kind: "firefox", dirs: [".zen", ".var/app/app.zen_browser.zen/.zen"] },
  { id: "librewolf", label: "LibreWolf", kind: "firefox", dirs: [".librewolf", ".var/app/io.gitlab.librewolf-community/.librewolf"] },
  { id: "chrome", label: "Google Chrome", kind: "chromium", keyring: "chrome", dirs: [".config/google-chrome"] },
  { id: "chromium", label: "Chromium", kind: "chromium", keyring: "chromium", dirs: [".config/chromium", "snap/chromium/common/chromium"] },
  { id: "brave", label: "Brave", kind: "chromium", keyring: "brave", dirs: [".config/BraveSoftware/Brave-Browser", ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"] },
];

export interface FoundProfile {
  /** `<source id>:<profile dir name>`, which is what the picker sends back. */
  id: string;
  source: string;
  label: string;
  kind: SourceKind;
  /** Carried through from the source, so the reader can ask the keyring
   *  without looking the browser up again. */
  keyring?: string;
  /** The directory holding the cookie database. */
  dir: string;
  /** Absolute path of the database itself. */
  db: string;
}

/**
 * Parse a Firefox `profiles.ini`.
 *
 * Pure and exported because it is the part that can be wrong quietly: a
 * `Path=` that is absolute rather than relative, a profile with no cookie store
 * in it, a directory name with a space in it. This machine has all three.
 */
export function parseProfilesIni(text: string, baseDir: string): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  let section = "", path = "", relative = true, name = "";
  const flush = () => {
    if (section.startsWith("Profile") && path) {
      out.push({ name: name || path, dir: relative ? join(baseDir, path) : path });
    }
    path = ""; relative = true; name = "";
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { flush(); section = line.slice(1, -1); continue; }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k === "Path") path = v;
    else if (k === "IsRelative") relative = v !== "0";
    else if (k === "Name") name = v;
  }
  flush();
  return out;
}

/** Every profile on this machine with a cookie store actually in it. */
export function findProfiles(): FoundProfile[] {
  const found: FoundProfile[] = [];
  for (const src of LINUX_SOURCES) {
    for (const rel of src.dirs) {
      const base = join(home(), rel);
      if (!existsSync(base)) continue;
      const dbName = src.kind === "firefox" ? "cookies.sqlite" : "Cookies";
      const dirs: { name: string; dir: string }[] = [];
      if (src.kind === "firefox") {
        const ini = join(base, "profiles.ini");
        if (existsSync(ini)) {
          try { dirs.push(...parseProfilesIni(readFileSync(ini, "utf8"), base)); } catch { /* unreadable */ }
        }
      } else {
        // Chromium keeps its profiles as plain directories beside Local State.
        for (const name of ["Default", ...safeList(base).filter((n) => n.startsWith("Profile "))]) {
          dirs.push({ name, dir: join(base, name) });
        }
      }
      for (const p of dirs) {
        const db = join(p.dir, dbName);
        try { if (!statSync(db).isFile()) continue; } catch { continue; }
        found.push({
          id: `${src.id}:${basename(p.dir)}`,
          source: src.id, label: `${src.label} — ${p.name}`, kind: src.kind, dir: p.dir, db,
          ...(src.keyring ? { keyring: src.keyring } : {}),
        });
      }
      // A browser found in one layout is not looked for in the others: a
      // flatpak and a native install of the same browser are different stores,
      // but listing the same one twice under two paths is just confusing.
      if (found.some((f) => f.source === src.id)) break;
    }
  }
  return found;
}

const safeList = (dir: string): string[] => {
  try { return readdirSync(dir); } catch { return []; }
};

/**
 * A private copy of the store, with its write-ahead log.
 *
 * The caller always removes it — cookie values live in it. Mode 0700 on the
 * directory, because /tmp is everybody's.
 */
export function snapshot(db: string): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agx-cookies-"), { mode: 0o700 } as never);
  const copy = join(dir, basename(db));
  copyFileSync(db, copy);
  // The -wal holds anything committed since the last checkpoint. The -shm is
  // deliberately not copied: SQLite regenerates it, and a live one taken
  // alongside a -wal can disagree with it.
  try { if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${copy}-wal`); } catch { /* nothing to bring */ }
  return { path: copy, dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } } };
}

/** Firefox's rows, normalised. The expiry divisor comes from the file's own
 *  schema version rather than from a guess about which Firefox this is. */
export function readFirefox(db: string): CookieRow[] {
  const snap = snapshot(db);
  try {
    const conn = new Database(snap.path, { readonly: true });
    try {
      const v = conn.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      const rows = conn.query<Record<string, unknown>, []>(
        "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies",
      ).all();
      return rows.map((r) => ({
        host: String(r.host ?? ""),
        name: String(r.name ?? ""),
        value: String(r.value ?? ""),
        path: String(r.path ?? "/"),
        expires: ffExpirySeconds(Number(r.expiry ?? 0), v),
        secure: Number(r.isSecure ?? 0) === 1,
        httpOnly: Number(r.isHttpOnly ?? 0) === 1,
        sameSite: Number(r.sameSite ?? 256),
        // Containers and partitioned cookies both live here.
        partition: String(r.originAttributes ?? "") || undefined,
      }));
    } finally { conn.close(); }
  } finally { snap.dispose(); }
}

export type ChromiumRefusal = "v11-keyring" | "v10-peanuts" | "app-bound" | "unreadable";

/**
 * What is in a Chromium store, without decrypting any of it.
 *
 * Reports the shape of the encryption and how many rows there are, so the UI
 * can name the refusal instead of showing an empty list. `v10` is the fallback
 * key everyone documents; `v11` is the keyring, which is what this machine has
 * for all of them, and getting at it needs a Secret Service conversation this
 * does not have.
 */
export function probeChromium(db: string): { rows: number; reason: ChromiumRefusal } {
  const snap = snapshot(db);
  try {
    const conn = new Database(snap.path, { readonly: true });
    try {
      const rows = conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cookies").get()?.n ?? 0;
      const sample = conn.query<{ encrypted_value: Uint8Array }, []>(
        "SELECT encrypted_value FROM cookies WHERE LENGTH(encrypted_value) > 3 LIMIT 200",
      ).all();
      let v10 = 0, v11 = 0, other = 0;
      for (const s of sample) {
        const p = Buffer.from(s.encrypted_value ?? []).subarray(0, 3).toString("latin1");
        if (p === "v10") v10 += 1; else if (p === "v11") v11 += 1; else other += 1;
      }
      const reason: ChromiumRefusal = v11 > v10 && v11 > other ? "v11-keyring"
        : v10 > 0 ? "v10-peanuts"
          : other > 0 ? "app-bound" : "unreadable";
      return { rows, reason };
    } finally { conn.close(); }
  } finally { snap.dispose(); }
}
