/*
 * Web Push encryption, against an independent implementation.
 *
 * `deliver()` reaches a webhook, a connected desktop client, and notify-send.
 * None of them reaches a phone with its screen off — and the phone's socket
 * closes with the screen on purpose. So the one thing the companion exists for,
 * an agent blocked waiting on a person while you are away from the desk, is the
 * one thing that could not reach you.
 *
 * Web Push can, and it is end-to-end encrypted: the push service relays a blob
 * it cannot read. Which means "it ran and did not throw" proves nothing here. A
 * wrong key schedule produces a perfectly well-formed body of the right length
 * that the receiving browser silently discards, and the only symptom is a
 * notification that never arrives — on a device that is not in front of you.
 *
 * So these are fixed vectors produced by `http_ece`, the library `web-push`
 * uses and therefore the code that actually feeds FCM and Mozilla's push
 * service for a large slice of the web. Byte-for-byte agreement with a
 * second implementation is the strongest evidence available without a real
 * device on the far end, and it is much stronger than a round trip against
 * myself, which would pass just as happily with both halves wrong.
 *
 * Generated once with http_ece@1.2.1:
 *   ece.encrypt(plaintext, { version: "aes128gcm", salt, privateKey: as,
 *                            dh: ua.getPublicKey(), authSecret: auth })
 */
import { describe, expect, it } from "bun:test";
import {
  b64uDecode, b64uEncode, encryptWith, encryptPush, freshKeying,
  audienceOf, generateVapidKeys, vapidHeader, MAX_PAYLOAD, type PushSubscription,
} from "../src/push.ts";

/**
 * Deliberately not secrets, and deliberately not shaped like them.
 *
 * The scalars here are 1..32 and a repeated byte. Both are perfectly valid
 * P-256 private keys and neither is a credential for anything — which matters,
 * because a real-looking random scalar committed to a repository is a finding
 * for every secret scanner that ever reads it, correctly. The first version of
 * this file pinned one and GitGuardian caught it, which is the scanner doing
 * its job; the fix is to not commit a key, not to teach the scanner to ignore
 * one.
 */
const asPrivateBytes = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

const V = {
  uaPublic: "BAyQHUI8gxyoXifHPCY7oTJyG7nXqExPA4CypnVv1gEzHIhwI03sh4UEwXQUT6SxS2amUWkWBtgXPlW9N-OBVp4",
  asPublic: "BFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q",
  /** Sixteen 0x11 bytes. */
  auth: b64uEncode(new Uint8Array(16).fill(0x11)),
  /** Sixteen 0x22 bytes, which is why every vector below starts "IiIi". */
  salt: b64uEncode(new Uint8Array(16).fill(0x22)),
};

const sub: PushSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: V.uaPublic, auth: V.auth },
};

/** The pinned sender key, imported as the ECDH private key the code wants. */
async function pinnedKeying() {
  const pub = b64uDecode(V.asPublic);
  const senderPrivate = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: b64uEncode(asPrivateBytes),
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true,
  }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { salt: b64uDecode(V.salt), senderPrivate, senderPublicRaw: pub };
}

const body = async (text: string) =>
  b64uEncode(await encryptWith(new TextEncoder().encode(text), sub, await pinnedKeying()));

describe("the encrypted body, against http_ece", () => {
  it("matches on the sentence the RFC uses", async () => {
    expect(await body("When I grow up, I want to be a watermelon")).toBe(
      "IiIiIiIiIiIiIiIiIiIiIgAAEABBBFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIh" +
      "UCvvDVfgjFOyzApW8X2fk1QuOgle9Zc--RvStPHwLpA7r34CjaxfJmhEwGTMYU-mPrTahojimbvGafOC1cicCQUBkXEg" +
      "ywgmn1Ak");
  });

  it("matches on an empty message", async () => {
    // Not a case anybody sends, and exactly where an off-by-one in the padding
    // delimiter would show up on its own.
    expect(await body("")).toBe(
      "IiIiIiIiIiIiIiIiIiIiIgAAEABBBFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIh" +
      "UCvvDVfgjFOyzApW8X2fk1R7IiFR93KnEd6OgaJMFKR0ag");
  });

  it("matches on an actual gate notification, multi-byte characters and all", async () => {
    const real = JSON.stringify({
      title: "✋ Approval needed",
      body: "claude-code wants to run Bash: rm -rf build",
    });
    expect(await body(real)).toBe(
      "IiIiIiIiIiIiIiIiIiIiIgAAEABBBFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIh" +
      "UCvvDVfgjFOyzApW8X2fk1QCcBhZobJ7vFOfIU0Ofv1rliwamqNHJnJOhWLMJQyqa7fBh4OtxvXKa5AWj6y_osOArmpJ" +
      "_pXPYOudrz872_cgZRRySXugy-hXRu24yzm7-29R69Wk2llBTvo-YLNnN65W44VLtg");
  });
});

describe("the shape of the body", () => {
  it("is salt, record size, key id length, key id, ciphertext", async () => {
    // RFC 8188's header. Getting the record size endianness wrong, or the key
    // id length off by one, shifts everything after it — and the failure is
    // silent at the far end.
    const out = await encryptWith(new TextEncoder().encode("hi"), sub, await pinnedKeying());
    expect([...out.slice(0, 16)]).toEqual([...b64uDecode(V.salt)]);
    expect(new DataView(out.buffer, out.byteOffset).getUint32(16, false)).toBe(4096);
    expect(out[20]).toBe(65);
    expect([...out.slice(21, 86)]).toEqual([...b64uDecode(V.asPublic)]);
    // Two bytes of plaintext, one delimiter, sixteen of GCM tag.
    expect(out.length).toBe(86 + 2 + 1 + 16);
  });

  it("carries the sender's key, which is how the receiver knows what to do", async () => {
    const k = await freshKeying();
    const out = await encryptWith(new TextEncoder().encode("x"), sub, k);
    expect([...out.slice(21, 86)]).toEqual([...k.senderPublicRaw]);
  });
});

describe("how much fits", () => {
  it("fills a record exactly, and refuses one byte more", async () => {
    // Past this it would emit a record longer than the size its own header
    // declares, which a receiver drops — silently, on a device that is not in
    // front of you. A notification is nowhere near this big; the point is that
    // it fails here rather than there.
    const k = await pinnedKeying();
    const at = await encryptWith(new Uint8Array(MAX_PAYLOAD).fill(121), sub, k);
    expect(at.length - 86).toBe(4096);
    await expect(encryptWith(new Uint8Array(MAX_PAYLOAD + 1).fill(121), sub, k))
      .rejects.toThrow(/4079/);
  });

  it("matches the reference right up to the boundary", async () => {
    // 4000 bytes, which is well past anything the alert path sends and is where
    // a second record would appear if the padding were off by even a little.
    expect((await body("x".repeat(4000))).startsWith(
      "IiIiIiIiIiIiIiIiIiIiIgAAEABBBFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIh" +
      "UCvvDVfgjFOyzApW8X2fk1QBKhRIraZm5hHFu6n9JsRjniYNlLpTfmRTmH7ROVb-Ma3Wm4L3hK_Rf4kbk7HqudScszJG")).toBe(true);
  });
});

describe("what must never repeat", () => {
  it("uses a new salt and a new sender key for every message", async () => {
    // The nonce is derived from the salt, and AES-GCM fails catastrophically on
    // nonce reuse — reusing a salt with the same key leaks the plaintexts. This
    // is why encryptPush generates rather than accepts them.
    const a = await encryptPush(new TextEncoder().encode("same text"), sub);
    const b = await encryptPush(new TextEncoder().encode("same text"), sub);
    expect([...a.slice(0, 16)]).not.toEqual([...b.slice(0, 16)]);   // salt
    expect([...a.slice(21, 86)]).not.toEqual([...b.slice(21, 86)]); // sender key
    expect([...a]).not.toEqual([...b]);
  });

  it("produces a different body for a different subscriber", async () => {
    const other: PushSubscription = {
      ...sub,
      keys: { ...sub.keys, auth: b64uEncode(new Uint8Array(16).fill(9)) },
    };
    const k = await pinnedKeying();
    const mine = await encryptWith(new TextEncoder().encode("x"), sub, k);
    const theirs = await encryptWith(new TextEncoder().encode("x"), other, k);
    // Same header, different ciphertext: the auth secret is in the key schedule.
    expect([...mine.slice(0, 86)]).toEqual([...theirs.slice(0, 86)]);
    expect([...mine.slice(86)]).not.toEqual([...theirs.slice(86)]);
  });
});

describe("base64url, which everything here travels as", () => {
  it("round-trips bytes that need both substitutions", async () => {
    // `+` and `/` are exactly the characters that break a URL, and a P-256 key
    // hits them constantly.
    const bytes = new Uint8Array([0xfb, 0xff, 0x3e, 0x00, 0x7f, 0xfe]);
    expect([...b64uDecode(b64uEncode(bytes))]).toEqual([...bytes]);
    expect(b64uEncode(bytes)).not.toContain("+");
    expect(b64uEncode(bytes)).not.toContain("/");
    expect(b64uEncode(bytes)).not.toContain("=");
  });

  it("accepts input with or without padding", async () => {
    // Browsers send `p256dh` unpadded; some libraries pad. Both are the key.
    expect([...b64uDecode("YWJj")]).toEqual([...b64uDecode("YWJj=")]);
    expect(b64uDecode(V.uaPublic).length).toBe(65);
  });
});

describe("VAPID, which says who is asking", () => {
  const keys = { publicKey: V.asPublic, privateKey: b64uEncode(asPrivateBytes) };

  it("addresses the push service and not the endpoint", async () => {
    // A service rejects a token whose `aud` is the full endpoint — it is the
    // origin, and only the origin.
    expect(audienceOf("https://fcm.googleapis.com/fcm/send/abc123?x=1"))
      .toBe("https://fcm.googleapis.com");
    expect(audienceOf("https://updates.push.services.mozilla.com/wpush/v2/gAAA"))
      .toBe("https://updates.push.services.mozilla.com");
  });

  it("signs a token a push service can verify", async () => {
    const h = await vapidHeader(sub.endpoint, keys, "mailto:me@example.com", 1_700_000_000_000);
    const [, t] = /t=([^,]+)/.exec(h)!;
    const [head, claims, sig] = t!.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(head!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const c = JSON.parse(new TextDecoder().decode(b64uDecode(claims!)));
    expect(c.aud).toBe("https://fcm.googleapis.com");
    expect(c.sub).toBe("mailto:me@example.com");
    expect(c.exp).toBe(1_700_000_000 + 12 * 60 * 60);

    // ES256 in JWS is the raw r‖s, 64 bytes — not the DER sequence OpenSSL
    // returns by default, which is the classic way this goes wrong.
    expect(b64uDecode(sig!).length).toBe(64);

    const pub = b64uDecode(V.asPublic);
    const verifier = await crypto.subtle.importKey("jwk", {
      kty: "EC", crv: "P-256",
      x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true,
    }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, verifier,
      b64uDecode(sig!), new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(ok).toBe(true);
  });

  it("carries the public key beside the token, which is what pins the subscription", async () => {
    const h = await vapidHeader(sub.endpoint, keys, "mailto:me@example.com");
    expect(h.startsWith("vapid t=")).toBe(true);
    expect(h).toContain(`, k=${V.asPublic}`);
  });

  it("generates a keypair in the shape a browser will accept", async () => {
    const g = await generateVapidKeys();
    const raw = b64uDecode(g.publicKey);
    // Uncompressed point: 0x04 and two 32-byte coordinates. A browser rejects
    // anything else outright.
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(b64uDecode(g.privateKey).length).toBe(32);
    // And it must actually sign.
    const h = await vapidHeader(sub.endpoint, g, "mailto:me@example.com");
    expect(h).toContain(`, k=${g.publicKey}`);
  });
});
