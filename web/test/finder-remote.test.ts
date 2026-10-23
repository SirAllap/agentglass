/*
 * The path bar's two translations for a remote: the address shown for a folder
 * of a mounted share, and what typing an address does.
 */
import { describe, expect, test } from "bun:test";
import { isRemoteAddress, remoteView, resolveAddress } from "../src/lib/finderRemote.ts";
import type { Volume } from "../../shared/types.ts";

const mk = (o: Partial<Volume>): Volume => ({ id: "x", name: "n", encrypted: false, locked: false, mounted: true, release: "unmount", size: 0, ...o });
const sftp = mk({ id: "sftp://ana@build.example.org/", mountPoint: "/run/user/1000/gvfs/sftp:host=build.example.org,user=ana", remote: "sftp" });
const smb = mk({ id: "smb://files.example.org/share/", mountPoint: "/run/user/1000/gvfs/smb-share:server=files.example.org,share=share", remote: "smb" });
const local = mk({ id: "/dev/sdb1", mountPoint: "/run/media/ana/PLAIN" });
const all = [local, sftp, smb];

describe("an address", () => {
  test("smb, sftp and ssh are servers; a folder and other schemes are not", () => {
    for (const t of ["smb://h/s", "SFTP://h/", "ssh://h"]) expect(isRemoteAddress(t)).toBe(true);
    for (const t of ["/home/ana", "http://h", "smb://", "~"]) expect(isRemoteAddress(t)).toBe(false);
  });
});

describe("a folder of a mounted remote is shown as its address", () => {
  test("the mount itself and a folder below it", () => {
    expect(remoteView(sftp.mountPoint!, all)).toMatchObject({ uri: "sftp://ana@build.example.org", root: "sftp://ana@build.example.org" });
    expect(remoteView(smb.mountPoint! + "/docs/2024", all)).toMatchObject({ uri: "smb://files.example.org/share/docs/2024", mountPoint: smb.mountPoint });
  });
  test("a local volume, a sibling spelling and an unmounted prefix are not remotes", () => {
    expect(remoteView("/run/media/ana/PLAIN/x", all)).toBeNull();
    expect(remoteView(sftp.mountPoint! + "-other", all)).toBeNull();
    expect(remoteView("/home/ana", all)).toBeNull();
  });
});

describe("typing an address", () => {
  test("inside a mount that exists it opens the folder, without a new connection", () => {
    expect(resolveAddress("sftp://ana@build.example.org/deploy/", all)).toEqual({ kind: "open", path: sftp.mountPoint! + "/deploy" });
    expect(resolveAddress("SMB://files.example.org/share", all)).toEqual({ kind: "open", path: smb.mountPoint! });
  });
  test("a server that is not mounted starts a connection, and ssh is sftp", () => {
    expect(resolveAddress("sftp://other.example.org/", all)).toEqual({ kind: "connect", uri: "sftp://other.example.org/" });
    expect(resolveAddress("ssh://other.example.org/", all)).toEqual({ kind: "connect", uri: "sftp://other.example.org/" });
  });
  test("another share on a server that has one mounted is still a new connection", () => {
    expect(resolveAddress("smb://files.example.org/other", all)).toEqual({ kind: "connect", uri: "smb://files.example.org/other" });
  });
});
