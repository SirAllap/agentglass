/*
 * Reading a Chrome-family cookie jar, values and all.
 *
 * This used to be the browser the importer refused, with a message saying the
 * key was held by the desktop keyring and there was "no way for this to ask
 * for it". That was wrong, and it was written with some confidence. Chrome
 * does exactly what every other Chromium browser does on Linux:
 *
 *   password  the string "Chrome Safe Storage" in the keyring, or the literal
 *             "peanuts" when there is no keyring to hold it
 *   key       PBKDF2-HMAC-SHA1(password, "saltysalt", 1 iteration, 16 bytes)
 *   value     AES-128-CBC, IV of sixteen spaces, PKCS#7 padding
 *
 * One iteration and a fixed salt is not a mistake in this file; it is what
 * Chrome does. The secret is not the derivation, it is the keyring.
 *
 * Measured against a real profile before any of it was written: 276 cookies,
 * 276 decrypted, none failed — and 274 of them carried the domain hash
 * described below, which is the part that would otherwise have produced 274
 * values with 32 bytes of rubbish welded to the front.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { Database } from "bun:sqlite";
import type { CookieRow } from "./cookieimport.ts";
import { keyringPassword } from "./secretservice.ts";

/** The prefix a Chromium value carries, and what it means about the key. */
export type Scheme = "v10" | "v11" | "other";

export function schemeOf(value: Uint8Array | Buffer): Scheme {
  const p = Buffer.from(value).subarray(0, 3).toString("latin1");
  return p === "v10" ? "v10" : p === "v11" ? "v11" : "other";
}

/** Chrome's own fallback when no keyring answered. Not a guess: it is the
 *  literal in Chromium's source, and it is why a profile on a machine with no
 *  keyring at all is still readable. */
export const NO_KEYRING_PASSWORD = "peanuts";

/** Every attribute Chromium browsers have filed their key under. `application`
 *  is the current one; older builds used the schema name. */
export const keyringAsks = (app: string): Record<string, string>[] => [
  { application: app },
  { "xdg:schema": "chrome_libsecret_os_crypt_password_v2", application: app },
];

/**
 * The password for one browser, or the fallback.
 *
 * Never throws and never prompts: a locked collection is left locked, because
 * a keyring dialog nobody asked for is not what "import my logins" means. The
 * caller finds out it did not work when nothing decrypts.
 */
export async function chromiumPassword(app: string): Promise<Buffer> {
  for (const attrs of keyringAsks(app)) {
    const got = await keyringPassword(attrs);
    if (got?.length) return got;
  }
  return Buffer.from(NO_KEYRING_PASSWORD, "utf8");
}

export function deriveKey(password: Buffer): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

const IV = Buffer.alloc(16, 0x20);
/** Anything in here means the bytes are not a cookie value. Tab, newline and
 *  carriage return are deliberately absent: a cookie may legitimately hold
 *  none of them, but rejecting on them would be stricter than Chrome. */
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]');

/**
 * One value, decrypted.
 *
 * The subtlety is the last step. From Chrome 130 the plaintext is not the
 * value: it is a 32-byte SHA-256 of the host, and then the value. Nothing in
 * the row says which layout a given cookie uses — a jar written across an
 * upgrade holds both — so this decides by looking: whichever reading is clean
 * text wins, and the hashed one is tried second so a short value that happens
 * to survive slicing cannot win by accident.
 *
 * Null rather than a wrong string when neither reading is clean. A cookie
 * quietly imported as mojibake is a login that fails later for no visible
 * reason.
 */
export function decryptValue(encrypted: Uint8Array | Buffer, key: Buffer): string | null {
  const buf = Buffer.from(encrypted);
  if (buf.length <= 3) return "";
  const scheme = schemeOf(buf);
  if (scheme === "other") return null;
  let out: Buffer;
  try {
    const d = createDecipheriv("aes-128-cbc", key, IV);
    // Chrome's padding is PKCS#7, but a wrong key produces a wrong final byte
    // and node would throw on it. Stripping it here turns "wrong key" into
    // "unclean text", which is a decision this can make rather than a crash.
    d.setAutoPadding(false);
    out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  } catch {
    return null;
  }
  const pad = out[out.length - 1] ?? 0;
  if (pad >= 1 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);

  const plain = out.toString("utf8");
  if (plain.length && !CONTROL.test(plain)) return plain;
  const past = out.subarray(32).toString("utf8");
  if (out.length > 32 && !CONTROL.test(past)) return past;
  // An empty value is a real cookie, and only after both readings failed can
  // an empty result be told apart from a failed one.
  return out.length === 0 ? "" : null;
}

/** Chromium keeps its expiry in microseconds since 1601 — the Windows epoch,
 *  in a browser that has not needed it for a decade. Zero means a session
 *  cookie and must stay zero rather than becoming 1601. */
export function chromeEpochSeconds(micros: number): number {
  if (!micros) return 0;
  return Math.floor(micros / 1_000_000) - 11_644_473_600;
}

export interface ChromiumRead {
  rows: CookieRow[];
  /** How many values would not decrypt. Non-zero with a non-zero `rows` means
   *  the key was wrong for part of the jar, which is worth saying out loud. */
  failed: number;
}

/**
 * Every cookie in one profile, decrypted.
 *
 * `snapshot` is the caller's job: this takes a path it may open read-only
 * without racing the browser.
 */
export function readChromium(dbPath: string, key: Buffer): ChromiumRead {
  const conn = new Database(dbPath, { readonly: true });
  try {
    const raw = conn.query<{
      host_key: string; name: string; encrypted_value: Uint8Array; value: string;
      path: string; expires_utc: number; is_secure: number; is_httponly: number;
      samesite: number; top_frame_site_key: string;
    }, []>(
      `SELECT host_key, name, encrypted_value, value, path, expires_utc,
              is_secure, is_httponly, samesite, top_frame_site_key
         FROM cookies`,
    ).all();

    const rows: CookieRow[] = [];
    let failed = 0;
    for (const r of raw) {
      // A row may be in the clear — Chromium leaves the value alone when it
      // has nothing to encrypt with.
      const enc = r.encrypted_value ?? new Uint8Array();
      const value = enc.length > 3 ? decryptValue(enc, key) : (r.value ?? "");
      if (value === null) { failed += 1; continue; }
      rows.push({
        host: String(r.host_key ?? ""),
        name: String(r.name ?? ""),
        value,
        path: String(r.path ?? "/"),
        expires: chromeEpochSeconds(Number(r.expires_utc ?? 0)),
        secure: Number(r.is_secure ?? 0) === 1,
        httpOnly: Number(r.is_httponly ?? 0) === 1,
        // Chromium: 0 none, 1 lax, 2 strict, -1 unspecified. Firefox's numbers
        // differ, and planImport is told which browser it is looking at.
        sameSite: Number(r.samesite ?? -1),
        partition: String(r.top_frame_site_key ?? "") || undefined,
      });
    }
    return { rows, failed };
  } finally {
    conn.close();
  }
}
