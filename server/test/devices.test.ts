/*
 * A credential per device, and what that buys over one password for the machine.
 *
 * Three of these are the reasons the file exists: a stored credential is not a
 * working key, cutting one device off leaves the others alone, and a phone gets
 * what it was granted rather than everything. The fourth is the boring one that
 * makes the rest true — a lookup that does not leak how much of a guess was
 * right.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  issueDevice, deviceFor, devices, activeDevices, revokeDevice, markSeen,
  scopeAllows, hashToken, devicesPath, __resetDevices,
} from "../src/devices.ts";

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-dev-"));
  __resetDevices();
});

describe("what is stored", () => {
  test("the credential is never on disk — only a hash of it", () => {
    const { token } = issueDevice("iPhone", "answer");
    expect(readFileSync(devicesPath(), "utf8")).not.toContain(token);
    expect(devices()[0]!.hash).toBe(hashToken(token));
  });

  test("the file is not readable by anyone else", () => {
    issueDevice("iPhone");
    // It holds credential hashes and the shape of who can reach this machine.
    expect(statSync(devicesPath()).mode & 0o077).toBe(0);
  });

  test("two devices never share a credential", () => {
    const a = issueDevice("iPhone").token;
    const b = issueDevice("iPad").token;
    expect(a).not.toBe(b);
    expect(deviceFor(a)!.label).toBe("iPhone");
    expect(deviceFor(b)!.label).toBe("iPad");
  });

  test("a corrupt file reads as empty rather than taking the server down", () => {
    // Pairing again is a minute with the phone in your hand. A server that
    // will not start is not.
    mkdirSync(dirname(devicesPath()), { recursive: true });
    writeFileSync(devicesPath(), "{ not json");
    expect(devices()).toEqual([]);
    expect(deviceFor("anything")).toBeNull();
  });

  test("a name is kept short and never empty", () => {
    expect(issueDevice("").device.label).toBe("A device");
    expect(issueDevice("x".repeat(400)).device.label).toHaveLength(60);
  });
});

describe("looking a credential up", () => {
  test("the right one resolves, anything else is nobody", () => {
    const { token } = issueDevice("iPhone");
    expect(deviceFor(token)!.label).toBe("iPhone");
    expect(deviceFor("")).toBeNull();
    expect(deviceFor(token + "x")).toBeNull();
    expect(deviceFor(token.slice(0, -1))).toBeNull();
  });

  test("a hash that is not a hash is skipped, not thrown on", () => {
    // Hand-edited files exist, and `timingSafeEqual` throws when the two sides
    // are different lengths — so one bad row without a length check is a 500 on
    // every authenticated request, not a row that quietly does not match.
    const { token } = issueDevice("iPhone");
    const f = JSON.parse(readFileSync(devicesPath(), "utf8"));
    for (const junk of ["zzzz", "", "ab", "f".repeat(200)]) {
      f.devices.unshift({ id: "x" + junk, label: "junk", hash: junk, scope: "full", createdAt: 0 });
    }
    writeFileSync(devicesPath(), JSON.stringify(f));
    expect(deviceFor(token)!.label).toBe("iPhone");
    expect(deviceFor("not the token")).toBeNull();
  });
});

describe("taking one back", () => {
  test("a revoked credential stops working, and only that one", () => {
    const a = issueDevice("iPhone").token;
    const b = issueDevice("iPad").token;
    expect(revokeDevice(deviceFor(a)!.id)).toBe(true);
    expect(deviceFor(a)).toBeNull();
    expect(deviceFor(b)!.label).toBe("iPad"); // the desk keeps working
  });

  test("the row stays, so 'did I definitely cut it off' is answerable", () => {
    const { device } = issueDevice("iPhone");
    revokeDevice(device.id, 5_000);
    expect(activeDevices()).toHaveLength(0);
    expect(devices()).toHaveLength(1);
    expect(devices()[0]!.revokedAt).toBe(5_000);
  });

  test("revoking twice, or something that is not there, is not a success", () => {
    const { device } = issueDevice("iPhone");
    expect(revokeDevice(device.id)).toBe(true);
    expect(revokeDevice(device.id)).toBe(false);
    expect(revokeDevice("never-existed")).toBe(false);
  });
});

describe("last seen", () => {
  test("is recorded, but not on every request", () => {
    // A phone polling four endpoints would otherwise rewrite this file about
    // once a second, for a field nobody reads that often.
    const { device } = issueDevice("iPhone");
    markSeen(device.id, 100_000);
    expect(devices()[0]!.lastSeenAt).toBe(100_000);
    markSeen(device.id, 100_500);
    expect(devices()[0]!.lastSeenAt).toBe(100_000);
    markSeen(device.id, 200_000);
    expect(devices()[0]!.lastSeenAt).toBe(200_000);
  });

  test("an unknown device is not invented by being seen", () => {
    markSeen("nobody", 1);
    expect(devices()).toEqual([]);
  });
});

describe("scope", () => {
  test("is a ladder, widest last", () => {
    expect(scopeAllows("full", "full")).toBe(true);
    expect(scopeAllows("full", "answer")).toBe(true);
    expect(scopeAllows("full", "read")).toBe(true);
    expect(scopeAllows("answer", "answer")).toBe(true);
    expect(scopeAllows("answer", "read")).toBe(true);
    expect(scopeAllows("read", "read")).toBe(true);
  });

  test("and never grants upward — the whole point of having levels", () => {
    expect(scopeAllows("answer", "full")).toBe(false);
    expect(scopeAllows("read", "full")).toBe(false);
    expect(scopeAllows("read", "answer")).toBe(false);
  });

  test("a phone is paired narrow unless somebody widens it", () => {
    expect(issueDevice("iPhone").device.scope).toBe("answer");
  });
});
