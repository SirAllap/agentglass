/*
 * The pairing handshake, at the level where its security properties live.
 *
 * Everything asserted here is a claim the feature makes to the person using
 * it — that a photograph of the screen is not a key, that guessing the code is
 * not feasible, that only the device which typed the code can collect what was
 * granted, and that what it collects cannot be read by anything else on the
 * network. Each of those is a property of this module, so this is where they
 * are pinned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createECDH, hkdfSync, createDecipheriv } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mintTicket, claimTicket, pending, acceptTicket, rejectTicket, collect,
  getTicket, dropTicket, validPub, sealTo, __resetPairing,
  TICKET_TTL_MS, MAX_ATTEMPTS, MAX_TICKETS, INFO,
} from "../src/pairing.ts";
import { deviceFor, activeDevices, __resetDevices } from "../src/devices.ts";

/** A phone's keypair, and the half of the exchange only it can do. */
function phone() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return {
    pub: e.getPublicKey().toString("base64url"),
    open(w: { pub: string; iv: string; data: string }, ticketId: string): string {
      const shared = e.computeSecret(Buffer.from(w.pub, "base64url"));
      const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(ticketId, "utf8"), Buffer.from(INFO, "utf8"), 32));
      const body = Buffer.from(w.data, "base64url");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(w.iv, "base64url"));
      d.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
    },
  };
}

beforeEach(() => {
  // Devices are written to disk; keep every case inside the scratch directory
  // the offLimits() guard in devices.ts allows.
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-pair-"));
  __resetPairing();
  __resetDevices();
});

afterEach(() => { __resetPairing(); });

describe("the invitation", () => {
  test("is a handle, not a credential — nothing in it is the code", () => {
    // The whole reason the QR is safe to point a camera at across a room. If
    // the code were derivable from the id, a photograph would be a pairing.
    const t = mintTicket()!;
    expect(t.id).not.toContain(t.code);
    expect(t.code).toHaveLength(6);
    expect(t.code).toMatch(/^[0-9]{6}$/);
    expect(t.state).toBe("waiting");
  });

  test("keeps its leading zeros, so the length never leaks a digit", () => {
    // A code printed without padding would be six digits nine times in ten and
    // five the tenth, which tells an attacker something before anyone types.
    for (let i = 0; i < 200; i++) {
      __resetPairing();
      expect(mintTicket()!.code).toHaveLength(6);
    }
  });

  test("expires, and is gone the instant it does rather than at the next sweep", () => {
    const t = mintTicket(1_000)!;
    expect(getTicket(t.id, 1_000 + TICKET_TTL_MS - 1)).not.toBeNull();
    expect(getTicket(t.id, 1_000 + TICKET_TTL_MS)).toBeNull();
  });

  test("a claim against an expired invitation fails, however right the code", () => {
    const t = mintTicket(1_000)!;
    const r = claimTicket(t.id, t.code, { pub: phone().pub, now: 1_000 + TICKET_TTL_MS + 1 });
    expect(r).toEqual({ ok: false, error: "unknown" });
  });

  test("several at once are capped, and a request waiting on a person is never the one dropped", () => {
    const live = Array.from({ length: MAX_TICKETS }, () => mintTicket()!);
    // One of them has somebody standing there with a phone.
    expect(claimTicket(live[0]!.id, live[0]!.code, { pub: phone().pub }).ok).toBe(true);
    // The cap recycles an unscanned invitation instead.
    expect(mintTicket()).not.toBeNull();
    expect(getTicket(live[0]!.id)).not.toBeNull();
    // With every slot claimed there is nothing free to recycle, and quietly
    // discarding a pending request would take it off the screen of the person
    // deciding it.
    __resetPairing();
    const all = Array.from({ length: MAX_TICKETS }, () => mintTicket()!);
    for (const t of all) claimTicket(t.id, t.code, { pub: phone().pub });
    expect(mintTicket()).toBeNull();
  });
});

describe("typing the code", () => {
  test("the wrong code is refused and says how many tries are left", () => {
    const t = mintTicket()!;
    expect(claimTicket(t.id, "000000" === t.code ? "111111" : "000000", { pub: phone().pub }))
      .toMatchObject({ ok: false, error: "code", left: MAX_ATTEMPTS - 1 });
  });

  test("running out of guesses kills the invitation rather than just refusing one", () => {
    // A lockout that leaves the target alive is a rate limit. Six digits is a
    // million, and a million requests is minutes — the cap is what makes the
    // short code safe to type.
    const t = mintTicket()!;
    const wrong = t.code === "000000" ? "111111" : "000000";
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(claimTicket(t.id, wrong, { pub: phone().pub })).toMatchObject({ ok: false, error: "code" });
    expect(claimTicket(t.id, wrong, { pub: phone().pub })).toEqual({ ok: false, error: "locked" });
    // Gone: even the right code cannot revive it.
    expect(getTicket(t.id)).toBeNull();
    expect(claimTicket(t.id, t.code, { pub: phone().pub })).toEqual({ ok: false, error: "unknown" });
  });

  test("the second scanner cannot displace the first by guessing faster", () => {
    const t = mintTicket()!;
    expect(claimTicket(t.id, t.code, { pub: phone().pub, label: "iPhone" }).ok).toBe(true);
    expect(claimTicket(t.id, t.code, { pub: phone().pub, label: "not the iPhone" }))
      .toEqual({ ok: false, error: "taken" });
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.label).toBe("iPhone");
  });

  test("a key it cannot deliver to is refused before anyone is asked to decide", () => {
    // Finding out the credential cannot be sealed *after* somebody accepted is
    // a failure at the one point in the flow that cannot be retried.
    const t = mintTicket()!;
    expect(claimTicket(t.id, t.code, { pub: "not-a-key" })).toEqual({ ok: false, error: "shape" });
    expect(claimTicket(t.id, t.code, {})).toEqual({ ok: false, error: "shape" });
    // And a wrong key never cost the person an attempt.
    expect(claimTicket(t.id, t.code, { pub: phone().pub }).ok).toBe(true);
  });

  test("only an uncompressed P-256 point is a key", () => {
    expect(validPub(undefined)).toBe(false);
    expect(validPub("")).toBe(false);
    expect(validPub(Buffer.alloc(65).toString("base64url"))).toBe(false); // leading byte 0x00
    expect(validPub(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(63)]).toString("base64url"))).toBe(false); // short
    expect(validPub(phone().pub)).toBe(true);
  });

  test("what the person sees is who is asking, and the same six digits", () => {
    const t = mintTicket()!;
    claimTicket(t.id, t.code, { pub: phone().pub, label: "Pixel", agent: "Mozilla/5.0 (Linux; Android 14)", ip: "192.168.1.44" });
    expect(pending()[0]).toMatchObject({
      id: t.id, code: t.code, label: "Pixel", ip: "192.168.1.44",
    });
  });

  test("a device with no name still has one", () => {
    const t = mintTicket()!;
    claimTicket(t.id, t.code, { pub: phone().pub, label: "   " });
    expect(pending()[0]!.label).toBe("A device");
  });
});

describe("the decision", () => {
  test("nothing is minted until somebody says yes", () => {
    const t = mintTicket()!;
    claimTicket(t.id, t.code, { pub: phone().pub, label: "iPhone" });
    expect(activeDevices()).toHaveLength(0);
    acceptTicket(t.id, "answer");
    expect(activeDevices()).toHaveLength(1);
  });

  test("accepting mints a credential that works, sealed so only the phone can read it", () => {
    const p = phone();
    const t = mintTicket()!;
    const c = claimTicket(t.id, t.code, { pub: p.pub, label: "iPhone" });
    expect(c.ok).toBe(true);
    expect(acceptTicket(t.id, "answer").ok).toBe(true);

    const got = collect(t.id, (c as { secret: string }).secret);
    expect(got.state).toBe("accepted");
    const w = (got as { wrapped: { pub: string; iv: string; data: string } }).wrapped;

    // The property the whole design rests on: the credential is not on the
    // wire in the clear, so anything on this network with tcpdump gets the
    // ticket, the code and both public keys and still has no key. Asserted by
    // *using* it — a check that the ciphertext merely differs from the token
    // would pass against a server that sent it in plain text under a different
    // encoding.
    const token = p.open(w, t.id);
    const device = deviceFor(token);
    expect(device).not.toBeNull();
    expect(device!.label).toBe("iPhone");
    expect(device!.scope).toBe("answer");

    // …and nothing recoverable is left lying around.
    expect(JSON.stringify(w)).not.toContain(token);
  });

  test("the token never touches disk — what is stored is a hash of it", () => {
    const p = phone();
    const t = mintTicket()!;
    const c = claimTicket(t.id, t.code, { pub: p.pub });
    acceptTicket(t.id, "answer");
    const token = p.open((collect(t.id, (c as { secret: string }).secret) as any).wrapped, t.id);
    // A readable devices.json is not a working key, for the same reason a
    // password file holds hashes.
    expect(JSON.stringify(activeDevices())).not.toContain(token);
  });

  test("the scope granted is the scope the credential has", () => {
    for (const scope of ["read", "answer", "full"] as const) {
      __resetPairing();
      __resetDevices();
      const p = phone();
      const t = mintTicket()!;
      const c = claimTicket(t.id, t.code, { pub: p.pub });
      acceptTicket(t.id, scope);
      const token = p.open((collect(t.id, (c as { secret: string }).secret) as any).wrapped, t.id);
      expect(deviceFor(token)!.scope).toBe(scope);
    }
  });

  test("declining grants nothing and says so, instead of leaving a spinner", () => {
    const t = mintTicket()!;
    const c = claimTicket(t.id, t.code, { pub: phone().pub });
    expect(rejectTicket(t.id)).toBe(true);
    expect(collect(t.id, (c as { secret: string }).secret).state).toBe("rejected");
    expect(activeDevices()).toHaveLength(0);
  });

  test("an invitation nobody claimed cannot be accepted", () => {
    const t = mintTicket()!;
    expect(acceptTicket(t.id, "full")).toEqual({ ok: false, error: "notClaimed" });
    expect(activeDevices()).toHaveLength(0);
  });
});

describe("collecting it", () => {
  test("only the device that typed the code can, even knowing the ticket", () => {
    // The ticket id is in the QR and therefore not a secret. Without this,
    // anything that saw the QR could poll until a credential appeared and take
    // it before the phone did.
    const p = phone();
    const t = mintTicket()!;
    claimTicket(t.id, t.code, { pub: p.pub });
    acceptTicket(t.id, "answer");
    expect(collect(t.id, "").state).toBe("unknown");
    expect(collect(t.id, "a-guess").state).toBe("unknown");
    expect(activeDevices()).toHaveLength(1); // still there, waiting for the right holder
  });

  test("exactly once — a credential two devices can fetch is a credential two devices hold", () => {
    const p = phone();
    const t = mintTicket()!;
    const c = claimTicket(t.id, t.code, { pub: p.pub });
    acceptTicket(t.id, "answer");
    const secret = (c as { secret: string }).secret;
    expect(collect(t.id, secret).state).toBe("accepted");
    expect(collect(t.id, secret).state).toBe("unknown");
  });

  test("says 'still waiting' while a person is deciding, rather than an error", () => {
    const t = mintTicket()!;
    const c = claimTicket(t.id, t.code, { pub: phone().pub });
    expect(collect(t.id, (c as { secret: string }).secret)).toEqual({ state: "claimed" });
  });

  test("a cancelled invitation is gone for the phone too", () => {
    const t = mintTicket()!;
    const c = claimTicket(t.id, t.code, { pub: phone().pub });
    dropTicket(t.id);
    expect(collect(t.id, (c as { secret: string }).secret).state).toBe("unknown");
  });
});

describe("sealTo", () => {
  test("two pairings of the same two keys do not produce the same bytes", () => {
    // The IV is fresh per delivery and the ticket id salts the derivation, so
    // even an identical plaintext to an identical key looks unrelated.
    const p = phone();
    const a = sealTo(p.pub, "ticket-a", "same-token");
    const b = sealTo(p.pub, "ticket-b", "same-token");
    expect(a.data).not.toBe(b.data);
    expect(a.iv).not.toBe(b.iv);
    expect(a.pub).not.toBe(b.pub); // a fresh ephemeral keypair each time
  });

  test("a tampered ciphertext fails to open instead of yielding something plausible", () => {
    const p = phone();
    const w = sealTo(p.pub, "t", "the-token");
    const bytes = Buffer.from(w.data, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => p.open({ ...w, data: bytes.toString("base64url") }, "t")).toThrow();
  });

  test("the salt is the ticket, so opening it as a different pairing fails", () => {
    const p = phone();
    const w = sealTo(p.pub, "the-real-ticket", "the-token");
    expect(() => p.open(w, "another-ticket")).toThrow();
  });
});
