/*
 * The phone's half of the pairing handshake, against the computer's real one.
 *
 * `sealTo` is imported from the server rather than reimplemented here, so this
 * is not two of my own functions agreeing with each other — it is the code that
 * actually runs on the desk, sealing a credential that the code that actually
 * runs on the phone then opens. If either side changes a curve, a salt, an info
 * string or a cipher, this goes red on the next run.
 *
 * That matters more than usual because the phone's half is written in pure
 * JavaScript on purpose: the browser companion uses `crypto.subtle`, which does
 * not exist on a page served over plain HTTP, which is why a phone cannot pair
 * over a LAN address today. The whole point of this file is that the
 * replacement is exactly equivalent — so "exactly" is what gets asserted.
 */
import { describe, expect, test } from "bun:test";
import { sealTo, INFO as SERVER_INFO, validPub } from "../../server/src/pairing.ts";
import { announce, installed, pairing } from "./npm-deps.ts";

announce("pairing.test.ts");

const { INFO, makeKeys, normalizeOrigin, readPairingCode, unseal } = pairing;
import { b64urlDecode, b64urlEncode } from "../src/lib/b64.ts";

describe.skipIf(!installed)("a credential sealed by the computer, opened by the phone", () => {
  test("round-trips a real device token", () => {
    const ticket = "Ux9-mQ2bK1pA";
    const token = "dev_5f3c9a1e88b24d0f_a-real-looking-device-token";
    const keys = makeKeys();

    expect(unseal(sealTo(keys.pub, ticket, token), keys.priv, ticket)).toBe(token);
  });

  test("the key it generates is the shape the server insists on", () => {
    // 65 bytes starting 0x04 — an uncompressed point. The server rejects
    // anything else BEFORE comparing the six digits, so a wrong shape here
    // fails as "shape" at claim time rather than as a decrypt error later.
    const { pub } = makeKeys();
    const raw = b64urlDecode(pub);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(validPub(pub)).toBe(true);
  });

  test("another device's key does not open it", () => {
    // The control. Without it a round-trip only proves the two halves agree,
    // not that the sealing is doing anything at all.
    const ticket = "Ux9-mQ2bK1pA";
    const mine = makeKeys();
    const theirs = makeKeys();
    const sealed = sealTo(mine.pub, ticket, "a-token");

    expect(() => unseal(sealed, theirs.priv, ticket)).toThrow();
  });

  test("the ticket id is load-bearing, not decoration", () => {
    // It is the HKDF salt, so two pairings between the same pair of keys never
    // derive the same content key.
    const mine = makeKeys();
    const sealed = sealTo(mine.pub, "ticket-one", "a-token");

    expect(() => unseal(sealed, mine.priv, "ticket-two")).toThrow();
  });

  test("both sides pin the same protocol string", () => {
    expect(INFO).toBe(SERVER_INFO);
  });
});

describe.skipIf(!installed)("base64url", () => {
  test("known vectors, both ways", () => {
    const cases: [number[], string][] = [
      [[], ""],
      [[0x66], "Zg"],
      [[0x66, 0x6f], "Zm8"],
      [[0x66, 0x6f, 0x6f], "Zm9v"],
      [[0xff, 0xef, 0xfe], "_-_-"], // the two digits base64url spells differently
    ];
    for (const [bytes, text] of cases) {
      expect(b64urlEncode(new Uint8Array(bytes))).toBe(text);
      expect([...b64urlDecode(text)]).toEqual(bytes);
    }
  });

  test("round-trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect([...b64urlDecode(b64urlEncode(all))]).toEqual([...all]);
  });

  test("tolerates padding, because a URL parameter may bring it back", () => {
    expect([...b64urlDecode("Zm8=")]).toEqual([0x66, 0x6f]);
    expect([...b64urlDecode("Zg==")]).toEqual([0x66]);
  });

  test("refuses a character it does not know instead of dropping it", () => {
    /*
     * The failure this prevents: a decoder that skips what it cannot read
     * returns a value of the right length and the wrong content, and the error
     * surfaces three steps later as a credential that does not decrypt.
     */
    expect(() => b64urlDecode("Zm8*")).toThrow();
    expect(() => b64urlDecode("Zm 8")).toThrow();
    expect(() => b64urlDecode("Z")).toThrow();
  });
});

describe.skipIf(!installed)("what the camera read", () => {
  test("takes the ticket out of the URL the Remote pane draws", () => {
    expect(readPairingCode("http://192.168.1.20:4000/?pair=Ux9-mQ2bK1pA")).toEqual({
      ticket: "Ux9-mQ2bK1pA",
      origin: "http://192.168.1.20:4000",
    });
  });

  test("accepts a bare ticket, for when somebody reads it out", () => {
    expect(readPairingCode("  Ux9-mQ2bK1pA ")).toEqual({ ticket: "Ux9-mQ2bK1pA" });
  });

  test("says no to a QR that is not ours", () => {
    // A phone's camera points at whatever is in front of it, so this is the
    // common case rather than an attack: a wifi code, a URL with no ticket.
    for (const junk of ["", "https://example.com/", "WIFI:S:home;T:WPA;P:hunter2;;", "hello world"]) {
      expect(readPairingCode(junk), junk).toBeNull();
    }
  });
});

describe.skipIf(!installed)("the address somebody typed", () => {
  test("fills in what they left out", () => {
    // The port is the field people get wrong, and http is right here: this
    // server speaks plain HTTP on a LAN, and guessing https produces a TLS
    // error that reads like the computer is switched off.
    expect(normalizeOrigin("192.168.1.20")).toBe("http://192.168.1.20:4000");
    expect(normalizeOrigin("192.168.1.20:4000")).toBe("http://192.168.1.20:4000");
    expect(normalizeOrigin(" http://192.168.1.20:4000/ ")).toBe("http://192.168.1.20:4000");
    expect(normalizeOrigin("100.64.0.1:4000")).toBe("http://100.64.0.1:4000");
  });

  test("leaves an explicit https alone, port and all", () => {
    expect(normalizeOrigin("https://box.tail1234.ts.net")).toBe("https://box.tail1234.ts.net");
    expect(normalizeOrigin("https://box.tail1234.ts.net:8443")).toBe("https://box.tail1234.ts.net:8443");
  });

  test("answers null for nothing usable", () => {
    for (const bad of ["", "   ", "://", "http://"]) {
      expect(normalizeOrigin(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
