import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The file that holds a token.
 *
 * Everything here is about the two ways a secret escapes: the wrong mode on
 * disk, and a helper that returns it to something which serialises. Both are
 * one-line mistakes and neither shows up as a failure anywhere else — a token
 * in a JSON response is indistinguishable from a working feature.
 *
 * Its own directory, always. A suite that read the developer's real
 * credentials would pass, which is the failure this fixture removes.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-cred-"));
const file = join(dir, "credentials.json");
const C = await import("../src/credentials.ts");

beforeEach(() => { C.__setCredentialsPath(file); C.__clearAll(); });
afterAll(() => { C.__setCredentialsPath(null); try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

describe("what lands on disk", () => {
  it("writes the file readable by nobody else", () => {
    C.setCredential("clickup", { token: "pk_12345_SECRETVALUE" });
    // 0600. The check is the low nine bits, so it fails the same way whether
    // the group or the world was let in.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("fixes the mode of a file that already existed too open", () => {
    // The interesting case: `writeFileSync(..., { mode })` does nothing to an
    // existing file, so creating with the right mode is not enough. This is
    // the same reason auth.ts chmods after writing.
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o644);
    C.__setCredentialsPath(file);
    C.setCredential("clickup", { token: "pk_12345_SECRETVALUE" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the file — and its mode — when the last credential is removed", () => {
    // Deleting it would hand the next write's permissions to whatever umask
    // happens to be in force.
    C.setCredential("clickup", { token: "pk_1_X" });
    C.clearCredential("clickup");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(C.hasCredential("clickup")).toBe(false);
  });
});

describe("what a route may see", () => {
  it("never returns the secret from the redacted view", () => {
    C.setCredential("clickup", { token: "pk_12345_SECRETVALUE", account: "Ada", workspace: "Acme" });
    const r = C.redacted("clickup")!;
    expect(r.account).toBe("Ada");
    expect(r.workspace).toBe("Acme");
    expect(r.present).toBe(true);
    // Belt and braces: not under `token`, and not anywhere else either.
    expect((r as Record<string, unknown>).token).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("SECRETVALUE");
  });

  it("hands the secret only to the caller that asks for it by name", () => {
    C.setCredential("clickup", { token: "pk_12345_SECRETVALUE" });
    expect(C.secretFor("clickup")).toBe("pk_12345_SECRETVALUE");
    expect(C.secretFor("github")).toBe(null);
  });

  it("says nothing at all about a provider that was never connected", () => {
    expect(C.redacted("clickup")).toBe(null);
    expect(C.hasCredential("clickup")).toBe(false);
  });
});

describe("what may be printed", () => {
  it("fingerprints by prefix and length, never the tail", () => {
    // The tail is the part worth stealing. A prefix plus a length tells two
    // tokens apart and is useless to whoever finds it in a log.
    const fp = C.fingerprint("pk_12345_SECRETVALUE");
    expect(fp).toContain("pk_");
    expect(fp).not.toContain("SECRETVALUE");
    expect(fp).not.toContain("VALUE");
    expect(fp).toContain("20");
    expect(C.fingerprint("")).toBe("(none)");
  });
});

describe("keeping notes without touching the secret", () => {
  it("annotates an existing credential and leaves the token alone", () => {
    C.setCredential("clickup", { token: "pk_12345_SECRETVALUE" });
    C.annotate("clickup", { account: "Ada", workspace: "Acme", verifiedAt: 1 });
    expect(C.secretFor("clickup")).toBe("pk_12345_SECRETVALUE");
    expect(C.redacted("clickup")!.workspace).toBe("Acme");
  });

  it("does not invent a credential for a provider that has none", () => {
    C.annotate("clickup", { account: "Nobody" });
    expect(C.hasCredential("clickup")).toBe(false);
  });
});

describe("a store that got damaged", () => {
  it("starts empty rather than refusing to boot", () => {
    // The app has to start. The fix for a corrupt file is to connect again,
    // which overwrites it.
    writeFileSync(file, "{ this is not json");
    C.__setCredentialsPath(file);
    expect(C.hasCredential("clickup")).toBe(false);
    C.setCredential("clickup", { token: "pk_1_X" });
    expect(JSON.parse(readFileSync(file, "utf8")).clickup.token).toBe("pk_1_X");
  });
});
