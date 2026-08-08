/*
 * Adding this phone to a computer, from a runtime with no WebCrypto.
 *
 * The handshake is the one `server/src/pairing.ts` already speaks, and nothing
 * on the server moves for this file. The phone scans a QR that carries a
 * *ticket id* — worth nothing on its own — types the six digits shown on the
 * computer's screen, and somebody at the computer accepts. Only then does a
 * credential exist, and it arrives sealed to a key that was generated here and
 * never left.
 *
 * Why this file exists at all: in the browser every step below is
 * `crypto.subtle`, which does not exist outside a secure context. A phone
 * opening `http://192.168.1.20:4000` from a QR code therefore has no WebCrypto
 * and cannot pair — `web/src/lib/pairing.ts` detects exactly that and tells you
 * to go and set up TLS. That is the single biggest thing the native app buys:
 * @noble is pure JavaScript, so P-256 works on Hermes over plain HTTP, and
 * pairing on your own wifi stops needing a certificate.
 *
 * The parameters are not a choice — they have to match the server byte for
 * byte: ECDH over P-256, HKDF-SHA256 with the ticket id as salt and
 * "agentglass-pair-v1" as info, AES-256-GCM. GCM's tag means a mismatch throws
 * instead of returning plausible rubbish, which is the behaviour worth having
 * when the alternative is storing a corrupt token and failing later as a 401
 * that points nowhere.
 */
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { b64urlDecode, b64urlEncode, utf8Bytes, utf8Text } from "./b64.ts";

/** Pins the derived key to this protocol. Must equal `INFO` in server/src/pairing.ts. */
export const INFO = "agentglass-pair-v1";

export interface PairKeys {
  /** Uncompressed P-256 point, base64url. Safe to send; it is a public key. */
  pub: string;
  /** The only thing that can open the credential. Never leaves this device. */
  priv: Uint8Array;
}

/** What the server sealed, as it comes back from `/pair/collect`. */
export interface Sealed {
  pub: string;
  iv: string;
  data: string;
}

/**
 * A keypair for one pairing, and one pairing only.
 *
 * The public key is exported uncompressed (0x04 ‖ X ‖ Y, 65 bytes) because
 * that is the only shape the server's `validPub` accepts, and it is the same
 * shape WebCrypto's `exportKey("raw")` produces — so the desktop cannot tell
 * which client it is talking to, which is the point.
 */
export function makeKeys(): PairKeys {
  const priv = p256.utils.randomSecretKey();
  return { pub: b64urlEncode(p256.getPublicKey(priv, false)), priv };
}

/**
 * Open what the computer sealed for this device.
 *
 * The one thing here that is easy to get wrong and impossible to debug from
 * the symptom: `getSharedSecret` answers a compressed *point*, while the ECDH
 * secret the server computed is the x-coordinate alone. Keeping the leading
 * byte derives a different key of the right length, and AES-GCM's only comment
 * on that is that the tag did not verify.
 */
export function unseal(sealed: Sealed, priv: Uint8Array, ticketId: string): string {
  const point = p256.getSharedSecret(priv, b64urlDecode(sealed.pub));
  const key = hkdf(sha256, point.slice(1), utf8Bytes(ticketId), utf8Bytes(INFO), 32);
  return utf8Text(gcm(key, b64urlDecode(sealed.iv)).decrypt(b64urlDecode(sealed.data)));
}

/**
 * The ticket id out of whatever arrived — a scan, or a paste.
 *
 * The QR the Remote pane draws is a plain URL — `http://host:4000/?pair=<id>` —
 * so the same text works whether it arrives through a camera or through a
 * browser. Both the `pair` parameter and a bare id are accepted, because "scan
 * it" and "read the six characters out loud" should not be different features.
 *
 * What that URL opens in a browser is the COCKPIT — terminal, git write,
 * docker — and not a read-mostly companion. The companion was deleted in
 * 86b07f7, whose own message says the quiet part: "a device pairing over the
 * network now lands on the cockpit … it is a change in what a QR opens".
 * Worth stating here rather than three files away, because this and pair.tsx
 * are what somebody opens when they change what a pairing grants.
 *
 * And a browser at that URL cannot pair AT ALL, which is why this file exists:
 * `crypto.subtle` is secure-context only, so a page served from
 * `http://192.168.1.20:4000` has no WebCrypto and the handshake cannot start.
 * The link is not a fallback for a phone without the app.
 *
 * Returns the origin too when the text carried one: that is the address the
 * phone should talk to, and it is the field people get wrong by hand. Only the
 * camera ever called this, so pasting the same URL into the form did nothing at
 * all and left an address *and* twelve characters to type against a two-minute
 * clock — three attempts and two expiries, watched, the first time somebody
 * paired from outside the flat.
 *
 * A missing scheme is accepted when the text carries a `pair` parameter,
 * because a link that has been through a chat app, a note or somebody reading
 * it out loses `http://` long before it loses the query string.
 */
export function readPairingCode(scanned: string): { ticket: string; origin?: string } | null {
  const text = scanned.trim();
  if (!text) return null;

  const hasScheme = /^https?:\/\//i.test(text);
  if (hasScheme || /[?&]pair=/i.test(text)) {
    let url: URL;
    try { url = new URL(hasScheme ? text : `http://${text}`); } catch { return null; }
    const ticket = url.searchParams.get("pair");
    if (!ticket) return null;
    // Through the normaliser rather than straight from `url.origin`: a link
    // whose scheme was reconstructed above has no port either, and `:4000` is
    // the difference between the computer and whatever answers port 80.
    return { ticket, origin: normalizeOrigin(url.origin) ?? url.origin };
  }

  // A bare ticket id: base64url of 9 random bytes, so 12 characters.
  return /^[A-Za-z0-9_-]{6,64}$/.test(text) ? { ticket: text } : null;
}

/** Mirrors `TICKET_TTL_MS` in server/src/pairing.ts, which cannot be imported
 *  here — that module is node:crypto all the way down. `pair-paste.test.ts`
 *  holds the two equal. */
export const TICKET_TTL_MS = 120_000;

/**
 * How long a ticket has left, in a span rather than in an instant.
 *
 * The server hands out `expiresAt` as *its* wall clock. Subtracting the phone's
 * `Date.now()` from it is only right if the two clocks agree, and nothing makes
 * them: they are set by different sources, and a phone an hour out would draw a
 * live invitation as long dead — the one thing this countdown exists to stop it
 * doing. The `Date` header on the same response is the computer saying what
 * time *it* thinks it is, so the difference of the two is a duration, which
 * survives any skew.
 *
 * Not visible on the emulator, which sits within 135ms of the host it runs on —
 * measured. That is why the correction is written rather than eyeballed.
 *
 * Clamped to the ticket's own lifetime: a span longer than the TTL can only
 * come from a `Date` this runtime failed to parse, and a countdown starting at
 * nine hours is worse than one that starts at two minutes.
 */
export function leftOnTicket(expiresAt: number, serverDate: string | null, now = Date.now()): number {
  const theirs = serverDate ? Date.parse(serverDate) : NaN;
  const base = Number.isFinite(theirs) ? theirs : now;
  return Math.min(TICKET_TTL_MS, Math.max(0, expiresAt - base));
}

/** `1:47`. Seconds are rounded up so the last live second reads 0:01 and only
 *  an expired ticket ever reads 0:00. */
export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Normalise what somebody typed into the address field.
 *
 * People type `192.168.1.20:4000`, `http://192.168.1.20:4000/` and
 * `192.168.1.20` — all three mean the same computer, and only the first is
 * ambiguous about the scheme. Defaulting to `http` is right here: this server
 * speaks plain HTTP on a LAN, and a phone that guesses `https` gets a TLS
 * error that reads like the computer is switched off.
 */
export function normalizeOrigin(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  // Scheme first, and no tidying before it. Trimming trailing slashes up front
  // turned "http://" into "http:", which then failed the scheme test and was
  // read as the HOST "http" — an address that resolves to nothing, reported as
  // if it were fine. `url.origin` has no trailing slash to remove anyway.
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return null; }
  if (!url.hostname) return null;
  const needsDefaultPort = !url.port && url.protocol === "http:";
  return needsDefaultPort ? `${url.origin}:4000` : url.origin;
}
