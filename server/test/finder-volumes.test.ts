/*
 * The finder's DEVICES list and what is done to a device. Nothing here runs a
 * real udisksctl: the list is parsed from a fixture shaped like a real dump
 * (invented labels), and the actions are asserted through a fake `Run` that
 * records every argv and every stdin it was given.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __setDevices, actOnDevice, deviceMountRoots, devicesFromDump, listDevices, parseDump, watchDevices, type Run } from "../src/volumes.ts";

const blk = (name: string, o: { dev: string; drive?: string; crypt?: string; hintIgnore?: boolean; hintSystem?: boolean; label?: string; type?: string; usage?: string; size?: number; extra?: string }) => `
/org/freedesktop/UDisks2/block_devices/${name}:
  org.freedesktop.UDisks2.Block:
    CryptoBackingDevice:        '${o.crypt ?? "/"}'
    Device:                     ${o.dev}
    Drive:                      '${o.drive ?? "/"}'
    HintIgnore:                 ${!!o.hintIgnore}
    HintName:                   
    HintSystem:                 ${!!o.hintSystem}
    IdLabel:                    ${o.label ?? ""}
    IdType:                     ${o.type ?? ""}
    IdUsage:                    ${o.usage ?? ""}
    Size:                       ${o.size ?? 0}
${o.extra ?? ""}`;
const fsMounts = (...m: string[]) => `  org.freedesktop.UDisks2.Filesystem:\n    MountPoints:        ${m[0] ?? ""}\n${m.slice(1).map((x) => " ".repeat(24) + x + "\n").join("")}`;
const drive = (id: string, o: { eject?: boolean; off?: boolean } = {}) => `
/org/freedesktop/UDisks2/drives/${id}:
  org.freedesktop.UDisks2.Drive:
    CanPowerOff:                ${!!o.off}
    Ejectable:                  ${!!o.eject}
    Model:                      ${id}
`;
const D = "/org/freedesktop/UDisks2/block_devices/";
const FIXTURE = [
  // the machine's own disk: root is a LUKS volume, mounted at "/"; none of it is a device
  blk("nvme0n1p4", { dev: "/dev/nvme0n1p4", drive: "/org/freedesktop/UDisks2/drives/Disk1", type: "crypto_LUKS", usage: "crypto", hintSystem: true, extra: `  org.freedesktop.UDisks2.Encrypted:\n    CleartextDevice:            '${D}dm_0'\n` }),
  blk("dm_0", { dev: "/dev/dm-0", crypt: `${D}nvme0n1p4`, label: "ROOT", type: "btrfs", usage: "filesystem", hintSystem: true, extra: fsMounts("/", "/home", "/var/log") }),
  blk("nvme0n1p3", { dev: "/dev/nvme0n1p3", hintIgnore: true, type: "vfat", usage: "filesystem", extra: fsMounts("/boot") }),
  blk("zram0", { dev: "/dev/zram0", hintIgnore: true, type: "swap", usage: "other" }),
  // an internal LUKS volume, open and mounted under home: a device, with a lock and an unmount
  blk("nvme0n1p1", { dev: "/dev/nvme0n1p1", drive: "/org/freedesktop/UDisks2/drives/Disk1", label: "ORBIT", type: "crypto_LUKS", usage: "crypto", hintSystem: true, size: 258e9, extra: `  org.freedesktop.UDisks2.Encrypted:\n    CleartextDevice:            '${D}dm_1'\n` }),
  blk("dm_1", { dev: "/dev/dm-1", crypt: `${D}nvme0n1p1`, label: "orbit-vault", type: "btrfs", usage: "filesystem", hintSystem: true, size: 258e9, extra: fsMounts("/home/ana/orbit-vault", "/var/lib/docker") }),
  // a USB stick with a LUKS volume, closed
  blk("sdb1", { dev: "/dev/sdb1", drive: "/org/freedesktop/UDisks2/drives/Stick", label: "acme-backup", type: "crypto_LUKS", usage: "crypto", size: 64e9, extra: `  org.freedesktop.UDisks2.Encrypted:\n    CleartextDevice:            '/'\n` }),
  blk("sdb", { dev: "/dev/sdb", drive: "/org/freedesktop/UDisks2/drives/Stick", extra: "  org.freedesktop.UDisks2.PartitionTable:\n" }),
  // a plain stick, not mounted yet
  blk("sdc1", { dev: "/dev/sdc1", drive: "/org/freedesktop/UDisks2/drives/Plain", label: "PLAIN", type: "vfat", usage: "filesystem", size: 16e9, extra: fsMounts() + "  org.freedesktop.UDisks2.Partition:\n" }),
  blk("sdc", { dev: "/dev/sdc", drive: "/org/freedesktop/UDisks2/drives/Plain" }),
  drive("Disk1"), drive("Stick", { eject: true, off: true }), drive("Plain", { eject: true }),
].join("");

afterEach(() => __setDevices([]));

describe("the list", () => {
  test("parses objects, interfaces and the values that continue on the next line", () => {
    const m = parseDump(FIXTURE);
    expect(m.get("block_devices/dm_0")!["org.freedesktop.UDisks2.Filesystem"]!["MountPoints"]).toEqual(["/", "/home", "/var/log"]);
    expect(m.get("drives/Stick")!["org.freedesktop.UDisks2.Drive"]!["Ejectable"]).toEqual(["true"]);
  });

  test("shows volumes and LUKS containers, and hides the machine's own disk, swap and what udisks ignores", () => {
    const d = devicesFromDump(FIXTURE);
    expect(d.map((x) => x.name)).toEqual(["orbit-vault", "acme-backup", "PLAIN"]);
  });

  test("an open container carries the name of what is inside, a lock, and unmount when the disk cannot be ejected", () => {
    const v = devicesFromDump(FIXTURE).find((x) => x.name === "orbit-vault")!;
    expect(v).toMatchObject({ id: "/dev/nvme0n1p1", encrypted: true, locked: false, mounted: true, mountPoint: "/home/ana/orbit-vault", release: "unmount", cleartext: "/dev/dm-1" });
  });

  test("a closed container is locked, not mounted, and ejects its whole disk", () => {
    const v = devicesFromDump(FIXTURE).find((x) => x.name === "acme-backup")!;
    expect(v).toMatchObject({ id: "/dev/sdb1", encrypted: true, locked: true, mounted: false, release: "eject", drive: "/dev/sdb" });
  });

  test("a plain removable volume can be mounted and ejected, and has no lock", () => {
    const v = devicesFromDump(FIXTURE).find((x) => x.name === "PLAIN")!;
    expect(v).toMatchObject({ encrypted: false, locked: false, mounted: false, release: "eject" });
  });

  test("a list udisks cannot give is an error the sidebar can say, never a throw", async () => {
    const r = await listDevices(async () => ({ code: 127, out: "", err: "" }));
    expect(r).toEqual({ ok: false, devices: [], error: "udisks is not installed" });
  });

  test("what is mounted is where the finder may look besides home, and only that", async () => {
    await listDevices(async () => ({ code: 0, out: FIXTURE, err: "" }));
    expect(deviceMountRoots()).toEqual(["/home/ana/orbit-vault"]);
  });
});

const calls: { argv: string[]; stdin?: string }[] = [];
const fake = (answer: (argv: string[]) => Partial<{ code: number; out: string; err: string }> = () => ({})): Run => async (argv, stdin) => {
  if (argv[0] === "gio" && argv[1] === "mount" && argv[2] === "-l") return { code: 127, out: "", err: "" };
  calls.push({ argv, stdin });
  if (argv[1] === "dump") return { code: 0, out: FIXTURE, err: "" };
  return { code: 0, out: "", err: "", ...answer(argv) };
};

describe("what is done to a device", () => {
  afterEach(() => { calls.length = 0; });

  test("a device the last listing did not name is refused before any tool runs", async () => {
    const r = await actOnDevice("mount", "/dev/sda1", undefined, fake());
    expect(r).toEqual({ ok: false, error: "no such device" });
    expect(calls.filter((c) => c.argv[1] !== "dump")).toEqual([]);
  });

  test("the passphrase goes to stdin and nowhere else, then the opened volume is mounted", async () => {
    const secret = "correct horse battery";
    const r = await actOnDevice("unlock", "/dev/sdb1", secret, fake((a) => a[1] === "unlock" ? { out: "Unlocked /dev/sdb1 as /dev/dm-3.\n" } : a[1] === "mount" ? { out: "Mounted /dev/dm-3 at /run/media/ana/acme-backup.\n" } : {})) ;
    expect(r).toEqual({ ok: true, mountPoint: "/run/media/ana/acme-backup" });
    const unlock = calls.find((c) => c.argv[1] === "unlock")!;
    expect(unlock.stdin).toBe(secret);
    expect(unlock.argv).toEqual(["udisksctl", "unlock", "-b", "/dev/sdb1", "--key-file", "/dev/stdin", "--no-user-interaction"]);
    expect(JSON.stringify(calls.map((c) => c.argv))).not.toContain(secret);
    expect(calls.find((c) => c.argv[1] === "mount")!.argv).toContain("/dev/dm-3");
  });

  test("a wrong passphrase says so without echoing it, even when the tool does", async () => {
    const secret = "hunter2-hunter2";
    const r = await actOnDevice("unlock", "/dev/sdb1", secret, fake(() => ({ code: 1, err: `Error unlocking /dev/sdb1: bad option ${secret}` })));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.error).toContain("Unable to unlock volume");
  });

  test("unlock needs a passphrase and a locked volume", async () => {
    expect((await actOnDevice("unlock", "/dev/sdb1", "", fake())).error).toBe("a passphrase is required");
    expect((await actOnDevice("unlock", "/dev/nvme0n1p1", "x", fake())).error).toBe("the volume is not locked");
    expect(calls.some((c) => c.argv[1] === "unlock")).toBe(false);
  });

  test("lock unmounts what is open, then locks the container", async () => {
    const r = await actOnDevice("lock", "/dev/nvme0n1p1", undefined, fake());
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.argv[1] !== "dump").map((c) => c.argv.slice(1, 4).join(" "))).toEqual(["unmount -b /dev/dm-1", "lock -b /dev/nvme0n1p1"]);
  });

  test("eject of an open removable container: unmount, lock, then power the disk off", async () => {
    __setDevices(devicesFromDump(FIXTURE.replace("CleartextDevice:            '/'", `CleartextDevice:            '${D}dm_1'`)));
    const r = await actOnDevice("eject", "/dev/sdb1", undefined, fake());
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.argv[1])).toEqual(["unmount", "lock", "power-off"]);
    expect(calls.at(-1)!.argv).toContain("/dev/sdb");
  });

  test("eject is refused for a disk that is not removable, and unmount for a volume that is not mounted", async () => {
    expect((await actOnDevice("eject", "/dev/nvme0n1p1", undefined, fake())).error).toBe("this device cannot be ejected");
    expect((await actOnDevice("unmount", "/dev/sdc1", undefined, fake())).error).toBe("the volume is not mounted");
  });

  test("a tool that fails is reported with the title Strata uses, and does not go on to the next step", async () => {
    const r = await actOnDevice("eject", "/dev/sdc1", undefined, fake((a) => a[1] === "power-off" ? { code: 1, err: "busy" } : {}));
    expect(r).toEqual({ ok: false, error: "Unable to eject device: busy" });
  });
});

describe("the events", () => {
  test("a burst of lines is one change, the header is none, and stopping stops it", async () => {
    let n = 0;
    const enc = new TextEncoder();
    let push!: (s: string) => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } });
    const stop = watchDevices(() => { n++; }, () => ({ stdout: body, kill() {} }) as never, 20);
    push("Monitoring the udisks daemon. Press Ctrl+C to exit.\n");
    await Bun.sleep(60);
    expect(n).toBe(0);
    push("12:00:00.001: /org/freedesktop/UDisks2/block_devices/sdb1: org.freedesktop.UDisks2.Block: Properties Changed\n");
    push("12:00:00.002: /org/freedesktop/UDisks2/block_devices/sdb1: org.freedesktop.UDisks2.Filesystem: Properties Changed\n");
    await Bun.sleep(80);
    expect(n).toBe(1);
    stop();
  });
});

describe("browsing a mounted device", () => {
  test("only the places a desktop mounts removable media, and the gvfs folder, can be roots", () => {
    const { mountRootOk } = require("../src/volumes.ts") as typeof import("../src/volumes.ts");
    for (const ok of ["/run/media/ana/PLAIN", "/media/PLAIN", "/mnt/usb", "/run/user/1000/gvfs/sftp:host=h"]) expect(mountRootOk(ok, "/run/user/1000/gvfs")).toBe(true);
    for (const no of ["/var/lib/docker", "/opt/data", "/srv/www", "/root", "/home/ana/orbit-vault", "/etc", "/", "/run/media", "/mnt", "/run/user/1000/gvfs", "/run/media/ana/../../../etc"]) expect(mountRootOk(no, "/run/user/1000/gvfs")).toBe(false);
  });

  test("a path under a mounted device opens for a local caller, never dotted, never for a remote one, never outside it", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { browseAllows } = await import("../src/browse.ts");
    const { __setMountPrefixes } = await import("../src/volumes.ts");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-dev-")));
    try {
      mkdirSync(join(dir, "docs")); mkdirSync(join(dir, ".trash")); writeFileSync(join(dir, "docs", "a.txt"), "x");
      __setDevices([{ id: "/dev/sdc1", name: "PLAIN", encrypted: false, locked: false, mounted: true, mountPoint: dir, release: "eject", size: 1 }]);
      // The temp folder is not a place media is mounted, so udisks saying so is not enough.
      expect(browseAllows(join(dir, "docs"), true)).toBe(false);
      __setMountPrefixes([tmpdir() + "/"]);
      expect(browseAllows(join(dir, "docs"), true)).toBe(true);
      expect(browseAllows(dir, true)).toBe(true);
      expect(browseAllows(join(dir, ".trash"), true)).toBe(false);
      expect(browseAllows(join(dir, "docs"), false)).toBe(false);
      expect(browseAllows(dir + "-sibling", true)).toBe(false);
      expect(browseAllows("/etc", true)).toBe(false);
    } finally { __setMountPrefixes(null); __setDevices([]); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("who may act", () => {
  const { devicePolicy } = require("../src/volumes.ts") as typeof import("../src/volumes.ts");
  test("the desktop app, holding the desk key, may do all five", () => { for (const a of ["mount", "unmount", "eject", "unlock", "lock"] as const) expect(devicePolicy(a, true)).toBeNull(); });
  test("anyone else, an Origin header included, may do none, and unlock says why in its own words", () => {
    for (const a of ["mount", "unmount", "eject", "lock"] as const) expect(devicePolicy(a, false)).toContain("only the desktop app");
    expect(devicePolicy("unlock", false)).toContain("never sent by an agent");
  });
});

describe("eject and the disk's other partitions", () => {
  // One disk, two partitions: the stick's data volume and a second one that is mounted.
  const two = FIXTURE + blk("sdc2", { dev: "/dev/sdc2", drive: "/org/freedesktop/UDisks2/drives/Plain", label: "other-part", type: "ext4", usage: "filesystem", size: 8e9, extra: fsMounts("/run/media/ana/other-part") + "  org.freedesktop.UDisks2.Partition:\n" });
  test("a sibling that is mounted blocks eject, and the error names it", async () => {
    __setDevices(devicesFromDump(two));
    const r = await actOnDevice("eject", "/dev/sdc1", undefined, fake());
    expect(r).toEqual({ ok: false, error: "Unable to eject device: other-part is still mounted" });
    expect(calls.filter((c) => c.argv[1] !== "dump")).toEqual([]);
  });
  test("a sibling that is the machine's own makes the disk unmountable but never ejectable", () => {
    const sys = two.replace("/run/media/ana/other-part", "/boot");
    expect(devicesFromDump(sys).find((d) => d.id === "/dev/sdc1")!.release).toBeNull();
  });
  test("with the siblings unmounted eject goes on to power off", async () => {
    __setDevices(devicesFromDump(two.replace("/run/media/ana/other-part", "")));
    const r = await actOnDevice("eject", "/dev/sdc1", undefined, fake());
    expect(r.ok).toBe(true);
    expect(calls.at(-1)!.argv[1]).toBe("power-off");
  });
});
