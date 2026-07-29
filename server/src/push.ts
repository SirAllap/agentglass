/**
 * Web Push: the envelope, and only the envelope.
 *
 * `deliver()` in alerts.ts reaches three places — an outgoing webhook, a
 * connected desktop client over the socket, and notify-send. None of them
 * reaches a phone with its screen off, and the phone's socket closes with the
 * screen *on purpose* (a socket reconnecting behind a dark screen is a worse
 * deal than a poll). So the one thing the companion exists for — you walked
 * away, and an agent is now blocked waiting on a person — is the one thing that
 * could not reach you.
 *
 * Web Push is the only mechanism that can, and it is end-to-end encrypted by
 * design: the push service relays a blob it cannot read. That means this file
 * has to get real cryptography exactly right, and "it ran and did not throw" is
 * not evidence of anything — a wrong key schedule produces a perfectly
 * well-formed body that the receiving browser silently discards.
 *
 * So it is verified against a vector produced by `http_ece`, which is the
 * library `web-push` uses and therefore the code that actually feeds FCM and
 * Mozilla's service for a large slice of the web. Byte-for-byte agreement with
 * an independent implementation is the strongest check available without a
 * device on the other end. See server/test/push-encrypt.test.ts.
 *
 * What is NOT here: subscription storage, the routes, the service worker, and
 * the call from `deliver()`. This is the part that is hard to get right and
 * possible to prove; the rest is plumbing and wants a machine where a real
 * phone can confirm it.
 *
 * RFC 8291 (message encryption) over RFC 8188 (aes128gcm content encoding),
 * with RFC 8292 (VAPID) for the authorization header.
 */

const enc = new TextEncoder();

// ── base64url, which is what every value in this protocol travels as ──

export function b64uDecode(s: string): Uint8Array {
  // Padding is stripped before it is re-added. Browsers hand `p256dh` and
  // `auth` over unpadded, but nothing in the spec forbids a client or a proxy
  // from padding them, and appending `=` to a string that already ends in one
  // makes it invalid — a subscription that would simply never work.
  const pad = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64uEncode(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** One HKDF-Extract-and-Expand. WebCrypto does both in `deriveBits`. */
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt, info: info },
    key, bytes * 8,
  );
  return new Uint8Array(bits);
}

/** A subscription, exactly as `PushSubscription.toJSON()` hands it over. */
export interface PushSubscription {
  endpoint: string;
  keys: {
    /** The receiver's ECDH public key, uncompressed P-256, base64url. */
    p256dh: string;
    /** The 16-byte shared authentication secret, base64url. */
    auth: string;
  };
}

/**
 * Everything the encryption needs that is not the message.
 *
 * `salt` and the sender keypair are separate arguments rather than generated
 * inside, only so a test can pin them. Production calls `encryptPush`, which
 * generates both fresh per message — reusing either would be a serious mistake,
 * since the nonce is derived from the salt and AES-GCM fails catastrophically
 * on nonce reuse.
 */
export interface PushKeying {
  salt: Uint8Array;
  senderPrivate: CryptoKey;
  senderPublicRaw: Uint8Array;
}

const RECORD_SIZE = 4096;
/**
 * The most plaintext one record can hold: the record size, less the 16-byte
 * GCM tag, less the one-byte padding delimiter.
 *
 * This writes a single record, which is all a notification needs — and past
 * this it would emit a record longer than the size it declares in its own
 * header, which a receiver drops. Silently, on a device that is not in front of
 * you. Push services refuse payloads over 4096 bytes anyway, so the ceiling is
 * theirs as much as ours; what matters is that going over it fails here, loudly,
 * rather than at the far end, invisibly.
 */
export const MAX_PAYLOAD = RECORD_SIZE - 16 - 1;

/**
 * The body of a Web Push message.
 *
 * The layout is RFC 8188's: salt (16) ‖ record size (4, big-endian) ‖ key id
 * length (1) ‖ key id ‖ ciphertext. For Web Push the key id is the sender's
 * public key, which is how the receiver knows which ECDH to run.
 *
 * The plaintext gets a single 0x02 appended before encryption. That is the
 * padding delimiter for a *final* record — 0x01 means "more records follow",
 * and a receiver that finds the wrong one rejects the message. A single record
 * is all a notification needs.
 */
export async function encryptWith(
  plaintext: Uint8Array, sub: PushSubscription, keying: PushKeying,
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PAYLOAD) {
    throw new Error(`push payload is ${plaintext.length} bytes; one record holds ${MAX_PAYLOAD}`);
  }
  const uaPublicRaw = b64uDecode(sub.keys.p256dh);
  const authSecret = b64uDecode(sub.keys.auth);

  const uaPublic = await crypto.subtle.importKey(
    "raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublic }, keying.senderPrivate, 256,
  ));

  // RFC 8291 §3.4. The order is receiver-then-sender and it is not symmetric:
  // swapping them derives a key the browser will not arrive at, and the only
  // symptom is a notification that never appears.
  const authInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, keying.senderPublicRaw);
  const ikm = await hkdf(shared, authSecret, authInfo, 32);

  const cek = await hkdf(ikm, keying.salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, keying.salt, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, key, padded,
  ));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  return concat(keying.salt, rs, new Uint8Array([keying.senderPublicRaw.length]), keying.senderPublicRaw, ciphertext);
}

/** A fresh salt and a fresh sender keypair, per message. Both must be new every
 *  time — see the note on PushKeying. */
export async function freshKeying(): Promise<PushKeying> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    salt: crypto.getRandomValues(new Uint8Array(16)),
    senderPrivate: pair.privateKey,
    senderPublicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export async function encryptPush(plaintext: Uint8Array, sub: PushSubscription): Promise<Uint8Array> {
  return encryptWith(plaintext, sub, await freshKeying());
}

// ── VAPID (RFC 8292): who is asking the push service to deliver this ──

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url — what the browser is given so
   *  it can pin the subscription to this server. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: jwk.d!,
  };
}

/** The `aud` a push service expects: the scheme and host of the endpoint, and
 *  nothing else. Sending the whole endpoint is rejected. */
export function audienceOf(endpoint: string): string {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}`;
}

/**
 * The `Authorization: vapid t=<jwt>, k=<public key>` header.
 *
 * ES256, which in JWS is the raw 64-byte r‖s — not the DER encoding OpenSSL
 * hands back by default. WebCrypto already produces the raw form, which is why
 * this can be four lines instead of a DER parser.
 */
export async function vapidHeader(
  endpoint: string, keys: VapidKeys, subject: string, now = Date.now(),
): Promise<string> {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud: audienceOf(endpoint),
    // Twelve hours. A push service rejects anything more than 24h out, and a
    // short life is worth little here: the token is sent over TLS to one host.
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signing = `${header}.${claims}`;

  const pub = b64uDecode(keys.publicKey);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: keys.privateKey,
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)),
    ext: true,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signing),
  ));
  return `vapid t=${signing}.${b64uEncode(sig)}, k=${keys.publicKey}`;
}
