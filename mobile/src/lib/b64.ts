/*
 * base64url, by hand.
 *
 * Everything the phone exchanges with the server during pairing — the public
 * key it generates, the server's ephemeral key, the nonce and the sealed
 * credential — is base64url, because that is what `server/src/pairing.ts`
 * writes and what survives a URL and a QR code without escaping.
 *
 * Node has `Buffer` and a browser has `atob`, and this runtime has neither
 * reliably: Hermes ships `atob`/`btoa` on some versions and not others, and
 * the ones it does ship are the *base64* pair, which mis-decodes the `-` and
 * `_` that base64url uses in place of `+` and `/`. Feeding those to a decoder
 * that does not know them does not throw — it silently produces the wrong
 * bytes, and the failure surfaces four steps later as a credential that does
 * not decrypt. So this is written out, and tested against known vectors.
 *
 * Padding is emitted on encode (the server's `Buffer.from(x, "base64url")`
 * accepts it either way) and tolerated on decode, because a value that has
 * been through a URL parameter may arrive with `=` percent-decoded back in.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reverse table, built once. -1 for anything that is not a base64url digit. */
const VALUE: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  // The base64 spellings of the last two digits, accepted on decode so a value
  // that took a detour through a standard-base64 encoder still reads.
  t["+".charCodeAt(0)] = 62;
  t["/".charCodeAt(0)] = 63;
  return t;
})();

/** Bytes → base64url, without padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! +
      ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]!;
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

/**
 * base64url → bytes.
 *
 * Throws on a character that is not in the alphabet rather than skipping it.
 * Every caller here is handling a key or a ciphertext, and a decoder that
 * quietly drops the byte it did not understand hands the next function a value
 * that is the right *shape* and the wrong *content* — which is exactly the
 * failure that has no useful error message anywhere downstream.
 */
export function b64urlDecode(text: string): Uint8Array {
  let clean = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "=" || c === "\n" || c === "\r") continue;
    const code = text.charCodeAt(i);
    if (code > 127 || VALUE[code] === -1) throw new Error(`not base64url: ${JSON.stringify(c)}`);
    clean += c;
  }
  // 1 leftover character cannot be the tail of any byte: 4 chars carry 3 bytes,
  // 3 carry 2, 2 carry 1, and 1 carries none.
  if (clean.length % 4 === 1) throw new Error("not base64url: truncated");

  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | VALUE[clean.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Standard base64, for the one thing that is not base64url: terminal bytes.
 *
 * A PTY frame is raw bytes and it cannot be decoded as text on the way through
 * — a multi-byte character split across two frames comes back as two
 * replacement characters, permanently, and half the box-drawing in a TUI is
 * exactly that. So the bytes cross into the WebView base64-encoded and are
 * turned back into a Uint8Array there by `atob`, which speaks this alphabet and
 * not the URL-safe one.
 */
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += STD[(n >>> 18) & 63]! + STD[(n >>> 12) & 63]! + STD[(n >>> 6) & 63]! + STD[n & 63]!;
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out += STD[(n >>> 18) & 63]! + STD[(n >>> 12) & 63]! + "==";
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += STD[(n >>> 18) & 63]! + STD[(n >>> 12) & 63]! + STD[(n >>> 6) & 63]! + "=";
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text);
export const utf8Text = (bytes: Uint8Array): string => decoder.decode(bytes);
