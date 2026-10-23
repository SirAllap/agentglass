/*
 * The decisions behind the DEVICES rows: which buttons a volume gets, what a
 * click does, what the prompt says. Strata's rules, asserted without a screen.
 */
import { describe, expect, test } from "bun:test";
import { FAILED, WRONG_PASSPHRASE, credentialWords, fieldLabel, isRejection, clickOf, deviceIcon, disconnectItem, failedTitle, lockButton, releaseButton, stepDialog, volumesChanged } from "../src/lib/finderVolumes.ts";
import type { Volume } from "../../shared/types.ts";

const v = (o: Partial<Volume>): Volume => ({ id: "/dev/sdb1", name: "acme-backup", encrypted: false, locked: false, mounted: false, release: null, size: 1, ...o });

describe("a click on a device row", () => {
  test("opens a mounted volume, mounts an unmounted one, asks the passphrase of a locked one", () => {
    expect(clickOf(v({ mounted: true, mountPoint: "/run/media/ana/x" }))).toBe("open");
    expect(clickOf(v({}))).toBe("mount");
    expect(clickOf(v({ encrypted: true, locked: true }))).toBe("unlock");
  });
});

describe("the buttons at the end of the row", () => {
  test("an encrypted volume has a lock: closed padlock to unlock, open padlock to lock", () => {
    expect(lockButton(v({ encrypted: true, locked: true }))).toEqual({ act: "unlock", icon: "lock", label: "Unlock" });
    expect(lockButton(v({ encrypted: true, mounted: true }))).toEqual({ act: "lock", icon: "lock-open", label: "Lock" });
    expect(lockButton(v({}))).toBeNull();
  });

  test("a removable disk says Eject, a fixed mounted one says Unmount with the same icon, an unmounted fixed one has none", () => {
    expect(releaseButton(v({ release: "eject" }))).toEqual({ act: "eject", icon: "eject", label: "Eject" });
    expect(releaseButton(v({ release: "unmount", mounted: true }))).toEqual({ act: "unmount", icon: "eject", label: "Unmount" });
    expect(releaseButton(v({ release: "unmount" }))).toBeNull();
    expect(releaseButton(v({}))).toBeNull();
  });
});

describe("the words", () => {
  test("every failed action has its Strata title, and the retry line names the passphrase", () => {
    expect(Object.keys(FAILED).sort()).toEqual(["eject", "lock", "mount", "unlock", "unmount"]);
    expect(FAILED.eject).toBe("Unable to eject device");
    expect(WRONG_PASSPHRASE).toContain("passphrase");
  });
  test("the frame reaches every listener and one that throws does not stop the rest", () => { expect(() => volumesChanged()).not.toThrow(); });
});

const smb = v({ id: "smb://files.example.org/share/", name: "share on files.example.org", mounted: true, mountPoint: "/run/user/1000/gvfs/smb-share", release: "unmount", remote: "smb" });
const sftp = v({ id: "sftp://build.example.org/", name: "build", mounted: true, mountPoint: "/run/user/1000/gvfs/sftp", release: "unmount", remote: "sftp" });

describe("a remote's row", () => {
  test("smb wears the network icon and is left through a Disconnect menu, with no button at the end", () => {
    expect(deviceIcon(smb)).toBe("network");
    expect(releaseButton(smb)).toBeNull();
    expect(disconnectItem(smb)).toEqual({ act: "unmount", label: "Disconnect" });
  });
  test("sftp is a device row: hard-drive icon and an Unmount button, no menu", () => {
    expect(deviceIcon(sftp)).toBe("hard-drive");
    expect(releaseButton(sftp)).toEqual({ act: "unmount", icon: "eject", label: "Unmount" });
    expect(disconnectItem(sftp)).toBeNull();
  });
  test("a local volume is a hard drive with neither", () => { expect(deviceIcon(v({}))).toBe("hard-drive"); expect(disconnectItem(v({}))).toBeNull(); });
  test("letting go of a remote fails as 'Unable to disconnect'", () => {
    expect(failedTitle("unmount", smb)).toBe("Unable to disconnect");
    expect(failedTitle("unmount", v({}))).toBe("Unable to unmount device");
  });
});

describe("a step of connecting", () => {
  test("a password step is a form with its fields, a question is buttons with the message untouched", () => {
    expect(stepDialog({ state: "password", session: "s", message: "m", fields: ["User", "Password"], defaults: { User: "ana" } })).toEqual({ kind: "form", title: "Authentication required", fields: ["User", "Password"] });
    expect(stepDialog({ state: "password", session: "s", message: "m", fields: ["Password"], defaults: {} })).toMatchObject({ title: "Authentication required" });
    expect(stepDialog({ state: "question", session: "s", message: "fingerprint SHA256:abc", choices: ["Log In Anyway", "Cancel"] })).toEqual({ kind: "ask", title: "Verify server identity", message: "fingerprint SHA256:abc", choices: ["Log In Anyway", "Cancel"] });
  });
  test("the credential prompt names a passphrase and a username the way Strata does", () => {
    expect(credentialWords("Enter passphrase for key")).toEqual({ title: "Passphrase required", secret: "Passphrase" });
    expect(credentialWords("Enter your credentials for \u201chost\u201d.")).toEqual({ title: "Authentication required", secret: "Password" });
    expect(fieldLabel("User", "Password")).toBe("Username");
    expect(fieldLabel("Password", "Passphrase")).toBe("Passphrase");
  });
  test("a choice that refuses is listed first, as Strata orders them", () => {
    expect(["Log In Anyway", "Cancel"].map(isRejection)).toEqual([false, true]);
    expect(isRejection("Don't trust")).toBe(true);
    expect(isRejection("Notify me")).toBe(false);
  });
  test("a failed connection is Strata's 'Unable to connect', done is nothing to show", () => {
    expect(stepDialog({ state: "error", error: "x" })).toEqual({ kind: "error", title: "Unable to connect", message: "x" });
    expect(stepDialog({ state: "done", uri: "u" })).toBeNull();
  });
});
