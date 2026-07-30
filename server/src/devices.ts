import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * A credential per device, instead of one password for the machine.
 *
 * What this replaces: scanning the QR in Settings ▸ Remote access handed the
 * phone `AGENTGLASS_TOKEN` itself — the machine's single shared secret, with
 * no expiry, no identity and no way to take it back from one device. Three
 * things followed from that, and all three are the reason this file exists.
 *
 * *Anyone who saw the screen was paired.* The QR carried the credential, so a
 * photograph of it across a room was a working key. It carries a pairing
 * ticket now (see pairing.ts) and the credential is only ever minted after
 * somebody at the machine accepts.
 *
 * *A lost phone could not be cut off.* One token meant revoking was rotating,
 * and rotating kicked every device including the desk. Each device has its own
 * now, and forgetting one leaves the others alone.
 *
 * *Everything could do everything.* A phone that only ever answers gates had
 * git write, docker control and the terminal, because there was only one level
 * of access and it was "all of it".
 *
 * The token itself is never stored. What is on disk is a SHA-256 of it, so a
 * readable file is not a working key — the same reason a password file holds
 * hashes. It is checked in constant time, because a comparison that returns
 * early leaks the prefix.
 */

export function devicesPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agentglass",
    "devices.json",
  );
}

/**
 * The same rule the settings and push files follow: under `bun test`, only the
 * scratch directory is readable or writable. A suite must never read the
 * developer's real paired devices, and must never overwrite them.
 */
const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

/**
 * What a device is allowed to do.
 *
 * Deliberately coarse. A permission system with twenty verbs is one nobody
 * reads, and the honest split for this application is much simpler: looking at
 * things, answering the thing an agent is stopped on, and changing the
 * repository or the machine.
 *
 * `answer` is its own level because it is the entire reason the companion
 * exists, and because it is *narrow*: it decides a gate the agent is already
 * blocked on, and can start nothing that was not already asked for.
 */
export type Scope = "read" | "answer" | "full";

/** Widest first, so a check can ask "is this at least X". */
const RANK: Record<Scope, number> = { read: 0, answer: 1, full: 2 };
export function scopeAllows(has: Scope, needs: Scope): boolean {
  return RANK[has] >= RANK[needs];
}

export interface Device {
  id: string;
  /** Whatever the phone called itself. Free text, only ever shown back. */
  label: string;
  /** SHA-256 of the credential, hex. The credential itself is never kept. */
  hash: string;
  scope: Scope;
  createdAt: number;
  lastSeenAt?: number;
  /** Set when forgotten. The row is kept so the device list can say a
   *  credential was revoked rather than silently forgetting it existed. */
  revokedAt?: number;
}

interface DeviceFile { devices?: Device[] }

function read(): DeviceFile {
  const p = devicesPath();
  if (offLimits(p) || !existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as DeviceFile;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt file must not take the server down on boot. The cost is that
    // paired devices have to pair again, which is a minute with the phone in
    // your hand — a server that will not start is not.
    return {};
  }
}

function write(f: DeviceFile): boolean {
  const p = devicesPath();
  if (offLimits(p)) return false;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(f, null, 2) + "\n");
    // It holds credential hashes and the shape of who can reach this machine.
    try { chmodSync(p, 0o600); } catch { /* not every fs has modes */ }
    return true;
  } catch {
    return false;
  }
}

export const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

export function devices(): Device[] {
  return read().devices ?? [];
}

/** Only the ones that can still be used. */
export function activeDevices(): Device[] {
  return devices().filter((d) => !d.revokedAt);
}

/**
 * Mint a credential for one device, and hand it back exactly once.
 *
 * The only moment the raw token exists outside the phone that will hold it.
 * Everything stored is derived from it, so it cannot be recovered from this
 * machine later — losing it means pairing again, which is the correct cost.
 */
export function issueDevice(
  label: string, scope: Scope = "answer", now = Date.now(),
): { device: Device; token: string } {
  const token = randomBytes(32).toString("base64url");
  const device: Device = {
    id: randomBytes(8).toString("hex"),
    label: (label || "A device").slice(0, 60),
    hash: hashToken(token),
    scope,
    createdAt: now,
  };
  const f = read();
  write({ ...f, devices: [...(f.devices ?? []), device] });
  return { device, token };
}

/**
 * Which device this credential belongs to, if any.
 *
 * Constant-time over the hashes: a comparison that stops at the first wrong
 * byte tells an attacker how much of a guess was right, which turns an
 * impossible search into a feasible one. Hashing first also means the length
 * being compared is always 64 hex characters, so nothing about the token's own
 * shape leaks either.
 */
export function deviceFor(token: string): Device | null {
  if (!token) return null;
  const want = Buffer.from(hashToken(token), "hex");
  for (const d of devices()) {
    if (d.revokedAt) continue;
    // `Buffer.from(x, "hex")` does not throw on rubbish — it stops at the first
    // byte it cannot read and hands back what it got, so a hand-edited row of
    // "zzzz" arrives here as zero bytes. The length check is what skips it, and
    // it has to happen before the compare either way: `timingSafeEqual` throws
    // on mismatched lengths, which would turn one bad row into a 500 on every
    // authenticated request.
    const has = Buffer.from(d.hash, "hex");
    if (has.length !== want.length) continue;
    if (timingSafeEqual(has, want)) return d;
  }
  return null;
}

/** Note that a device was used, at most once a minute. */
const MARK_EVERY_MS = 60_000;
export function markSeen(id: string, now = Date.now()): void {
  const f = read();
  const d = (f.devices ?? []).find((x) => x.id === id);
  // Every request would otherwise rewrite the file, which on a phone polling
  // four endpoints is a write per second for a field nobody reads that often.
  if (!d || (d.lastSeenAt && now - d.lastSeenAt < MARK_EVERY_MS)) return;
  write({ ...f, devices: (f.devices ?? []).map((x) => (x.id === id ? { ...x, lastSeenAt: now } : x)) });
}

/**
 * Forget one device, and only that one.
 *
 * Kept as a revoked row rather than deleted: "this credential was revoked on
 * Tuesday" is worth being able to see, and a list that silently loses entries
 * cannot be used to answer "did I definitely cut that phone off".
 */
export function revokeDevice(id: string, now = Date.now()): boolean {
  const f = read();
  const found = (f.devices ?? []).some((d) => d.id === id && !d.revokedAt);
  if (!found) return false;
  write({ ...f, devices: (f.devices ?? []).map((d) => (d.id === id ? { ...d, revokedAt: now } : d)) });
  return true;
}

/** Only for tests, which run several servers against one scratch directory. */
export function __resetDevices(): void {
  write({ devices: [] });
}
