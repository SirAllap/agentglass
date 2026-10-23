/*
 * The finder's DEVICES list (what udisks calls volumes, so not devices.ts, which is the paired phones): the volumes udisks knows about, and the five
 * things a person does to one — mount, unmount, eject, unlock, lock.
 *
 * Everything goes through `udisksctl`, the CLI that ships with udisks2, so no
 * new dependency and no D-Bus binding. The list is `udisksctl dump` parsed
 * into a plain shape (parseDump → devicesFromDump, both pure and tested on a
 * fixture), and it is kept fresh by `udisksctl monitor`, which prints a line
 * when anything changes: no timer asks "anything new?".
 *
 * What a device is, after Strata (it asks GIO, which asks the same daemon):
 *   - a filesystem volume that is not a system mount, or
 *   - a LUKS container, shown under the name of what is inside it once it is
 *     open, with a lock button, and as "locked" when it is not.
 * Swap, partitions the desktop is booted from and anything udisks says to
 * ignore are not devices. The ceiling: a volume mounted under a system path is
 * hidden by name (SYSTEM_MOUNTS), not by asking fstab.
 *
 * A passphrase is the one secret here. It is written to the stdin of
 * `udisksctl unlock --key-file /dev/stdin` and nowhere else: not argv, not the
 * environment, not a file, not a log line, and whatever the tool prints back is
 * scrubbed of it before it leaves this module.
 */
import { readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gvfsDir, remotesFromMounts } from "./remotes.ts";
import type { Volume } from "../../shared/types.ts";

type Props = Record<string, string[]>;
type Obj = Record<string, Props>;

/** `udisksctl dump`, as {object path → {interface → {key → values}}}. */
export function parseDump(text: string): Map<string, Obj> {
  const out = new Map<string, Obj>();
  let obj: Obj | null = null, props: Props | null = null, last: string[] | null = null;
  for (const line of text.split("\n")) {
    const o = /^\/org\/freedesktop\/UDisks2\/(.+):$/.exec(line);
    if (o) { obj = {}; out.set(o[1]!, obj); props = null; last = null; continue; }
    const i = /^  (org\.freedesktop\.UDisks2\.[\w.]+):$/.exec(line);
    if (i && obj) { props = obj[i[1]!] = {}; last = null; continue; }
    const k = /^    (\w+):\s*(.*)$/.exec(line);
    if (k && props) { last = props[k[1]!] = k[2] ? [k[2]] : []; continue; }
    if (last && /^ {8,}\S/.test(line)) last.push(line.trim());
  }
  return out;
}

const BLOCK = "org.freedesktop.UDisks2.Block";
const unq = (s: string | undefined) => (s ?? "").replace(/^'(.*)'$/, "$1");
const one = (o: Obj | undefined, iface: string, key: string) => o?.[iface]?.[key]?.[0] ?? "";
const yes = (s: string) => s === "true";

/** Where a volume is mounted when it is the operating system itself, not a device. /var is not here: a data volume is often bind-mounted into /var/lib too (measured on a real dump). */
const SYSTEM_MOUNTS = /^(\/|\/home|\/boot(\/.*)?|\/efi(\/.*)?|\/usr(\/.*)?|\/etc(\/.*)?|\/nix(\/.*)?|\[SWAP\])$/;

export interface VolumeInternal extends Volume {
  /** `/dev/dm-1`: the opened side of a LUKS container, the one that is mounted. */
  cleartext?: string;
  /** The whole disk, for power-off. */
  drive?: string;
  /** The disk's other partitions, as eject must treat them: still mounted names, and whether one is the machine's own. */
  siblings?: { name: string; mounted: boolean; system: boolean }[];
}

export function devicesFromDump(text: string): VolumeInternal[] {
  const objs = parseDump(text);
  const blocks = [...objs].filter(([p, o]) => p.startsWith("block_devices/") && o[BLOCK]);
  const devOf = (objPath: string) => one(objs.get(objPath.replace(/^\/org\/freedesktop\/UDisks2\//, "")), BLOCK, "Device");
  const res: VolumeInternal[] = [];
  for (const [, o] of blocks.sort((a, b) => one(a[1], BLOCK, "Device").localeCompare(one(b[1], BLOCK, "Device")))) {
    if (yes(one(o, BLOCK, "HintIgnore"))) continue;
    if (unq(one(o, BLOCK, "CryptoBackingDevice")) !== "/") continue;
    const dev = one(o, BLOCK, "Device");
    if (!dev) continue;
    const enc = !!o["org.freedesktop.UDisks2.Encrypted"];
    const clearPath = enc ? unq(one(o, "org.freedesktop.UDisks2.Encrypted", "CleartextDevice")) : "";
    const clear = clearPath && clearPath !== "/" ? objs.get(clearPath.replace(/^\/org\/freedesktop\/UDisks2\//, "")) : undefined;
    const fs = enc ? clear : o;
    if (!enc && (one(o, BLOCK, "IdUsage") !== "filesystem" || !o["org.freedesktop.UDisks2.Filesystem"])) continue;
    if (enc && one(o, BLOCK, "IdType") !== "crypto_LUKS") continue;
    const mounts = fs?.["org.freedesktop.UDisks2.Filesystem"]?.["MountPoints"] ?? [];
    if (mounts.some((m) => SYSTEM_MOUNTS.test(m))) continue;
    const mounted = mounts.length > 0;
    if (!enc && !mounted && yes(one(o, BLOCK, "HintSystem"))) continue;
    const size = Number(one(fs ?? o, BLOCK, "Size")) || Number(one(o, BLOCK, "Size")) || 0;
    const drivePath = unq(one(o, BLOCK, "Drive"));
    const drive = drivePath && drivePath !== "/" ? objs.get(drivePath.replace(/^\/org\/freedesktop\/UDisks2\//, "")) : undefined;
    const ejects = yes(one(drive, "org.freedesktop.UDisks2.Drive", "Ejectable")) || yes(one(drive, "org.freedesktop.UDisks2.Drive", "CanPowerOff"));
    const name = one(o, BLOCK, "HintName") || one(fs, BLOCK, "IdLabel") || one(o, BLOCK, "IdLabel")
      || (size ? `${Math.round(size / 1e9)} GB ${enc ? "Encrypted" : "Volume"}` : enc ? "Encrypted volume" : "Volume");
    // The disk the volume sits on, whole: the block of this drive that is not a partition.
    const whole = ejects ? blocks.find(([, b]) => unq(one(b, BLOCK, "Drive")) === drivePath && !b["org.freedesktop.UDisks2.Partition"] && unq(one(b, BLOCK, "CryptoBackingDevice")) === "/") : undefined;
    // What else lives on this disk. A partition hidden above as the machine's own still counts here.
    const siblings = drivePath && drivePath !== "/" ? blocks.filter(([, b]) => unq(one(b, BLOCK, "Drive")) === drivePath && one(b, BLOCK, "Device") !== dev && !!b["org.freedesktop.UDisks2.Partition"] && unq(one(b, BLOCK, "CryptoBackingDevice")) === "/").map(([, b]) => {
      const bClear = b["org.freedesktop.UDisks2.Encrypted"] ? objs.get(unq(one(b, "org.freedesktop.UDisks2.Encrypted", "CleartextDevice")).replace(/^\/org\/freedesktop\/UDisks2\//, "")) : undefined;
      const m = (bClear ?? b)["org.freedesktop.UDisks2.Filesystem"]?.["MountPoints"] ?? [];
      return { name: one(bClear, BLOCK, "IdLabel") || one(b, BLOCK, "IdLabel") || one(b, BLOCK, "Device"), mounted: m.length > 0, system: m.some((x) => SYSTEM_MOUNTS.test(x)) };
    }) : [];
    res.push({
      id: dev, name, encrypted: enc, locked: enc && !clear, mounted,
      ...(mounted ? { mountPoint: mounts[0]! } : {}),
      release: ejects && !siblings.some((x) => x.system) ? "eject" : mounted ? "unmount" : null,
      siblings,
      size,
      ...(clear ? { cleartext: devOf(clearPath) } : {}),
      ...(whole ? { drive: one(whole[1], BLOCK, "Device") } : {}),
    });
  }
  return res;
}

export interface Ran { code: number; out: string; err: string }
export type Run = (argv: string[], stdin?: string) => Promise<Ran>;

/** Resolved with the PATH the process started with (Bun.which), spawned by absolute path. */
export const runTool: Run = async (argv, stdin) => {
  const bin = Bun.which(argv[0]!);
  if (!bin) return { code: 127, out: "", err: `${argv[0]} is not installed` };
  const p = Bun.spawn([bin, ...argv.slice(1)], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

let last: VolumeInternal[] = [];
const strip = ({ cleartext: _c, drive: _d, siblings: _s, ...d }: VolumeInternal): Volume => d;

export async function listDevices(run: Run = runTool): Promise<{ ok: boolean; devices: Volume[]; error?: string }> {
  const [r, g] = await Promise.all([run(["udisksctl", "dump"]), run(["gio", "mount", "-l"])]);
  let entries: string[] = [];
  try { entries = g.code === 0 ? readdirSync(gvfsDir()) : []; } catch { /* no gvfs folder: no remote has a path */ }
  const remotes = g.code === 0 ? remotesFromMounts(g.out, entries, gvfsDir()) : [];
  const local = r.code === 0 ? devicesFromDump(r.out) : [];
  last = [...local, ...remotes];
  if (r.code !== 0 && !remotes.length) return { ok: false, devices: [], error: r.code === 127 ? "udisks is not installed" : "udisks did not answer" };
  return { ok: true, devices: last.map(strip) };
}

/** Where the devices on screen are mounted: the roots the finder may open besides home. Only those udisks last reported. */
export function deviceMountRoots(): string[] {
  return last.flatMap((d) => (d.mountPoint && isAbsolute(d.mountPoint) ? [d.mountPoint] : []));
}
/** Test seam: what the next `deviceMountRoots` should answer. */
export function __setDevices(d: VolumeInternal[]) { last = d; }

export type DeviceAct = "mount" | "unmount" | "eject" | "unlock" | "lock";
export interface Acted { ok: boolean; error?: string; mountPoint?: string }

const fail = (what: string, r: Ran, secret = ""): Acted => {
  let msg = (r.err || r.out).trim().split("\n")[0] ?? "";
  if (secret) msg = msg.split(secret).join("");
  return { ok: false, error: `${what}${msg ? `: ${msg.slice(0, 200)}` : ""}` };
};
const mountedAt = (r: Ran) => /\bat (\/\S.*?)\.?\s*$/m.exec(r.out)?.[1];

/**
 * Do one thing to one device the last listing named. An id that is not on that
 * list is refused whole: this never takes a path from the caller to a tool.
 */
export async function actOnDevice(act: DeviceAct, id: unknown, passphrase: unknown, run: Run = runTool): Promise<Acted> {
  if (typeof id !== "string") return { ok: false, error: "no such device" };
  if (!last.some((d) => d.id === id)) await listDevices(run);
  const d = last.find((x) => x.id === id);
  if (!d) return { ok: false, error: "no such device" };
  if (d.remote) {
    if (act !== "unmount") return { ok: false, error: "a remote can only be disconnected" };
    const r = await run(["gio", "mount", "-u", d.id]);
    return r.code === 0 ? { ok: true } : fail("Unable to disconnect", r);
  }
  const target = d.cleartext ?? d.id;
  const quiet = ["--no-user-interaction"];
  const mount = async (dev: string): Promise<Acted> => {
    const r = await run(["udisksctl", "mount", "-b", dev, ...quiet]);
    return r.code === 0 ? { ok: true, mountPoint: mountedAt(r) } : fail("Unable to mount volume", r);
  };
  if (act === "mount") {
    if (d.locked) return { ok: false, error: "the volume is locked" };
    return mount(target);
  }
  if (act === "unlock") {
    if (!d.encrypted || !d.locked) return { ok: false, error: "the volume is not locked" };
    if (typeof passphrase !== "string" || passphrase === "" || passphrase.length > 1024) return { ok: false, error: "a passphrase is required" };
    const u = await run(["udisksctl", "unlock", "-b", d.id, "--key-file", "/dev/stdin", ...quiet], passphrase);
    if (u.code !== 0) return fail("Unable to unlock volume", u, passphrase);
    const dev = /\bas (\/dev\/\S+?)\.?\s*$/m.exec(u.out)?.[1];
    return dev ? mount(dev) : { ok: true };
  }
  if (act === "lock") {
    if (!d.encrypted || d.locked) return { ok: false, error: "the volume is not unlocked" };
    if (d.mounted) {
      const m = await run(["udisksctl", "unmount", "-b", target, ...quiet]);
      if (m.code !== 0) return fail("Unable to lock device", m);
    }
    const l = await run(["udisksctl", "lock", "-b", d.id, ...quiet]);
    return l.code === 0 ? { ok: true } : fail("Unable to lock device", l);
  }
  if (act === "unmount" || act === "eject") {
    if (act === "eject" && d.release !== "eject") return { ok: false, error: "this device cannot be ejected" };
    if (act === "unmount" && !d.mounted) return { ok: false, error: "the volume is not mounted" };
    const title = act === "eject" ? "Unable to eject device" : "Unable to unmount device";
    // Powering a disk off takes every partition on it: say which are in use instead of trusting udisks to refuse.
    const busy = act === "eject" ? (d.siblings ?? []).filter((x) => x.mounted).map((x) => x.name) : [];
    if (busy.length) return { ok: false, error: `${title}: ${busy.join(", ")} ${busy.length > 1 ? "are" : "is"} still mounted` };
    if (d.mounted) {
      const m = await run(["udisksctl", "unmount", "-b", target, ...quiet]);
      if (m.code !== 0) return fail(title, m);
    }
    if (act === "unmount") return { ok: true };
    if (d.encrypted && d.cleartext) {
      const l = await run(["udisksctl", "lock", "-b", d.id, ...quiet]);
      if (l.code !== 0) return fail(title, l);
    }
    const p = await run(["udisksctl", "power-off", "-b", d.drive ?? d.id, ...quiet]);
    return p.code === 0 ? { ok: true } : fail(title, p);
  }
  return { ok: false, error: "unknown action" };
}

/**
 * `udisksctl monitor` prints a line for every change the daemon announces, so
 * the list is re-read when something happened, never on a clock. `onChange`
 * is called at most once per burst; the caller decides whether the list moved.
 * Exits are restarted with a growing wait, and a missing tool stops it for good.
 */
export function watchDevices(onChange: () => void, spawn = (): Bun.Subprocess<"ignore", "pipe", "ignore"> | null => {
  const bin = Bun.which("udisksctl");
  return bin ? Bun.spawn([bin, "monitor"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }) : null;
}, burstMs = 300): () => void {
  let stopped = false, child: Bun.Subprocess | null = null, timer: ReturnType<typeof setTimeout> | null = null, wait = 1000;
  const bump = () => { if (!timer) timer = setTimeout(() => { timer = null; if (!stopped) onChange(); }, burstMs); };
  const run = async () => {
    const p = spawn();
    if (!p) return;
    child = p;
    const dec = new TextDecoder();
    let seen = false;
    const born = Date.now();
    try {
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        const lines = dec.decode(chunk).split("\n").filter((l) => l.trim() && !/^Monitoring/i.test(l));
        if (lines.length) { seen = true; bump(); }
      }
    } catch { /* the pipe closed under us */ }
    if (stopped) return;
    // A monitor that dies at once is a broken box, not a quiet one: only one that lived a while earns a fast restart.
    wait = Date.now() - born > 5000 ? 1000 : Math.min(wait * 2, 60_000);
    setTimeout(() => { if (!stopped) void run(); }, wait);
  };
  void run();
  return () => { stopped = true; if (timer) clearTimeout(timer); try { child?.kill(); } catch { /* gone */ } };
}

/**
 * Who may do what. Only a request that carries the desktop app's desk key may:
 * not the machine token (every agent shell holds it) and not an Origin header
 * (any page, or any agent shell, can send one), the same line fsroute.ts draws
 * for what cannot be taken back. Mounting, ejecting and locking act on hardware
 * and unlock takes a passphrase, so a caller without the key may read the list
 * and be told why. Unlock is refused first and by name: a passphrase is typed
 * by a person, and one that arrives from an agent was read from somewhere it
 * should not have been.
 */
export function devicePolicy(act: DeviceAct, deskProven: boolean): string | null {
  if (deskProven) return null;
  if (act === "unlock") return "a passphrase is typed by a person in the finder, never sent by an agent";
  return "only the desktop app can mount, eject or lock a device for a person; an agent may read the list and ask them";
}

let watching: (() => void) | null = null;
let shown = "";
/** Start the monitor once, on the first question; `onMoved` hears only changes that alter the list. */
export function ensureDeviceWatch(onMoved: () => void, run: Run = runTool) {
  if (watching) return;
  const moved = () => {
    void listDevices(run).then((r) => {
      const now = JSON.stringify(r.devices);
      if (now !== shown) { shown = now; onMoved(); }
    });
  };
  // Two sources of events, neither a timer: udisks for disks, gio for the mounts GVfs makes.
  const stopUdisks = watchDevices(moved);
  const stopGio = watchDevices(moved, () => { const bin = Bun.which("gio"); return bin ? Bun.spawn([bin, "mount", "-m"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }) : null; });
  watching = () => { stopUdisks(); stopGio(); };
}
export const __stopDeviceWatch = () => { watching?.(); watching = null; shown = ""; };

const MEDIA = [/^\/run\/media\/[^/]+\/.+/, /^\/media\/.+/, /^\/mnt\/.+/];
let prefixOverride: string[] | null = null;
/** Test seam: other folders that count as a place media is mounted. */
export function __setMountPrefixes(p: string[] | null) { prefixOverride = p; }
/**
 * Where a mount may be a root the finder opens: the folders a desktop mounts removable media in, and the gvfs
 * folder. Not whatever udisks says — a data volume bind-mounted at /var/lib or an /opt or /srv partition would
 * otherwise open its whole tree. A mount inside home needs no door: home is already open, dotted entries aside.
 */
export function mountRootOk(root: string, gvfs: string): boolean {
  if (!isAbsolute(root) || root.split("/").includes("..")) return false;
  if (prefixOverride) return prefixOverride.some((p) => root.startsWith(p) && root.length > p.length);
  return MEDIA.some((re) => re.test(root)) || root.startsWith(gvfs + "/");
}

/** May the finder open this resolved path because a device the list shows as mounted is there? Not dotted entries, not for a remote viewer (the caller passes `local`). */
export function mountAllows(real: string): boolean {
  const gvfs = gvfsDir();
  return deviceMountRoots().some((root) => {
    if (!mountRootOk(root, gvfs)) return false;
    const rel = real === root ? "" : real.startsWith(root + "/") ? real.slice(root.length + 1) : null;
    return rel !== null && !rel.split("/").some((x) => x.startsWith("."));
  });
}
