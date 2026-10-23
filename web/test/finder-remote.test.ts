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

describe("a pin written another way still finds its mount", () => {
  const bare = mk({ id: "sftp://box.example/", mountPoint: "/run/user/1000/gvfs/sftp:host=box.example", remote: "sftp" });
  test("user@host against host, a port, a trailing slash, the case of the scheme", () => {
    const user = mk({ id: "sftp://acme@box.example/", mountPoint: "/run/user/1000/gvfs/sftp:host=box.example,user=acme", remote: "sftp" });
    for (const pin of ["sftp://box.example", "sftp://box.example:22/", "SFTP://Box.Example/", "ssh://acme@box.example/", "sftp://acme@box.example"]) {
      expect(resolveAddress(pin, [user])).toEqual({ kind: "open", path: user.mountPoint! });
      expect(resolveAddress(pin, [bare])).toEqual({ kind: "open", path: bare.mountPoint! });
    }
    expect(resolveAddress("sftp://other@box.example/", [user])).toEqual({ kind: "connect", uri: "sftp://other@box.example/" });
    expect(resolveAddress("sftp://box.example:2222/", [bare])).toEqual({ kind: "connect", uri: "sftp://box.example:2222/" });
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

// The pinned "Workstation" (sftp://ann@10.0.0.7/home/ann) asked for a new connection, and the desktop app refused it,
// while the same machine was already mounted under DEVICES under a shorter address.
describe("a pinned address whose server is already mounted", () => {
  const MP = "/run/user/1000/gvfs/sftp:host=10.0.0.7";
  const bare = mk({ id: "sftp://10.0.0.7/", mountPoint: MP, remote: "sftp" });
  test("a mount that names no user is the server for an address that does", () => {
    expect(resolveAddress("sftp://ann@10.0.0.7/home/ann", [bare])).toEqual({ kind: "open", path: MP + "/home/ann" });
  });
  test("a mount that names another user is not", () => {
    const bob = mk({ id: "sftp://bob@10.0.0.7/", mountPoint: MP + ",user=bob", remote: "sftp" });
    expect(resolveAddress("sftp://ann@10.0.0.7/home/ann", [bob])).toEqual({ kind: "connect", uri: "sftp://ann@10.0.0.7/home/ann" });
  });
  test("the default port is the same server, another port is not", () => {
    expect(resolveAddress("sftp://10.0.0.7:22/srv", [bare])).toEqual({ kind: "open", path: MP + "/srv" });
    expect(resolveAddress("sftp://10.0.0.7:2222/srv", [bare]).kind).toBe("connect");
  });
  test("ssh:// and a different case are the same address", () => {
    expect(resolveAddress("ssh://ann@10.0.0.7", [bare])).toEqual({ kind: "open", path: MP });
    expect(resolveAddress("SFTP://Ann@10.0.0.7/x", [mk({ id: "sftp://ann@10.0.0.7/", mountPoint: MP, remote: "sftp" })])).toEqual({ kind: "open", path: MP + "/x" });
  });
  test("a mount with no folder of its own cannot be opened, so it is connected", () => {
    expect(resolveAddress("sftp://10.0.0.7/", [mk({ id: "sftp://10.0.0.7/", remote: "sftp" })]).kind).toBe("connect");
  });
});
