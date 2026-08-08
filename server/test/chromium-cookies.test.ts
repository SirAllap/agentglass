/*
 * Decrypting a Chrome-family cookie jar.
 *
 * The importer refused this browser for a year, saying the key was held by the
 * desktop keyring and there was "no way for this to ask for it". The first half
 * is true; the second was wrong, and the whole of this file is the second half
 * being wrong.
 *
 * The scheme is fixed and public: PBKDF2-HMAC-SHA1 over a keyring password with
 * the salt "saltysalt" and ONE iteration, then AES-128-CBC with an IV of
 * sixteen spaces. One iteration is not a bug here — it is what Chrome does, and
 * the secret is the keyring rather than the derivation.
 *
 * Every cipher test below encrypts with the same scheme first, so what is
 * checked is the round trip rather than a fixture nobody can re-derive.
 */
import { describe, expect, it } from "bun:test";
import { createCipheriv, pbkdf2Sync, createHash } from "node:crypto";
import {
  chromeEpochSeconds, decryptValue, deriveKey, keyringAsks, NO_KEYRING_PASSWORD, schemeOf,
} from "../src/chromiumcookies.ts";

const key = deriveKey(Buffer.from("a real keyring password"));
const IV = Buffer.alloc(16, 0x20);

/** Encrypt the way Chrome does, so the tests exercise a round trip. */
function seal(plain: Buffer | string, prefix = "v11"): Buffer {
  const c = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([Buffer.from(prefix, "latin1"), c.update(Buffer.from(plain)), c.final()]);
}

/** Chrome 130+ puts a SHA-256 of the host in front of the value. */
const withHostHash = (host: string, value: string) =>
  Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);

describe("which scheme a value is in", () => {
  it("reads the three-byte prefix", () => {
    expect(schemeOf(Buffer.from("v10abc"))).toBe("v10");
    expect(schemeOf(Buffer.from("v11abc"))).toBe("v11");
    expect(schemeOf(Buffer.from("xyzabc"))).toBe("other");
  });

  it("calls an empty value other rather than crashing", () => {
    expect(schemeOf(new Uint8Array())).toBe("other");
  });
});

describe("decrypting", () => {
  it("returns the value for a plain one", () => {
    expect(decryptValue(seal("session=abc123"), key)).toBe("session=abc123");
  });

  it("strips the host hash Chrome 130 puts in front", () => {
    // Without this, every modern cookie imports with 32 bytes of binary welded
    // to the front and every login built on one silently fails.
    expect(decryptValue(seal(withHostHash(".github.com", "gh_sess=xyz")), key)).toBe("gh_sess=xyz");
  });

  it("handles both layouts in the same jar", () => {
    // A profile written across a Chrome upgrade holds both, and nothing in the
    // row says which is which.
    expect(decryptValue(seal("old=1"), key)).toBe("old=1");
    expect(decryptValue(seal(withHostHash("a.test", "new=2")), key)).toBe("new=2");
  });

  it("prefers the unhashed reading, so a long value is not sliced by accident", () => {
    const long = "x".repeat(90);
    expect(decryptValue(seal(long), key)).toBe(long);
  });

  it("keeps a value that is genuinely empty", () => {
    expect(decryptValue(seal(""), key)).toBe("");
  });

  it("says nothing rather than mojibake when the key is wrong", () => {
    // The failure that matters: a cookie imported as rubbish is a login that
    // fails later for no visible reason, and there is nothing on screen to
    // connect the two.
    const wrong = deriveKey(Buffer.from("not the password"));
    const out = decryptValue(seal("session=abc123"), wrong);
    expect(out).toBeNull();
  });

  it("refuses a prefix it does not know", () => {
    expect(decryptValue(seal("hello", "v20"), key)).toBeNull();
  });

  it("treats a stub too short to hold anything as empty", () => {
    expect(decryptValue(Buffer.from("v11"), key)).toBe("");
    expect(decryptValue(new Uint8Array(), key)).toBe("");
  });

  it("does not throw on bytes that are not a multiple of the block", () => {
    expect(decryptValue(Buffer.concat([Buffer.from("v11"), Buffer.from([1, 2, 3])]), key)).toBeNull();
  });
});

describe("the key", () => {
  it("is the sixteen bytes Chrome derives, one iteration and all", () => {
    const want = pbkdf2Sync(Buffer.from("pw"), "saltysalt", 1, 16, "sha1");
    expect(deriveKey(Buffer.from("pw"))).toEqual(want);
    expect(deriveKey(Buffer.from("pw"))).toHaveLength(16);
  });

  it("has a documented fallback for a machine with no keyring", () => {
    // Not a guess: it is the literal in Chromium's source, and it is why a
    // profile on a headless box still imports.
    expect(NO_KEYRING_PASSWORD).toBe("peanuts");
  });

  it("asks the keyring under every attribute Chromium has used", () => {
    const asks = keyringAsks("brave");
    expect(asks[0]).toEqual({ application: "brave" });
    expect(asks.some((a) => "xdg:schema" in a)).toBe(true);
  });
});

describe("Chromium's clock", () => {
  it("converts from the 1601 epoch it still uses", () => {
    // 13e15 microseconds since 1601 is 2012-12-15T02:26:40Z. The offset is
    // 11_644_473_600 seconds, which is the whole of the conversion.
    expect(chromeEpochSeconds(13_000_000_000_000_000)).toBe(1_355_526_400);
  });

  it("leaves a session cookie at zero rather than sending it to 1601", () => {
    // The bug this prevents: every session cookie imported with an expiry of
    // 1601 is a cookie the browser drops on sight.
    expect(chromeEpochSeconds(0)).toBe(0);
  });

  it("round-trips a time this century", () => {
    const seconds = 1_800_000_000;
    expect(chromeEpochSeconds((seconds + 11_644_473_600) * 1_000_000)).toBe(seconds);
  });
});
