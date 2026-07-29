import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { generateVapidKeys, type PushSubscription, type VapidKeys } from "./push.ts";

/**
 * Where a device's push subscription lives, and the key this server signs with.
 *
 * Its own file rather than config.json, for two reasons. It holds a private
 * key, so it wants 0600 and a config people paste into issues does not. And a
 * subscription is machine state, not a setting — nobody edits one by hand, and
 * losing it should cost a re-subscribe rather than a lost preference.
 *
 * Not the events database either, which is retention-scoped: subscriptions
 * would silently evaporate after eight days and the only symptom would be a
 * phone that quietly stopped buzzing.
 */

export function pushPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agentglass",
    "push.json",
  );
}

/**
 * The same rule the settings file follows: under `bun test`, only the scratch
 * directory is readable or writable. A suite must never read the developer's
 * real subscriptions, and must never overwrite them with fixtures.
 */
const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

/** A subscription, plus what this machine knows about the device it came from. */
export interface StoredSubscription extends PushSubscription {
  /** Whatever the phone called itself. Free text, only ever shown back. */
  label?: string;
  addedAt: number;
  /** When a push to it last succeeded, so a dead one can be recognised. */
  lastOkAt?: number;
}

interface PushFile {
  vapid?: VapidKeys;
  subs?: StoredSubscription[];
}

function read(): PushFile {
  const p = pushPath();
  if (offLimits(p) || !existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as PushFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupt file must not take the server down on boot. The cost of being
    // wrong is a re-subscribe, which is one tap.
    return {};
  }
}

function write(f: PushFile): boolean {
  const p = pushPath();
  if (offLimits(p)) return false;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(f, null, 2) + "\n");
    // It contains a signing key. Best effort: some filesystems will not.
    try { chmodSync(p, 0o600); } catch { /* not every fs has modes */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * This server's VAPID identity, generated once and kept.
 *
 * It has to be stable: a browser pins a subscription to the key that created
 * it, so regenerating invalidates every subscription on every phone at once —
 * and the failure is silent, because the push service simply stops accepting
 * the token. Generating on every boot would look fine in every test and buzz
 * nobody.
 */
let memo: VapidKeys | null = null;
export async function vapidKeys(): Promise<VapidKeys> {
  if (memo) return memo;
  const f = read();
  if (f.vapid?.publicKey && f.vapid?.privateKey) { memo = f.vapid; return memo; }
  const fresh = await generateVapidKeys();
  write({ ...f, vapid: fresh });
  memo = fresh;
  return fresh;
}

/** Only for tests, which run several servers in one process. */
export function forgetVapid(): void { memo = null; }

export function subscriptions(): StoredSubscription[] {
  return read().subs ?? [];
}

/**
 * Remember a device, or update what is known about it.
 *
 * The endpoint is the identity. A browser hands back the same endpoint for the
 * same subscription, and a *new* one when the user clears site data or the push
 * service rotates it — so matching on endpoint is what stops one phone becoming
 * four entries and getting four buzzes for one gate.
 */
export function addSubscription(sub: PushSubscription, label?: string, now = Date.now()): StoredSubscription[] {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return subscriptions();
  const f = read();
  const subs = (f.subs ?? []).filter((s) => s.endpoint !== sub.endpoint);
  subs.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ...(label ? { label } : {}),
    addedAt: now,
  });
  write({ ...f, subs });
  return subs;
}

export function removeSubscription(endpoint: string): StoredSubscription[] {
  const f = read();
  const subs = (f.subs ?? []).filter((s) => s.endpoint !== endpoint);
  write({ ...f, subs });
  return subs;
}

export function markDelivered(endpoint: string, now = Date.now()): void {
  const f = read();
  const subs = (f.subs ?? []).map((s) => (s.endpoint === endpoint ? { ...s, lastOkAt: now } : s));
  write({ ...f, subs });
}
